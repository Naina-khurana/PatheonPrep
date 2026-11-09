import { openAsBlob } from "node:fs";
import path from "node:path";
import { config } from "../config.js";
import { PipelineError } from "../errors.js";

const ENDPOINT = "https://api.groq.com/openai/v1/audio/transcriptions";

/** Groq's free tier accepts files up to 25 MB. Stay a little under it. */
export const GROQ_MAX_FILE_BYTES = 24 * 1024 * 1024;

export interface WhisperSegment {
  start: number;
  end: number;
  text: string;
  /** Whisper's own estimate that this stretch is silence or noise. */
  noSpeechProb?: number;
  avgLogprob?: number;
}

export interface WhisperResult {
  text: string;
  segments: WhisperSegment[];
  durationSeconds?: number;
  language?: string;
}

export interface GroqOptions {
  /** Steers spelling and vocabulary. Whisper reads about the last 224 tokens. */
  prompt?: string;
  model?: string;
  signal?: AbortSignal;
}

interface VerboseJson {
  text?: string;
  duration?: number;
  language?: string;
  segments?: { start: number; end: number; text: string; no_speech_prob?: number; avg_logprob?: number }[];
}

/** Sends one audio file to Groq's Whisper endpoint and returns timestamped segments. */
export async function groqTranscribe(file: string, opts: GroqOptions = {}): Promise<WhisperResult> {
  if (!config.groqApiKey) {
    throw new PipelineError("Transcription isn't set up on this server yet (GROQ_API_KEY is missing).", "SERVER_MISCONFIGURED");
  }
  const model = opts.model ?? config.groqModel;

  for (let attempt = 1; ; attempt++) {
    const form = new FormData();
    form.set("file", await openAsBlob(file, { type: "audio/mpeg" }), path.basename(file));
    form.set("model", model);
    form.set("response_format", "verbose_json");
    form.set("language", "en");
    form.set("temperature", "0");
    form.append("timestamp_granularities[]", "segment");
    if (opts.prompt) form.set("prompt", opts.prompt);

    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: { Authorization: `Bearer ${config.groqApiKey}` },
      body: form,
      signal: opts.signal,
    });

    if (res.ok) {
      const json = (await res.json()) as VerboseJson;
      return {
        text: json.text ?? "",
        durationSeconds: json.duration,
        language: json.language,
        segments: (json.segments ?? []).map((s) => ({
          start: s.start,
          end: s.end,
          text: s.text,
          noSpeechProb: s.no_speech_prob,
          avgLogprob: s.avg_logprob,
        })),
      };
    }

    const body = await res.text().catch(() => "");
    const retryable = res.status === 429 || res.status >= 500;
    if (retryable && attempt < 4) {
      const retryAfter = Number(res.headers.get("retry-after"));
      const waitMs = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 1500 * 2 ** attempt;
      console.warn(`[groq] ${res.status} on attempt ${attempt}, retrying in ${waitMs} ms`);
      await sleep(waitMs, opts.signal);
      continue;
    }
    console.error(`[groq] ${res.status} ${res.statusText}: ${body.slice(0, 500)}`);
    throw httpError(res.status);
  }
}

function httpError(status: number): PipelineError {
  if (status === 401 || status === 403) {
    return new PipelineError("The transcription service rejected this server's API key.", "SERVER_MISCONFIGURED");
  }
  if (status === 413) return new PipelineError("The audio was too large to transcribe in one piece.", "AUDIO_TOO_LARGE");
  if (status === 429) return new PipelineError("The transcription service is busy right now. Try again in a minute.", "RATE_LIMITED");
  if (status >= 500) return new PipelineError("The transcription service had a problem. Try again in a few minutes.", "STT_UNAVAILABLE");
  return new PipelineError("The audio couldn't be transcribed. Try a different file.", "STT_REJECTED");
}

function sleep(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(signal?.reason);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
