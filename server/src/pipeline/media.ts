import fs from "node:fs/promises";
import path from "node:path";
import { config } from "../config.js";
import { PipelineError } from "../errors.js";
import { CommandError, run, type RunOptions } from "./exec.js";

export interface MediaInfo {
  durationSeconds: number;
  hasAudio: boolean;
}

/** Reads the length and whether there is an audio track. Fails if the file isn't media at all. */
export async function probe(file: string, opts: RunOptions = {}): Promise<MediaInfo> {
  let stdout: string;
  try {
    ({ stdout } = await run(
      config.ffprobePath,
      ["-v", "error", "-show_entries", "format=duration:stream=codec_type", "-of", "json", file],
      opts,
    ));
  } catch (e) {
    if (e instanceof CommandError && e.code !== "ENOENT") {
      throw new PipelineError("We couldn't read that file as a video or audio file.", "UNREADABLE_MEDIA");
    }
    throw e;
  }
  const info = JSON.parse(stdout) as { format?: { duration?: string }; streams?: { codec_type?: string }[] };
  const duration = Number(info.format?.duration);
  return {
    durationSeconds: Number.isFinite(duration) ? duration : 0,
    hasAudio: (info.streams ?? []).some((s) => s.codec_type === "audio"),
  };
}

/**
 * Pulls the audio out as mono 16 kHz MP3 at 48 kbps. That is what Whisper
 * hears anyway, and 15 minutes comes to about 5 MB, well under Groq's cap.
 */
export async function extractMp3(input: string, output: string, opts: RunOptions = {}): Promise<void> {
  await run(
    config.ffmpegPath,
    ["-y", "-nostdin", "-hide_banner", "-loglevel", "error", "-i", input, "-vn", "-ac", "1", "-ar", "16000", "-b:a", "48k", "-codec:a", "libmp3lame", output],
    opts,
  );
}

/** Cuts an MP3 into pieces of about `chunkSeconds` without re-encoding. Returns them in order. */
export async function splitMp3(input: string, outDir: string, chunkSeconds: number, opts: RunOptions = {}): Promise<string[]> {
  await run(
    config.ffmpegPath,
    ["-y", "-nostdin", "-hide_banner", "-loglevel", "error", "-i", input, "-f", "segment", "-segment_time", String(chunkSeconds), "-c", "copy", path.join(outDir, "chunk-%03d.mp3")],
    opts,
  );
  const names = (await fs.readdir(outDir)).filter((f) => /^chunk-\d+\.mp3$/.test(f)).sort();
  return names.map((f) => path.join(outDir, f));
}
