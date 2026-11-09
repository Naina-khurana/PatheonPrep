import fs from "node:fs/promises";
import { config } from "../config.js";
import type { TranscriptSegment } from "../contract.js";
import { PipelineError } from "../errors.js";
import { GROQ_MAX_FILE_BYTES, groqTranscribe, type WhisperSegment } from "./groq.js";
import { probe, splitMp3 } from "./media.js";

export interface TranscribeAudioOptions {
  format?: string;
  /** Scratch directory for chunks. */
  workDir: string;
  signal?: AbortSignal;
  /** 0–1 across all chunks. */
  onProgress?: (fraction: number) => void;
}

export interface TranscribeAudioResult {
  segments: TranscriptSegment[];
  durationSeconds: number;
  model: string;
  language?: string;
}

/**
 * Turns an MP3 into timestamped segments. Files over Groq's cap are cut into
 * pieces and the pieces' timestamps shifted back onto the whole recording.
 */
export async function transcribeAudio(mp3: string, opts: TranscribeAudioOptions): Promise<TranscribeAudioResult> {
  const runOpts = { signal: opts.signal };
  const { durationSeconds } = await probe(mp3, runOpts);
  const { size } = await fs.stat(mp3);

  let chunks = [mp3];
  if (size > GROQ_MAX_FILE_BYTES) {
    const pieces = Math.ceil(size / (GROQ_MAX_FILE_BYTES * 0.9));
    const chunkSeconds = Math.max(30, Math.floor(durationSeconds / pieces));
    chunks = await splitMp3(mp3, opts.workDir, chunkSeconds, runOpts);
  }

  const prompt = whisperPrompt(opts.format);
  const raw: WhisperSegment[] = [];
  let offset = 0;
  let language: string | undefined;
  for (let i = 0; i < chunks.length; i++) {
    const result = await groqTranscribe(chunks[i], { prompt, signal: opts.signal });
    language ??= result.language;
    for (const s of result.segments) raw.push({ ...s, start: s.start + offset, end: s.end + offset });
    if (chunks.length > 1) offset += (await probe(chunks[i], runOpts)).durationSeconds;
    opts.onProgress?.((i + 1) / chunks.length);
  }

  const segments = cleanSegments(raw, durationSeconds);
  if (segments.length === 0) throw new PipelineError("No speech was found in the audio.", "NO_SPEECH");
  return { segments, durationSeconds, model: config.groqModel, language };
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Trims whitespace, drops empty and duplicated lines, clamps times to the
 * recording, and throws away Whisper's silence hallucinations (a high
 * no-speech probability together with a very low confidence).
 */
export function cleanSegments(raw: WhisperSegment[], durationSeconds: number): TranscriptSegment[] {
  const out: TranscriptSegment[] = [];
  for (const s of raw) {
    const text = s.text.replace(/\s+/g, " ").trim();
    if (!text) continue;
    if ((s.noSpeechProb ?? 0) > 0.6 && (s.avgLogprob ?? 0) < -1) continue;
    const start = round2(Math.max(0, s.start));
    if (durationSeconds > 0 && start >= durationSeconds) continue;
    let end = round2(Math.max(start, s.end));
    if (durationSeconds > 0) end = Math.min(end, round2(durationSeconds));
    const prev = out[out.length - 1];
    if (prev && prev.text === text && Math.abs(prev.start - start) < 0.5) continue;
    out.push({ start, end, text });
  }
  return out;
}

/** Debate vocabulary so Whisper spells the jargon right. Kept short: Whisper reads about 224 tokens of it. */
export function whisperPrompt(format?: string): string {
  const base =
    "A high school debate speech. Resolved, affirm, negate, contention, framework, warrant, impact, link, turn, extend, weigh, magnitude, probability, cross-examination, card, evidence.";
  switch (format) {
    case "Public Forum":
      return `${base} Public Forum, Pro, Con, crossfire, summary, final focus.`;
    case "Lincoln-Douglas":
      return `${base} Lincoln-Douglas, value, value criterion, 1AC, 1NC, 1AR, 2NR, 2AR.`;
    case "Policy":
      return `${base} Policy debate, plan, counterplan, disadvantage, kritik, topicality, uniqueness, solvency, 1AC, 2AC, 2NR.`;
    default:
      return base;
  }
}
