import type { VideoFeedback } from "../contract.js";

const CLOCK = /^(\d+):([0-5]\d)$/;

/** "m:ss" to seconds, or null. */
export function parseClock(s: string): number | null {
  const m = CLOCK.exec(s.trim());
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

/** "m:ss-m:ss" to [start, end] seconds, or null. */
export function parseRange(s: string): [number, number] | null {
  const parts = s.split("-");
  if (parts.length !== 2) return null;
  const a = parseClock(parts[0]);
  const b = parseClock(parts[1]);
  return a != null && b != null && a <= b ? [a, b] : null;
}

/** A note's "m:ss" or "m:ss-m:ss" to [start, end] seconds, or null. */
export function parseNoteTime(s: string): [number, number] | null {
  if (s.includes("-")) return parseRange(s);
  const t = parseClock(s);
  return t == null ? null : [t, t];
}

const isScore = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 1 && v <= 10;
const nonEmpty = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0;

/**
 * Checks a VideoFeedback before it reaches a student. Returns the problems
 * found; an empty list means it is safe to store. "m:ss" rounds to the second,
 * so times get one second of slack against the recording and section bounds.
 */
export function validateFeedback(fb: unknown, durationSeconds: number): string[] {
  const errors: string[] = [];
  if (!fb || typeof fb !== "object") return ["feedback is not an object"];
  const f = fb as Partial<VideoFeedback>;
  const slack = 1;
  const limit = durationSeconds > 0 ? durationSeconds + slack : Number.POSITIVE_INFINITY;

  if (!isScore(f.score)) errors.push("score is missing or outside 1–10");
  if (!nonEmpty(f.scoreSummary)) errors.push("scoreSummary is missing");
  if (f.scoreLabel !== undefined && typeof f.scoreLabel !== "string") errors.push("scoreLabel must be a string");

  if (!Array.isArray(f.scoreBreakdown) || f.scoreBreakdown.length === 0) errors.push("scoreBreakdown is missing");
  else {
    f.scoreBreakdown.forEach((c, i) => {
      if (!c || !nonEmpty(c.name) || !isScore(c.value)) errors.push(`scoreBreakdown[${i}] needs a name and a value from 1 to 10`);
    });
  }

  if (!Array.isArray(f.sections) || f.sections.length < 1 || f.sections.length > 4) errors.push("sections must have 1 to 4 entries");
  else {
    f.sections.forEach((s, i) => {
      const where = `sections[${i}]`;
      if (!s || typeof s !== "object") return void errors.push(`${where} is not an object`);
      if (!nonEmpty(s.title)) errors.push(`${where}.title is missing`);
      const range = typeof s.range === "string" ? parseRange(s.range) : null;
      if (!range) errors.push(`${where}.range must be "m:ss-m:ss"`);
      else if (range[1] > limit) errors.push(`${where}.range ends after the recording`);
      if (s.speakingTips !== undefined && typeof s.speakingTips !== "string") errors.push(`${where}.speakingTips must be a string`);
      const strengths = Array.isArray(s.strengths) ? s.strengths : null;
      const improvements = Array.isArray(s.improvements) ? s.improvements : null;
      if (!strengths || !improvements) errors.push(`${where} needs strengths and improvements arrays`);
      else if (strengths.length + improvements.length === 0) errors.push(`${where} has no notes`);
      for (const [list, name] of [[strengths, "strengths"], [improvements, "improvements"]] as const) {
        (list ?? []).forEach((n, j) => {
          const at = `${where}.${name}[${j}]`;
          if (!n || !nonEmpty(n.text)) errors.push(`${at}.text is missing`);
          const t = typeof n?.time === "string" ? parseNoteTime(n.time) : null;
          if (!t) errors.push(`${at}.time must be "m:ss" or "m:ss-m:ss"`);
          else {
            if (t[1] > limit) errors.push(`${at}.time is after the end of the recording`);
            if (range && (t[0] < range[0] - slack || t[1] > range[1] + slack)) errors.push(`${at}.time is outside its section's range`);
          }
        });
      }
    });
  }

  if (f.metrics !== undefined) {
    const m = f.metrics as Record<string, unknown>;
    for (const k of ["wordsPerMinute", "fillerWords", "longPauses"]) {
      if (m[k] !== undefined && (typeof m[k] !== "number" || !Number.isFinite(m[k]) || (m[k] as number) < 0)) errors.push(`metrics.${k} must be a non-negative number`);
    }
  }
  return errors;
}
