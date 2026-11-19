import fs from "node:fs/promises";
import path from "node:path";
import { config } from "../config.js";
import { PipelineError } from "../errors.js";
import { CommandError, run, type RunOptions } from "./exec.js";

export interface LinkInfo {
  title?: string;
  durationSeconds?: number;
  isLive: boolean;
}

/** Asks yt-dlp about a link without downloading. Works for YouTube and direct media URLs. */
export async function inspectLink(url: string, opts: RunOptions = {}): Promise<LinkInfo> {
  try {
    const { stdout } = await run(
      config.ytDlpPath,
      ["--dump-single-json", "--no-playlist", "--no-warnings", "--skip-download", "--", url],
      { ...opts, timeoutMs: opts.timeoutMs ?? 60_000 },
    );
    const info = JSON.parse(stdout) as { title?: string; duration?: number; is_live?: boolean };
    return {
      title: info.title,
      durationSeconds: typeof info.duration === "number" ? info.duration : undefined,
      isLive: Boolean(info.is_live),
    };
  } catch (e) {
    throw linkError(e);
  }
}

/** Downloads just the audio track into `outDir` and returns the file's path. */
export async function downloadAudio(url: string, outDir: string, opts: RunOptions = {}): Promise<string> {
  try {
    const { stdout } = await run(
      config.ytDlpPath,
      [
        "--no-playlist",
        "--no-warnings",
        "-f",
        "bestaudio/best",
        "-o",
        path.join(outDir, "source.%(ext)s"),
        "--print",
        "after_move:filepath",
        "--no-simulate",
        "--",
        url,
      ],
      { ...opts, timeoutMs: opts.timeoutMs ?? 8 * 60_000 },
    );
    const printed = stdout.trim().split("\n").filter(Boolean).pop();
    if (printed) return printed;
    const found = (await fs.readdir(outDir)).find((f) => f.startsWith("source."));
    if (found) return path.join(outDir, found);
    throw new PipelineError("We couldn't fetch that link. Check it opens in a browser, or upload the file instead.", "LINK_FETCH_FAILED");
  } catch (e) {
    throw linkError(e);
  }
}

/**
 * Turns yt-dlp's stderr into a reason the student can act on. Never guesses at
 * the content. The original CommandError rides along as `cause` for the log.
 */
function linkError(e: unknown): unknown {
  if (!(e instanceof CommandError)) return e;
  const err = pickLinkError(e);
  err.cause = e;
  return err;
}

function pickLinkError(e: CommandError): PipelineError {
  if (e.code === "ENOENT") {
    return new PipelineError("Link fetching isn't set up on this server (yt-dlp is missing).", "SERVER_MISCONFIGURED");
  }
  const s = e.stderr.toLowerCase();
  if (s.includes("http error 403")) {
    // YouTube changes its player often; an out-of-date yt-dlp gets 403s on the media itself.
    return new PipelineError(
      "YouTube refused to hand over this video. The server's yt-dlp probably needs updating. Upload the file instead for now.",
      "LINK_FORBIDDEN",
    );
  }
  if (s.includes("private video")) {
    return new PipelineError("That video is private. Make it unlisted or public, or upload the file instead.", "LINK_PRIVATE");
  }
  if (s.includes("sign in to confirm") || s.includes("login required") || s.includes("age-restricted") || s.includes("confirm your age")) {
    return new PipelineError("That video needs a sign-in to watch, so we can't fetch it. Upload the file instead.", "LINK_RESTRICTED");
  }
  if (s.includes("video unavailable") || s.includes("has been removed") || s.includes("http error 404") || s.includes("not available")) {
    return new PipelineError("That video isn't available. Check the link and try again.", "LINK_UNAVAILABLE");
  }
  if (s.includes("unsupported url") || s.includes("is not a valid url") || s.includes("no video formats found")) {
    return new PipelineError("We can't read a video from that link. Use a YouTube link or a direct link to a video file.", "LINK_UNSUPPORTED");
  }
  if (s.includes("live event") || s.includes("is live") || s.includes("premieres")) {
    return new PipelineError("That's a live stream or premiere. Link to the recording once it has ended.", "LINK_LIVE");
  }
  return new PipelineError("We couldn't fetch that link. Check it opens in a browser, or upload the file instead.", "LINK_FETCH_FAILED");
}
