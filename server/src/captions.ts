import type { Router } from "express";
import { canSee, viewerOf } from "./auth.js";
import type { CaptionCue, TranscriptMatch, TranscriptSegment } from "./contract.js";
import { HttpError } from "./errors.js";
import { notFound, wrap } from "./httpUtil.js";
import { store } from "./store.js";

const clean = (text: string) => text.replace(/\s+/g, " ").trim();

/**
 * Cuts the transcript into captions short enough to sit over the video (two
 * lines of about 42 characters). Whisper returns some very long segments when
 * a debater never pauses; those are split at word boundaries, preferring the
 * end of a sentence, and each piece gets a share of the segment's time in
 * proportion to its length. The same function is in web/src/VideoReview.tsx.
 */
export function buildCues(transcript: TranscriptSegment[], maxChars = 84): CaptionCue[] {
  const cues: CaptionCue[] = [];
  for (const seg of transcript) {
    const text = clean(seg.text);
    if (!text) continue;
    if (text.length <= maxChars) {
      cues.push({ start: seg.start, end: seg.end, text });
      continue;
    }
    const pieces: string[] = [];
    let line = "";
    for (const word of text.split(" ")) {
      if (line && line.length + 1 + word.length > maxChars) {
        pieces.push(line);
        line = word;
      } else line = line ? `${line} ${word}` : word;
      if (/[.?!]["')\]]?$/.test(line) && line.length >= maxChars / 2) {
        pieces.push(line);
        line = "";
      }
    }
    if (line) pieces.push(line);
    const total = pieces.reduce((n, p) => n + p.length, 0);
    const span = Math.max(0, seg.end - seg.start);
    let used = 0;
    pieces.forEach((piece, i) => {
      const start = seg.start + (span * used) / total;
      used += piece.length;
      const end = i === pieces.length - 1 ? seg.end : seg.start + (span * used) / total;
      cues.push({ start, end, text: piece });
    });
  }
  return cues;
}

function vttTime(seconds: number): string {
  const ms = Math.max(0, Math.round(seconds * 1000));
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${p(Math.floor(ms / 3600000))}:${p(Math.floor(ms / 60000) % 60)}:${p(Math.floor(ms / 1000) % 60)}.${p(ms % 1000, 3)}`;
}

/** The captions as a WebVTT file, for a <track> or a download. */
export function toVtt(cues: CaptionCue[]): string {
  const blocks = cues
    .filter((c) => c.end > c.start)
    .map((c, i) => {
      const text = c.text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
      return `${i + 1}\n${vttTime(c.start)} --> ${vttTime(c.end)}\n${text}`;
    });
  return ["WEBVTT", ...blocks].join("\n\n") + "\n";
}

/**
 * Every place `query` was said, in order. Case-insensitive, matching the words
 * as typed. `time` is estimated from how far into its segment the match
 * starts, so a hit late in a long segment seeks close to the words rather than
 * to the start of the segment.
 */
export function searchTranscript(transcript: TranscriptSegment[], query: string, limit = 50): TranscriptMatch[] {
  const needle = clean(query).toLowerCase();
  const matches: TranscriptMatch[] = [];
  if (!needle) return matches;
  for (const seg of transcript) {
    const text = clean(seg.text);
    const hay = text.toLowerCase();
    for (let at = hay.indexOf(needle); at !== -1; at = hay.indexOf(needle, at + needle.length)) {
      if (matches.length >= limit) return matches;
      const from = Math.max(0, at - 60);
      const to = Math.min(text.length, at + needle.length + 60);
      matches.push({
        time: seg.start + (Math.max(0, seg.end - seg.start) * at) / Math.max(1, text.length),
        start: seg.start,
        end: seg.end,
        text: (from > 0 ? "…" : "") + text.slice(from, to).trim() + (to < text.length ? "…" : ""),
      });
    }
  }
  return matches;
}

/** Caption and search data, drawn from the transcript stored on the review. */
export function registerCaptionRoutes(r: Router) {
  const transcriptOf = (id: string, res: Parameters<typeof viewerOf>[0]) => {
    const review = store.getReview(id);
    if (!review || !canSee(viewerOf(res), review.studentId)) throw notFound();
    return review.transcript ?? [];
  };

  r.get(
    "/:id/captions",
    wrap((req, res) => {
      res.json({ cues: buildCues(transcriptOf(req.params.id, res)) });
    }),
  );

  r.get(
    "/:id/captions.vtt",
    wrap((req, res) => {
      res.type("text/vtt").send(toVtt(buildCues(transcriptOf(req.params.id, res))));
    }),
  );

  r.get(
    "/:id/search",
    wrap((req, res) => {
      const transcript = transcriptOf(req.params.id, res);
      const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
      if (!q) throw new HttpError(400, "Type something to search for.", "QUERY_REQUIRED");
      if (q.length > 100) throw new HttpError(400, "That search is too long. Keep it under 100 characters.", "QUERY_TOO_LONG");
      res.json({ matches: searchTranscript(transcript, q) });
    }),
  );
}
