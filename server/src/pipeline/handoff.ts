import type { TranscriptSegment, VideoFeedback } from "../contract.js";

/**
 * What stage 1 (transcription) hands to stage 2 (analysis). The worker also
 * writes one of these to data/handoff/<reviewId>.json for every review it
 * transcribes, so the analysis can be developed against real speeches.
 */
export interface TranscriptionHandoff {
  reviewId: string;
  title: string;
  /** What the student typed when submitting, if anything. */
  notes?: string;
  /** One of DEBATE_FORMATS, if the student picked one. */
  format?: string;
  /** One of SPEECH_TYPES[format], if the student picked one. */
  speechType?: string;
  /** Length of the recording, from ffprobe. Every note time must fall inside it. */
  durationSeconds: number;
  transcript: TranscriptSegment[];
  transcription: {
    provider: "groq";
    model: string;
    language?: string;
    createdAt: string;
  };
}

export interface StageContext {
  /** Fires when the review times out or is deleted. Stop work when it does. */
  signal: AbortSignal;
  /** 0–1 within this stage, shown on the UI's progress bar. */
  onProgress: (fraction: number) => void;
}

/** The analysis stage: a transcript in, a complete VideoFeedback out. */
export type AnalyzeStage = (input: TranscriptionHandoff, ctx: StageContext) => Promise<VideoFeedback>;

export class StageNotImplementedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StageNotImplementedError";
  }
}
