import type { DeliveryMetrics, TranscriptSegment } from "../contract.js";

const fillerWords = new Set(["um", "uh", "erm", "umm", "uhh"]);
const longPauseSeconds = 2;

/** Measures transcribed words and gaps between speech segments. */
export function deliveryMetrics(segments: readonly TranscriptSegment[], durationSeconds: number): DeliveryMetrics {
  const words = segments.flatMap(({ text }) => text.toLowerCase().match(/\p{L}+(?:['’]\p{L}+)*|\p{N}+/gu) ?? []);
  const metrics: DeliveryMetrics = {
    fillerWords: words.filter((word) => fillerWords.has(word)).length,
  };
  if (Number.isFinite(durationSeconds) && durationSeconds > 0) {
    metrics.wordsPerMinute = Math.round(words.length * 60 / durationSeconds);
  }
  const timed = segments.filter(({ start, end }) => Number.isFinite(start) && Number.isFinite(end) && start >= 0 && end > start);
  if (timed.length === segments.length && timed.length >= 2) {
    timed.sort((a, b) => a.start - b.start);
    let lastEnd = timed[0].end;
    let pauses = 0;
    for (const segment of timed.slice(1)) {
      if (segment.start - lastEnd >= longPauseSeconds) pauses++;
      lastEnd = Math.max(lastEnd, segment.end);
    }
    metrics.longPauses = pauses;
  }
  return metrics;
}
