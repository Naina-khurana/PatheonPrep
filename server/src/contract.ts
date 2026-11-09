// The API contract, mirrored from section 1 of web/src/VideoReview.tsx.
//
// That file is the single source of truth. The server can't import it directly
// (it is a React component file), so the types the backend needs are repeated
// here. If you change a type, change it in both places.

/** One timestamped comment on the speech. */
export interface FeedbackNote {
  /** "m:ss" for an instant or "m:ss-m:ss" for a range. A real moment in THIS video. */
  time: string;
  /** 1–2 sentences, written to the student. */
  text: string;
}

/** A part of the video: one speech, or one phase of a single speech. */
export interface FeedbackSection {
  title: string;
  /** "m:ss-m:ss" span of the video this section covers. */
  range: string;
  speakingTips?: string;
  strengths: FeedbackNote[];
  improvements: FeedbackNote[];
}

export interface ScoreCategory {
  name: string;
  /** 1.0–10.0 */
  value: number;
}

export interface DeliveryMetrics {
  wordsPerMinute?: number;
  fillerWords?: number;
  longPauses?: number;
}

export interface CoachSummary {
  headline: string;
  body: string;
  improvements: string[];
  author: string;
  initials: string;
  date: string;
}

/** The whole AI review of one speech. Exactly what the UI renders. */
export interface VideoFeedback {
  score: number;
  scoreLabel?: string;
  scoreSummary: string;
  scoreBreakdown: ScoreCategory[];
  sections: FeedbackSection[];
  metrics?: DeliveryMetrics;
  coachSummary?: CoachSummary;
}

/** One line of the transcript, produced from the audio. */
export interface TranscriptSegment {
  /** Seconds from the start of the video. */
  start: number;
  end: number;
  text: string;
}

export type VideoSourceKind = "upload" | "record" | "link";

export type VideoReviewStatus = "QUEUED" | "PROCESSING" | "REVIEWED" | "FAILED";

/** One review, as every endpoint returns it. */
export interface VideoReview {
  id: string;
  title: string;
  studentId: string;
  studentName: string;
  isOwn: boolean;
  createdAt: string;
  sourceKind: VideoSourceKind;
  videoUrl?: string;
  contentType?: string;
  durationSeconds?: number;
  format?: string;
  speechType?: string;
  notes?: string;
  status: VideoReviewStatus;
  stage?: string;
  progress?: number;
  error?: string;
  transcript?: TranscriptSegment[];
  feedback?: VideoFeedback;
}

export interface UploadTicket {
  uploadUrl: string;
  uploadHeaders?: Record<string, string>;
  fileKey: string;
}

export type ReviewSource =
  | { kind: "upload" | "record"; fileKey: string; contentType: string; durationSeconds?: number }
  | { kind: "link"; url: string };

export interface CreateReviewRequest {
  title: string;
  source: ReviewSource;
  notes?: string;
  format?: string;
  speechType?: string;
}

export const LIMITS = {
  maxBytes: 500 * 1024 * 1024,
  maxDurationSeconds: 15 * 60,
  contentTypes: [
    "video/mp4",
    "video/quicktime",
    "video/webm",
    "video/x-matroska",
    "audio/mpeg",
    "audio/mp4",
    "audio/x-m4a",
    "audio/wav",
    "audio/webm",
  ],
} as const;

export const DEBATE_FORMATS = ["Public Forum", "Lincoln-Douglas", "Policy"] as const;
export type DebateFormat = (typeof DEBATE_FORMATS)[number];

/** The speeches of each format, in round order. */
export const SPEECH_TYPES: Record<DebateFormat, readonly string[]> = {
  "Public Forum": ["Constructive", "Rebuttal", "Summary", "Final Focus", "Crossfire"],
  "Lincoln-Douglas": [
    "Affirmative Constructive (1AC)",
    "Negative Constructive (1NC)",
    "First Affirmative Rebuttal (1AR)",
    "Negative Rebuttal (2NR)",
    "Second Affirmative Rebuttal (2AR)",
    "Cross-Examination",
  ],
  Policy: ["1AC", "1NC", "2AC", "2NC", "1NR", "1AR", "2NR", "2AR", "Cross-Examination"],
};

export const ALL_SPEECH_TYPES: readonly string[] = [...new Set(Object.values(SPEECH_TYPES).flat())];
