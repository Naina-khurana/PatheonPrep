import { StageNotImplementedError, type AnalyzeStage } from "./handoff.js";

/**
 * STAGE 2: feedback from the transcript. Not built yet.
 *
 * Replace the body of `analyzeTranscript`. It receives everything stage 1
 * knows (see TranscriptionHandoff): the timestamped transcript, the debate
 * format and speech type the student picked, their notes, and the length of
 * the recording. Return a complete `VideoFeedback`.
 *
 * Rules the worker enforces afterwards (see validateFeedback.ts):
 * - score and every category value are numbers from 1 to 10
 * - 1 to 4 sections, each with a "m:ss-m:ss" range inside the recording and
 *   at least one note
 * - every note's time is "m:ss" or "m:ss-m:ss", inside its section's range
 * If anything is missing the review FAILS. Never fill in defaults or sample
 * scores, and never return feedback for a transcript you didn't read.
 *
 * A JSON copy of every input this receives is at data/handoff/<reviewId>.json.
 */
export const analyzeTranscript: AnalyzeStage = async (input, _ctx) => {
  throw new StageNotImplementedError(`The analysis stage isn't implemented yet (review ${input.reviewId}).`);
};
