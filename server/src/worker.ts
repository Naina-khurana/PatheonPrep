import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { config } from "./config.js";
import { LIMITS } from "./contract.js";
import { PipelineError } from "./errors.js";
import { analyzeTranscript } from "./pipeline/analyze.js";
import { CommandError } from "./pipeline/exec.js";
import { StageNotImplementedError, type TranscriptionHandoff } from "./pipeline/handoff.js";
import { downloadAudio, inspectLink } from "./pipeline/link.js";
import { extractMp3, probe } from "./pipeline/media.js";
import { transcribeAudio } from "./pipeline/transcribe.js";
import { validateFeedback } from "./pipeline/validateFeedback.js";
import { store, type ReviewRecord } from "./store.js";

/** What the routes need from a worker. Tests pass a no-op. */
export interface ReviewWorker {
  enqueue(reviewId: string): void;
  isRunning(reviewId: string): boolean;
}

const minutes = (s: number) => Math.max(1, Math.round(s / 60));
const tooLong = (s: number) =>
  new PipelineError(`That video is about ${minutes(s)} minutes long. The limit is ${LIMITS.maxDurationSeconds / 60} minutes.`, "TOO_LONG");

/**
 * An in-process queue. Each run owns its review through `runId`, so a review
 * deleted or re-queued mid-run is never overwritten by a stale result, and
 * running the same review twice in a row is safe.
 */
export class Worker implements ReviewWorker {
  private queue: string[] = [];
  private running = new Set<string>();
  private active = 0;

  constructor(private concurrency = 2) {}

  enqueue(reviewId: string) {
    if (this.isRunning(reviewId)) return;
    this.queue.push(reviewId);
    this.pump();
  }

  isRunning(reviewId: string) {
    return this.running.has(reviewId) || this.queue.includes(reviewId);
  }

  /** Picks up reviews a previous process left QUEUED or PROCESSING. */
  resume() {
    for (const r of store.listReviews()) {
      if (r.status === "QUEUED" || r.status === "PROCESSING") {
        store.putReview({ ...r, status: "QUEUED", stage: "Waiting", progress: undefined, runId: undefined });
        this.enqueue(r.id);
      }
    }
  }

  private pump() {
    while (this.active < this.concurrency && this.queue.length) {
      const id = this.queue.shift()!;
      this.active++;
      this.running.add(id);
      void this.process(id).finally(() => {
        this.running.delete(id);
        this.active--;
        this.pump();
      });
    }
  }

  private async process(id: string) {
    const initial = store.getReview(id);
    if (!initial) return;
    const runId = randomUUID();
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(new PipelineError("Processing took too long. Try again.", "TIMEOUT")), config.jobTimeoutMs);
    const opts = { signal: ac.signal };

    /** Applies a change only while this run still owns the review. */
    const patch = (p: Partial<ReviewRecord>): boolean => {
      const cur = store.getReview(id);
      if (!cur || cur.runId !== runId) return false;
      store.putReview({ ...cur, ...p });
      return true;
    };
    const stage = (label: string, progress: number) => {
      if (!patch({ stage: label, progress: Math.min(1, Math.max(0, progress)) })) {
        ac.abort(new PipelineError("This review was removed.", "GONE"));
        throw ac.signal.reason;
      }
    };

    store.putReview({ ...initial, status: "PROCESSING", stage: "Starting", progress: 0, error: undefined, feedback: undefined, runId });
    const workDir = store.workDir(id);
    console.log(`[worker] review ${id}: start (${initial.sourceKind})`);

    try {
      await fs.rm(workDir, { recursive: true, force: true });
      await fs.mkdir(workDir, { recursive: true });
      const review = store.getReview(id)!;

      // 1. Get the audio as a small mono MP3. Kept across retries.
      const mp3 = store.audioPath(id);
      if (!existsSync(mp3)) {
        let source: string;
        if (review.source.kind === "link") {
          stage("Checking the link", 0.05);
          const info = await inspectLink(review.source.url, opts);
          if (info.isLive) throw new PipelineError("That's a live stream. Link to the recording once it has ended.", "LINK_LIVE");
          if (info.durationSeconds && info.durationSeconds > LIMITS.maxDurationSeconds) throw tooLong(info.durationSeconds);
          stage("Fetching the video", 0.1);
          source = await downloadAudio(review.source.url, workDir, opts);
        } else {
          source = store.mediaPath(review.source.fileKey);
          if (!existsSync(source)) throw new PipelineError("The uploaded file is missing. Upload it again.", "FILE_MISSING");
        }
        stage("Extracting audio", 0.25);
        const info = await probe(source, opts);
        if (!info.hasAudio) throw new PipelineError("That file has no audio track.", "NO_AUDIO");
        if (info.durationSeconds > LIMITS.maxDurationSeconds) throw tooLong(info.durationSeconds);
        if (info.durationSeconds > 0) patch({ durationSeconds: info.durationSeconds });
        const tmp = path.join(workDir, "audio.mp3");
        await extractMp3(source, tmp, opts);
        await fs.rename(tmp, mp3);
      }

      // 2. Transcribe.
      stage("Transcribing audio", 0.4);
      const t = await transcribeAudio(mp3, {
        format: review.format,
        workDir,
        signal: ac.signal,
        onProgress: (f) => stage("Transcribing audio", 0.4 + 0.4 * f),
      });
      patch({ transcript: t.segments, durationSeconds: t.durationSeconds });
      console.log(`[worker] review ${id}: ${t.segments.length} segments over ${t.durationSeconds.toFixed(1)}s`);

      // 3. Hand off to stage 2, and keep a copy for developing it.
      const handoff: TranscriptionHandoff = {
        reviewId: id,
        title: review.title,
        notes: review.notes,
        format: review.format,
        speechType: review.speechType,
        durationSeconds: t.durationSeconds,
        transcript: t.segments,
        transcription: { provider: "groq", model: t.model, language: t.language, createdAt: new Date().toISOString() },
      };
      await fs.writeFile(store.handoffPath(id), JSON.stringify(handoff, null, 2));

      // 4. Analysis. Anything short of a complete, valid VideoFeedback fails the review.
      stage("Writing feedback", 0.85);
      const feedback = await analyzeTranscript(handoff, {
        signal: ac.signal,
        onProgress: (f) => stage("Writing feedback", 0.85 + 0.15 * f),
      });
      const problems = validateFeedback(feedback, t.durationSeconds);
      if (problems.length) {
        console.error(`[worker] review ${id}: feedback rejected:\n  ${problems.join("\n  ")}`);
        throw new PipelineError("The feedback for this speech couldn't be produced. Try again.", "BAD_FEEDBACK");
      }
      patch({ status: "REVIEWED", stage: undefined, progress: 1, feedback, runId: undefined });
      console.log(`[worker] review ${id}: reviewed`);
    } catch (e) {
      patch({ status: "FAILED", stage: undefined, progress: undefined, error: userMessage(e), runId: undefined });
      if (e instanceof StageNotImplementedError) console.warn(`[worker] review ${id}: transcribed; ${e.message}`);
      else if (e instanceof PipelineError) {
        const cause = e.cause instanceof Error ? `\n  cause: ${e.cause.message}` : "";
        console.error(`[worker] review ${id}: failed (${e.code ?? "PIPELINE"}): ${e.message}${cause}`);
      } else console.error(`[worker] review ${id}: failed:`, e);
    } finally {
      clearTimeout(timer);
      await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
    }
  }
}

/** The reason shown to the student. Internal detail stays in the log. */
export function userMessage(e: unknown): string {
  if (e instanceof StageNotImplementedError) {
    return "Your speech was transcribed, but the feedback stage isn't built yet. Check back once it is.";
  }
  if (e instanceof PipelineError) return e.message;
  if (e instanceof CommandError && e.code === "ENOENT") return `A tool this server needs (${path.basename(e.cmd)}) isn't installed.`;
  if (e instanceof Error && e.name === "AbortError") return "Processing took too long. Try again.";
  return "Something went wrong while processing this speech. Try again.";
}
