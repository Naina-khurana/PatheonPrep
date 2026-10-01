"use client";

// ═══════════════════════════════════════════════════════════════════════════
// Video Review — the whole frontend in one file.
//
// A student submits a debate speech (record it here, upload a file, or paste a
// link) and gets AI feedback: an overall grade, category grades, and
// timestamped strengths / improvements they step through while the video jumps
// to each moment. A teacher sees their students' reviews, read-only.
//
// HOW TO RUN
//   Needs only react 18+, tailwindcss v3 (default config; include this file in
//   Tailwind's `content`) and lucide-react. Render the default export full
//   screen:   import App from "./VideoReview";   <App />
//   It shows Video Review with a Student / Teacher switch at the top, backed by
//   `mockApi` (an in-memory fake backend) so it works before any server exists.
//   Put "fail" in a round's title to see the failure + retry screens.
//
// SWITCHING TO THE REAL BACKEND
//   In `App` (bottom of the file), replace `mockApi` with
//     createHttpApi({ baseUrl: "https://your-api/v1",
//                     getHeaders: async () => ({ Authorization: `Bearer ${token}` }) })
//   (or `credentials: "include"` for cookie sessions) and delete the
//   `setMockViewer(role)` line. Nothing else changes.
//
// SECTIONS
//   1. API contract — types, limits, HTTP client, mock backend   (backend team: start here)
//   2. Recorder     — in-browser camera + mic recording
//   3. The tool     — list, submit flow, review screen
//   4. App          — the page to run, with the Student / Teacher switch
// ═══════════════════════════════════════════════════════════════════════════

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode, type SyntheticEvent } from "react";
import {
  AlertTriangle,
  ArrowLeft,
  Camera,
  CameraOff,
  Check,
  ChevronLeft,
  ChevronRight,
  Download,
  FileText,
  Film,
  Link2,
  Loader2,
  Pause,
  Play,
  Plus,
  RotateCcw,
  Square,
  Upload,
  X,
} from "lucide-react";


// ═══════════════════════════ 1. API CONTRACT ═══════════════════════════
// Video Review — the API contract.
// 
// This file is the single source of truth shared by the frontend and whatever
// backend implements it:
// 1. Types: a review, its AI feedback, statuses, request/response bodies.
// 2. Limits the client checks before uploading (the server must enforce them too).
// 3. `createHttpApi()`: a typed fetch client, one function per endpoint.
// 4. `mockApi`: an in-memory stand-in so the UI runs with no backend.
// 
// Every endpoint answers JSON. Errors are `{ error: string, code?: string }`
// with a non-2xx status; `error` is shown to the user as is, so write it for a
// student ("That file is too large. The limit is 500 MB.").
//
// ───────────────────────── 1. types ─────────────────────────

/** One timestamped comment on the speech. */
export interface FeedbackNote {
  /**
   * Where in the video this note points: "m:ss" for an instant or
   * "m:ss-m:ss" for a range (e.g. "1:05" or "1:05-1:22"). Must be a real
   * moment in THIS video — the player seeks to it.
   */
  time: string;
  /** 1–2 sentences, written to the student. */
  text: string;
}

/** A part of the video: one speech, or one phase of a single speech. */
export interface FeedbackSection {
  /** e.g. "Constructive", "Rebuttal", "Summary". */
  title: string;
  /** "m:ss-m:ss" span of the video this section covers. */
  range: string;
  /** Optional 1–3 sentences of delivery advice for this section. */
  speakingTips?: string;
  strengths: FeedbackNote[];
  improvements: FeedbackNote[];
}

/** A category score, e.g. { name: "Argumentation", value: 7.4 }. */
export interface ScoreCategory {
  name: string;
  /** 1.0–10.0. The UI shows it as a letter grade (see letterGrade). */
  value: number;
}

/** Optional delivery measurements from the audio (a nice-to-have). */
export interface DeliveryMetrics {
  wordsPerMinute?: number;
  /** Count of "um", "uh", "like", "you know"… */
  fillerWords?: number;
  /** Silences longer than ~2 seconds. */
  longPauses?: number;
}

/** A teacher's or coach's written verdict (optional; not AI-generated today). */
export interface CoachSummary {
  headline: string;
  body: string;
  /** Ordered "do these next" items. */
  improvements: string[];
  author: string;
  /** e.g. "JS" — shown in a badge. */
  initials: string;
  /** Display date, already formatted, e.g. "Oct 11". */
  date: string;
}

/** The whole AI review of one speech. This is exactly what the UI renders. */
export interface VideoFeedback {
  /** Overall score, 1.0–10.0. */
  score: number;
  /** Short verdict shown under the grade, e.g. "Clear case, thin weighing". */
  scoreLabel?: string;
  /** 2–4 sentence overview. */
  scoreSummary: string;
  /** 3–6 categories, e.g. Argumentation, Evidence, Refutation, Delivery. */
  scoreBreakdown: ScoreCategory[];
  /** 1–4 sections, in video order, each with at least one note. */
  sections: FeedbackSection[];
  metrics?: DeliveryMetrics;
  coachSummary?: CoachSummary;
}

/** One line of the transcript, produced by the backend from the audio. */
export interface TranscriptSegment {
  /** Seconds from the start of the video. */
  start: number;
  end: number;
  text: string;
}

export type VideoSourceKind = "upload" | "record" | "link";

/**
 * QUEUED      saved, waiting for a worker
 * PROCESSING  being transcribed / analysed (see `stage`, `progress`)
 * REVIEWED    `feedback` is ready
 * FAILED      analysis failed; `error` says why in plain words. Retry with
 *             POST /video-reviews/:id/analyze. Never fill in made-up feedback.
 */
export type VideoReviewStatus = "QUEUED" | "PROCESSING" | "REVIEWED" | "FAILED";

/** One review, as every endpoint returns it. */
export interface VideoReview {
  id: string;
  title: string;
  studentId: string;
  /** "You" for the viewer's own reviews, otherwise the student's display name. */
  studentName: string;
  /** True when the signed-in user submitted it (they may delete / retry it). */
  isOwn: boolean;
  /** ISO 8601. */
  createdAt: string;

  sourceKind: VideoSourceKind;
  /**
   * What the player loads: a YouTube link, a direct media URL, or a
   * short-lived signed URL to the stored file. Absent if it can't be played.
   */
  videoUrl?: string;
  contentType?: string;
  durationSeconds?: number;
  /** e.g. "Public Forum" — shown next to the title. */
  format?: string;
  /** Optional context the student typed when submitting. */
  notes?: string;

  status: VideoReviewStatus;
  /** Human-readable step while QUEUED/PROCESSING, e.g. "Transcribing audio". */
  stage?: string;
  /** 0–1 while PROCESSING, if the backend can estimate it. */
  progress?: number;
  /** Why the last analysis failed (status FAILED). */
  error?: string;

  transcript?: TranscriptSegment[];
  feedback?: VideoFeedback;
}

/** Response of POST /video-reviews/upload-url. */
export interface UploadTicket {
  /** Where the browser PUTs the raw file bytes. */
  uploadUrl: string;
  /** Extra headers the PUT must carry (Content-Type is always sent). */
  uploadHeaders?: Record<string, string>;
  /** Opaque id of the stored file; passed back in CreateReviewRequest. */
  fileKey: string;
}

export type ReviewSource =
  | { kind: "upload" | "record"; fileKey: string; contentType: string; durationSeconds?: number }
  | { kind: "link"; url: string };

/** Body of POST /video-reviews. Creating a review starts its analysis. */
export interface CreateReviewRequest {
  title: string;
  source: ReviewSource;
  notes?: string;
}

// ───────────────────────── 2. limits ─────────────────────────

export const LIMITS = {
  maxBytes: 500 * 1024 * 1024,
  maxDurationSeconds: 15 * 60,
  /** What phones, laptops and the in-browser recorder produce. */
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

/** A user-facing reason this file can't be submitted, or null if it's fine. */
export function checkFile(file: File): string | null {
  if (!(LIMITS.contentTypes as readonly string[]).includes(file.type)) {
    return "That file isn't a supported video or audio format. Use MP4, MOV, WebM, MP3, M4A or WAV.";
  }
  if (file.size > LIMITS.maxBytes) {
    return `That file is too large. The limit is ${Math.round(LIMITS.maxBytes / 1024 / 1024)} MB.`;
  }
  return null;
}

// ───────────────────────── 3. the client ─────────────────────────

/** Everything the UI needs from a backend. `createHttpApi` and `mockApi` both implement it. */
export interface VideoReviewApi {
  /** GET /video-reviews → { reviews }. A student gets their own; a teacher their students'. */
  listReviews(): Promise<VideoReview[]>;
  /** GET /video-reviews/:id → { review }. Polled while processing; refreshes signed URLs. */
  getReview(id: string): Promise<VideoReview>;
  /** POST /video-reviews/upload-url, then PUT the bytes to the returned URL. */
  uploadFile(file: File, onProgress?: (fraction: number) => void): Promise<{ fileKey: string }>;
  /** POST /video-reviews → 201 { review } (status QUEUED or PROCESSING). */
  createReview(body: CreateReviewRequest): Promise<VideoReview>;
  /** POST /video-reviews/:id/analyze → 202 { review }. Re-runs a failed analysis. Owner only. */
  analyzeReview(id: string): Promise<VideoReview>;
  /** DELETE /video-reviews/:id → { ok: true }. Owner only; removes the stored file too. */
  deleteReview(id: string): Promise<void>;
}

export class ApiError extends Error {
  constructor(message: string, public status: number, public code?: string) {
    super(message);
  }
}

export interface HttpApiOptions {
  /** e.g. "https://api.example.com/v1" — endpoint paths are appended to it. */
  baseUrl: string;
  /** Auth for each request, e.g. async () => ({ Authorization: `Bearer ${token}` }). */
  getHeaders?: () => Record<string, string> | Promise<Record<string, string>>;
  /** Set to "include" for cookie sessions on another origin. */
  credentials?: RequestCredentials;
}

export function createHttpApi({ baseUrl, getHeaders, credentials }: HttpApiOptions): VideoReviewApi {
  const root = baseUrl.replace(/\/+$/, "") + "/video-reviews";

  async function call<T>(path: string, method = "GET", body?: unknown): Promise<T> {
    const headers: Record<string, string> = { ...(await getHeaders?.()) };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const res = await fetch(root + path, {
      method,
      headers,
      credentials,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new ApiError(data.error || "Something went wrong. Try again.", res.status, data.code);
    return data as T;
  }

  const byId = (id: string) => `/${encodeURIComponent(id)}`;

  return {
    listReviews: async () => (await call<{ reviews: VideoReview[] }>("")).reviews,
    getReview: async (id) => (await call<{ review: VideoReview }>(byId(id))).review,
    createReview: async (body) => (await call<{ review: VideoReview }>("", "POST", body)).review,
    analyzeReview: async (id) => (await call<{ review: VideoReview }>(`${byId(id)}/analyze`, "POST")).review,
    deleteReview: async (id) => {
      await call<{ ok: true }>(byId(id), "DELETE");
    },
    async uploadFile(file, onProgress) {
      const ticket = await call<UploadTicket>("/upload-url", "POST", {
        fileName: file.name,
        contentType: file.type,
        sizeBytes: file.size,
      });
      await putWithProgress(ticket, file, onProgress);
      return { fileKey: ticket.fileKey };
    },
  };
}

/** XMLHttpRequest rather than fetch, because fetch can't report upload progress. */
function putWithProgress(ticket: UploadTicket, file: File, onProgress?: (fraction: number) => void) {
  return new Promise<void>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", ticket.uploadUrl);
    xhr.setRequestHeader("Content-Type", file.type);
    for (const [k, v] of Object.entries(ticket.uploadHeaders ?? {})) xhr.setRequestHeader(k, v);
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress?.(e.loaded / e.total);
    xhr.onload = () =>
      xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new Error(`Upload failed (${xhr.status}). Try again.`));
    xhr.onerror = () => reject(new Error("Upload failed. Check your connection and try again."));
    xhr.send(file);
  });
}

// ───────────────────────── 4. mock (NOT a real backend) ─────────────────────────
//
// MOCK ONLY. Keeps reviews in memory for this browser tab, "uploads" by making
// a local object URL, and after a few seconds of fake processing attaches a
// canned SAMPLE feedback whose timestamps are spread over the video's length.
// It does not look at the video at all. A title containing "fail" fails the
// first analysis, so the failure + retry path can be tried.

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const clock = (s: number) => `${Math.floor(s / 60)}:${String(Math.round(s) % 60).padStart(2, "0")}`;

function sampleFeedback(duration: number): VideoFeedback {
  const at = (fraction: number) => clock(Math.max(1, duration * fraction));
  const mid = duration / 2;
  return {
    score: 7.6,
    scoreLabel: "Sample feedback (mock)",
    scoreSummary:
      "MOCK DATA — the real backend writes this from the speech. Your case is organised and your first contention is well warranted. Weighing arrives late, and the rebuttal answers the claim rather than the warrant.",
    scoreBreakdown: [
      { name: "Argumentation", value: 8.1 },
      { name: "Evidence & Warrants", value: 7.4 },
      { name: "Refutation & Weighing", value: 6.8 },
      { name: "Delivery", value: 7.9 },
    ],
    metrics: { wordsPerMinute: 182, fillerWords: 14, longPauses: 3 },
    sections: [
      {
        title: "Constructive",
        range: `0:00-${clock(mid)}`,
        speakingTips: "Slow down on the taglines so the judge can flow them.",
        strengths: [
          { time: at(0.05), text: "Clear roadmap: the judge knows exactly where you're going." },
          { time: at(0.2), text: "Good warrant on contention one — you explain why, not just what." },
        ],
        improvements: [{ time: at(0.35), text: "This card is read without a tag. Say what it proves before you read it." }],
      },
      {
        title: "Rebuttal",
        range: `${clock(mid)}-${clock(duration)}`,
        strengths: [{ time: at(0.6), text: "Nice turn on their economic impact." }],
        improvements: [
          { time: at(0.72), text: "You answer their claim but not their warrant — attack the link." },
          { time: at(0.9), text: "Weighing comes in the last seconds. Start comparing impacts earlier." },
        ],
      },
    ],
  };
}

function sampleTranscript(duration: number): TranscriptSegment[] {
  const lines = [
    "MOCK TRANSCRIPT — the real backend transcribes the video's audio.",
    "Today my partner and I will prove three things.",
    "Our first contention is economic growth.",
    "Turning to their case, their impact relies on a single study.",
    "Weigh this round on probability.",
  ];
  const step = duration / lines.length;
  return lines.map((text, i) => ({ start: i * step, end: (i + 1) * step, text }));
}

/** Who the mock is showing reviews to. The real server works this out from the session. */
export type MockViewer = "student" | "teacher";

function createMockApi(getViewer: () => MockViewer = () => "student"): VideoReviewApi {
  const reviews = new Map<string, VideoReview>();
  const files = new Map<string, { url: string; type: string }>();
  const failedOnce = new Set<string>();
  let nextId = 1;

  // One finished review so the review screen can be seen straight away. It
  // has no video, so the player runs on a clock.
  reviews.set("sample", {
    id: "sample",
    title: "Sample round (mock data)",
    studentId: "student-1",
    studentName: MOCK_STUDENT,
    isOwn: true,
    createdAt: new Date().toISOString(),
    sourceKind: "link",
    durationSeconds: 240,
    format: "Public Forum",
    status: "REVIEWED",
    transcript: sampleTranscript(240),
    feedback: sampleFeedback(240),
  });

  // Everything is by the one mock student: they see "You" and can delete or
  // retry; the teacher sees the student's name, read-only.
  const copy = (r: VideoReview): VideoReview => {
    const student = getViewer() === "student";
    return { ...structuredClone(r), isOwn: student, studentName: student ? "You" : r.studentName };
  };
  const patch = (id: string, changes: Partial<VideoReview>) => {
    const r = reviews.get(id);
    if (r) reviews.set(id, { ...r, ...changes });
  };

  /** Fake pipeline: queued → transcribing → analysing → reviewed (or failed). */
  async function process(id: string) {
    patch(id, { status: "QUEUED", stage: "Waiting to start", progress: 0, error: undefined });
    await wait(1000);
    patch(id, { status: "PROCESSING", stage: "Transcribing audio", progress: 0.3 });
    await wait(2000);
    patch(id, { stage: "Writing feedback", progress: 0.7 });
    await wait(2000);
    const r = reviews.get(id);
    if (!r) return;
    if (/fail/i.test(r.title) && !failedOnce.has(id)) {
      failedOnce.add(id);
      patch(id, { status: "FAILED", stage: undefined, progress: undefined, error: "Mock failure: no speech was found in the audio. Retry to see it succeed." });
      return;
    }
    const duration = r.durationSeconds ?? 240;
    patch(id, {
      status: "REVIEWED",
      stage: undefined,
      progress: undefined,
      transcript: sampleTranscript(duration),
      feedback: sampleFeedback(duration),
    });
  }

  function find(id: string): VideoReview {
    const r = reviews.get(id);
    if (!r) throw new ApiError("Review not found", 404);
    return r;
  }

  return {
    async listReviews() {
      await wait(300);
      return Array.from(reviews.values())
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .map(copy);
    },
    async getReview(id) {
      await wait(100);
      return copy(find(id));
    },
    async uploadFile(file, onProgress) {
      const problem = checkFile(file);
      if (problem) throw new ApiError(problem, 400);
      for (let p = 0.2; p <= 1; p += 0.2) {
        await wait(200);
        onProgress?.(Math.min(p, 1));
      }
      const fileKey = `mock-file-${nextId++}`;
      files.set(fileKey, { url: URL.createObjectURL(file), type: file.type });
      return { fileKey };
    },
    async createReview({ title, source, notes }) {
      await wait(300);
      if (!title.trim()) throw new ApiError("Add a round title.", 400);
      let videoUrl: string | undefined;
      let contentType: string | undefined;
      let durationSeconds: number | undefined;
      if (source.kind === "link") {
        if (!/^https?:\/\//i.test(source.url.trim())) throw new ApiError("That link isn't a valid http(s) URL.", 400);
        videoUrl = source.url.trim();
      } else {
        const stored = files.get(source.fileKey);
        if (!stored) throw new ApiError("The upload didn't complete. Try again.", 409);
        videoUrl = stored.url;
        contentType = stored.type;
        durationSeconds = source.durationSeconds;
      }
      const id = `review-${nextId++}`;
      reviews.set(id, {
        id,
        title: title.trim(),
        studentId: "student-1",
        studentName: MOCK_STUDENT,
        isOwn: true,
        createdAt: new Date().toISOString(),
        sourceKind: source.kind,
        videoUrl,
        contentType,
        durationSeconds,
        notes: notes?.trim() || undefined,
        status: "QUEUED",
      });
      void process(id);
      return copy(find(id));
    },
    async analyzeReview(id) {
      const r = find(id);
      if (r.status === "QUEUED" || r.status === "PROCESSING") throw new ApiError("This review is already being analysed.", 409);
      void process(id);
      return copy(find(id));
    },
    async deleteReview(id) {
      await wait(200);
      const r = find(id);
      if (r.sourceKind !== "link" && r.videoUrl) URL.revokeObjectURL(r.videoUrl);
      reviews.delete(id);
    },
  };
}

const MOCK_STUDENT = "Jordan Lee (sample student)";
let mockViewer: MockViewer = "student";

/** In-memory mock backend. Swap for `createHttpApi({ baseUrl })` to use a real one. */
export const mockApi: VideoReviewApi = createMockApi(() => mockViewer);

/** Mock only: choose whose view the mock serves (the App's Student / Teacher switch). */
export function setMockViewer(viewer: MockViewer) {
  mockViewer = viewer;
}


// ═══════════════════════════ 2. RECORDER ═══════════════════════════
// In-browser camera + mic recording: `useVideoRecorder()` (the logic) and
// `<VideoRecorder>` (Record → live preview with timer → Stop → play the take
// back → "Use this take" or record again).
// 
// Two things matter most here:
// - Every failure ends in a message that says what to do instead (blocked
// permission, no camera, camera busy, insecure page, no MediaRecorder).
// - The camera light goes off: every track is stopped on Stop, on discard,
// and on unmount, and a permission prompt answered after Cancel or after
// leaving the page never switches the camera on.

type Phase = "idle" | "starting" | "recording" | "review";

interface Clip {
  blob: Blob;
  /** Object URL for playback; owned and revoked by the hook. */
  url: string;
  /** Timed by the hook: MediaRecorder WebM files carry no duration header. */
  durationMs: number;
}

/** Best first. Chrome/Edge/Firefox record WebM; Safari only MP4. */
const MIME_CANDIDATES = ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm", "video/mp4"];

function pickMimeType(): string | undefined {
  return MIME_CANDIDATES.find((type) => {
    try {
      return MediaRecorder.isTypeSupported(type);
    } catch {
      return false;
    }
  });
}

/** "video/webm;codecs=vp9,opus" → "video/webm", which is what upload limits match on. */
function baseType(type: string): string {
  return type.split(";")[0].trim().toLowerCase();
}

export function formatClock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function describeMediaError(err: unknown): string {
  switch ((err as { name?: string } | null)?.name) {
    case "NotAllowedError":
    case "SecurityError":
      return "Camera and microphone access was blocked. Allow it in your browser's address bar and press Record again, or upload a file instead.";
    case "NotFoundError":
      return "No camera or microphone was found on this device. Film on your phone and upload the file instead.";
    case "NotReadableError":
      return "Your camera is in use by another app (Zoom, Meet…). Close it and try again, or upload a file instead.";
    default:
      return "The camera couldn't be opened. Try again, or upload a file instead.";
  }
}

function stopStream(stream: MediaStream | null) {
  stream?.getTracks().forEach((t) => t.stop());
}

export function useVideoRecorder({ maxDurationMs }: { maxDurationMs: number }) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [clip, setClip] = useState<Clip | null>(null);
  const [unavailable, setUnavailable] = useState<string | null>(null);

  const streamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const previewRef = useRef<HTMLVideoElement | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const startedAtRef = useRef(0);
  const timerRef = useRef<number | null>(null);
  const clipUrlRef = useRef<string | null>(null);
  // Bumped by every exit, so a getUserMedia that resolves late is dropped.
  const tokenRef = useRef(0);

  // Can this page record at all? navigator.mediaDevices is missing on http.
  useEffect(() => {
    if (!navigator.mediaDevices?.getUserMedia) {
      setUnavailable(
        window.isSecureContext
          ? "This browser won't open a camera from a web page."
          : "Recording needs a secure (https) page.",
      );
    } else if (typeof MediaRecorder === "undefined") {
      setUnavailable("This browser can't record video in the page.");
    }
  }, []);

  const clearTimer = useCallback(() => {
    if (timerRef.current) window.clearInterval(timerRef.current);
    timerRef.current = null;
  }, []);

  /** Stops the camera (the light goes off) and detaches the preview. */
  const releaseCamera = useCallback(() => {
    stopStream(streamRef.current);
    streamRef.current = null;
    if (previewRef.current) previewRef.current.srcObject = null;
  }, []);

  /** Callback ref for the live preview <video>; the stream may arrive before or after it mounts. */
  const setPreviewEl = useCallback((el: HTMLVideoElement | null) => {
    previewRef.current = el;
    if (el && streamRef.current) {
      el.srcObject = streamRef.current;
      void el.play().catch(() => {});
    }
  }, []);

  const start = useCallback(async () => {
    setError(null);
    setNotice(null);
    setPhase("starting");
    const token = ++tokenRef.current;

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "user", width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: true,
      });
    } catch (err) {
      if (tokenRef.current === token) {
        setPhase("idle");
        setError(describeMediaError(err));
      }
      return;
    }
    if (tokenRef.current !== token) return stopStream(stream); // cancelled while the prompt was open

    let recorder: MediaRecorder;
    try {
      const mimeType = pickMimeType();
      recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
    } catch {
      stopStream(stream);
      setPhase("idle");
      setError("This browser couldn't start a recording. Upload a video file instead.");
      return;
    }

    streamRef.current = stream;
    setPreviewEl(previewRef.current);
    recorderRef.current = recorder;
    chunksRef.current = [];

    recorder.ondataavailable = (e) => {
      if (e.data.size) chunksRef.current.push(e.data);
    };
    recorder.onstop = () => {
      clearTimer();
      releaseCamera();
      recorderRef.current = null;
      const blob = new Blob(chunksRef.current, { type: baseType(recorder.mimeType) || "video/webm" });
      chunksRef.current = [];
      if (!blob.size) {
        setPhase("idle");
        setError("That recording came back empty. Try again, or upload a file instead.");
        return;
      }
      if (clipUrlRef.current) URL.revokeObjectURL(clipUrlRef.current);
      clipUrlRef.current = URL.createObjectURL(blob);
      setClip({ blob, url: clipUrlRef.current, durationMs: Date.now() - startedAtRef.current });
      setPhase("review");
    };

    startedAtRef.current = Date.now();
    setElapsedMs(0);
    recorder.start(1000); // 1s chunks, so a long take never sits in one buffer
    setPhase("recording");
    timerRef.current = window.setInterval(() => {
      const ms = Date.now() - startedAtRef.current;
      setElapsedMs(ms);
      if (ms >= maxDurationMs && recorder.state === "recording") {
        setNotice(`Recording stopped at the ${Math.round(maxDurationMs / 60000)}-minute limit.`);
        recorder.stop();
      }
    }, 250);
  }, [clearTimer, maxDurationMs, releaseCamera, setPreviewEl]);

  const stop = useCallback(() => {
    tokenRef.current++;
    const recorder = recorderRef.current;
    if (recorder && recorder.state !== "inactive") recorder.stop(); // onstop keeps the take
    else {
      releaseCamera();
      setPhase("idle");
    }
  }, [releaseCamera]);

  /** Throw away whatever is live or recorded and go back to idle. */
  const discard = useCallback(() => {
    tokenRef.current++;
    clearTimer();
    const recorder = recorderRef.current;
    if (recorder && recorder.state !== "inactive") {
      recorder.onstop = null;
      recorder.stop();
    }
    recorderRef.current = null;
    releaseCamera();
    if (clipUrlRef.current) URL.revokeObjectURL(clipUrlRef.current);
    clipUrlRef.current = null;
    setClip(null);
    setError(null);
    setNotice(null);
    setPhase("idle");
  }, [clearTimer, releaseCamera]);

  // Leaving the page mid-take must not leave the camera on.
  useEffect(
    () => () => {
      tokenRef.current++;
      clearTimer();
      const recorder = recorderRef.current;
      if (recorder && recorder.state !== "inactive") {
        recorder.onstop = null;
        recorder.stop();
      }
      stopStream(streamRef.current);
      if (clipUrlRef.current) URL.revokeObjectURL(clipUrlRef.current);
    },
    [clearTimer],
  );

  return { phase, error, notice, elapsedMs, clip, unavailable, setPreviewEl, start, stop, discard };
}

/** A take as a File, so it goes down the same upload path as a chosen file. */
function clipToFile(blob: Blob, nameHint: string): File {
  const type = baseType(blob.type) || "video/webm";
  const slug = nameHint.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "recording";
  return new File([blob], `${slug}-${Date.now()}.${type === "video/mp4" ? "mp4" : "webm"}`, { type });
}

const darkButton =
  "inline-flex items-center gap-2 rounded-[3px] bg-[#1f2430] px-4 py-2 text-[13px] font-semibold text-white transition-colors hover:bg-[#2f3647] disabled:cursor-not-allowed disabled:opacity-40";

export function VideoRecorder({
  onKeep,
  nameHint = "recording",
  maxDurationMs = 15 * 60 * 1000,
}: {
  /** Called with the finished take and its length. */
  onKeep: (file: File, durationSeconds: number) => void;
  /** Used to name the file, e.g. the round title. */
  nameHint?: string;
  maxDurationMs?: number;
}) {
  const rec = useVideoRecorder({ maxDurationMs });

  if (rec.unavailable) {
    return (
      <div className="flex items-start gap-2.5 rounded-[3px] border border-[#c7c7c7] bg-[#f5f4f0] px-4 py-3">
        <CameraOff className="mt-0.5 h-4 w-4 flex-shrink-0 text-[#6b7280]" />
        <p className="text-[12.5px] leading-relaxed text-[#6b7280]">
          <span className="font-semibold text-[#1f2430]">Recording isn&apos;t available here.</span> {rec.unavailable} Go
          back and upload a file or paste a link instead.
        </p>
      </div>
    );
  }

  const live = rec.phase === "starting" || rec.phase === "recording";

  return (
    <div className="rounded-[3px] border border-[#c7c7c7] bg-[#f5f4f0] p-3">
      {rec.phase === "idle" && (
        <div className="flex flex-col items-center gap-2 px-2 py-3 text-center">
          <Camera className="h-5 w-5 text-[#ca8a04]" />
          <button type="button" onClick={rec.start} className={darkButton}>
            <span className="h-2.5 w-2.5 rounded-full bg-[#facc15]" /> Record
          </button>
          <p className="text-[11.5px] text-[#6b7280]">
            Uses this device&apos;s camera and mic. Your browser will ask for permission first.
          </p>
        </div>
      )}

      {live && (
        <div className="space-y-2">
          <div className="relative overflow-hidden rounded-[3px] border border-[#c7c7c7] bg-black">
            {/* Mirrored, like a selfie camera; the saved file is not. */}
            <video ref={rec.setPreviewEl} muted autoPlay playsInline className="mx-auto block max-h-[30vh] -scale-x-100" />
            {rec.phase === "starting" ? (
              <div className="absolute inset-0 flex items-center justify-center gap-2 bg-black/60 text-[12.5px] font-semibold text-white">
                <Loader2 className="h-4 w-4 animate-spin" /> Waiting for camera access…
              </div>
            ) : (
              <div className="absolute left-2 top-2 inline-flex items-center gap-1.5 rounded-[3px] bg-black/70 px-2 py-1 text-[11.5px] font-bold text-white">
                <span className="h-2 w-2 animate-pulse rounded-full bg-red-500" /> REC {formatClock(rec.elapsedMs)}
              </div>
            )}
          </div>
          <div className="flex items-center justify-between">
            <button type="button" onClick={rec.stop} disabled={rec.phase === "starting"} className={darkButton}>
              <Square className="h-3.5 w-3.5 fill-current" /> Stop
            </button>
            <button type="button" onClick={rec.discard} className="text-[12px] font-semibold text-[#6b7280] hover:text-[#1f2430]">
              Cancel
            </button>
          </div>
        </div>
      )}

      {rec.phase === "review" && rec.clip && (
        <div className="space-y-2">
          <video src={rec.clip.url} controls playsInline className="mx-auto block max-h-[30vh] rounded-[3px] bg-black" />
          <p className="text-[11.5px] text-[#6b7280]">Your take · {formatClock(rec.clip.durationMs)}. The camera is off.</p>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              className={darkButton}
              onClick={() => {
                const { blob, durationMs } = rec.clip!;
                onKeep(clipToFile(blob, nameHint), durationMs / 1000);
                rec.discard();
              }}
            >
              <Check className="h-3.5 w-3.5" /> Use this take
            </button>
            <button
              type="button"
              onClick={rec.discard}
              className="inline-flex items-center gap-2 rounded-[3px] border border-[#c7c7c7] bg-white px-3 py-2 text-[12.5px] font-semibold text-[#6b7280] hover:border-[#ca8a04] hover:text-[#1f2430]"
            >
              <RotateCcw className="h-3.5 w-3.5" /> Record again
            </button>
          </div>
        </div>
      )}

      {rec.notice && (
        <p className="mt-2 rounded-[3px] border border-[#fde68a] bg-[#fefce8] px-3 py-2 text-[12px] text-[#a16207]">{rec.notice}</p>
      )}
      {rec.error && (
        <p className="mt-2 rounded-[3px] border border-red-200 bg-red-50 px-3 py-2 text-[12px] leading-relaxed text-red-700">{rec.error}</p>
      )}
    </div>
  );
}


// ═══════════════════════════ 3. THE TOOL ═══════════════════════════
// Video Review: a student submits a debate speech (record it here, upload a
// file, or paste a link) and gets AI feedback: an overall grade, category
// grades, and timestamped strengths / improvements they step through while the
// video jumps to each moment. A teacher sees their students' reviews, read-only.
// 
// <VideoReviewTool api={mockApi} role="student" />
// 
// Three screens, none of which scrolls the page at 1280×720 (give the
// component a container with a height, e.g. h-screen):
// list    → the reviews, newest first
// submit  → one question per screen: title → how → the video → notes
// review  → the player (left) beside the feedback, one item at a time (right)
// 
// All data goes through the `api` prop (see api.ts). Nothing here knows about
// auth, routing or storage.

type Review = VideoReview;

export type Role = "student" | "teacher";

// ───────────────────────── look ─────────────────────────
// Light page; the player and the grade card are the two dark panels.
const C = {
  ink: "#1f2430",
  accentBright: "#facc15",
  dark: "#0f1729",
  darkSoft: "#182236",
  darkLine: "#27324a",
  darkInk: "#e8ecf5",
  darkMuted: "#8d99b4",
  good: "#4ade80",
  warn: "#facc15",
} as const;

const primaryBtn =
  "inline-flex items-center justify-center gap-1.5 rounded-[6px] bg-[#facc15] px-5 py-2.5 text-[14.5px] font-bold text-[#1f2430] shadow-[0_2px_0_#ca8a04] transition-colors hover:bg-[#eab308] disabled:cursor-not-allowed disabled:bg-[#f0efea] disabled:text-[#9ca3af] disabled:shadow-none";
const ghostBtn =
  "inline-flex items-center gap-1 rounded-[6px] px-3 py-2.5 text-[13.5px] font-semibold text-[#6b7280] transition-colors hover:bg-[#f5f4f0] disabled:cursor-not-allowed disabled:opacity-40";
const backLink = "inline-flex flex-shrink-0 items-center gap-1.5 text-[13px] font-medium text-[#6b7280] transition-colors hover:text-[#ca8a04]";

// ───────────────────────── helpers ─────────────────────────

/** The one score scale: 1–10 → the letter a judge would write. */
const GRADES: ReadonlyArray<readonly [number, string]> = [
  [9.3, "A+"], [8.7, "A"], [8.3, "A-"], [7.7, "B+"], [7.3, "B"], [6.7, "B-"],
  [6.3, "C+"], [5.7, "C"], [5.3, "C-"], [4.7, "D+"], [4.0, "D"],
];
export function letterGrade(score: number): string {
  return GRADES.find(([min]) => score >= min)?.[1] ?? "E";
}

function fmtClock(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** "1:05" → { start: 65, end: null }; "1:05-1:22" → { start: 65, end: 82 }. */
function parseRange(text: string | undefined): { start: number | null; end: number | null } {
  const times = (text ?? "").match(/\d+:\d{2}/g) ?? [];
  const secs = times.map((t) => {
    const [m, s] = t.split(":").map(Number);
    return m * 60 + s;
  });
  return { start: secs[0] ?? null, end: secs[1] ?? null };
}

function youTubeId(url: string | undefined): string | null {
  const m = url?.match(/(?:youtube\.com\/(?:watch\?v=|embed\/|live\/|shorts\/)|youtu\.be\/)([A-Za-z0-9_-]{6,})/);
  return m ? m[1] : null;
}

/** A URL a plain <video> can play: a stored file, or a link straight to a media file. */
function directMediaUrl(r: Review): string | null {
  if (!r.videoUrl) return null;
  if (r.sourceKind !== "link") return r.videoUrl;
  return /\.(mp4|webm|ogg|mov|m4v|mp3|m4a|wav)(\?.*)?$/i.test(r.videoUrl) ? r.videoUrl : null;
}

const isProcessing = (r: Review) => r.status === "QUEUED" || r.status === "PROCESSING";

/** The feedback step that shows note `key` (step 0 is the overview). */
const stepOfNote = (key: number) => key + 1;

interface Note {
  /** Position in time order across the whole review. */
  key: number;
  /** Index of the section it belongs to. */
  section: number;
  good: boolean;
  time: string;
  text: string;
  start: number | null;
}

/** Every strength and improvement, in time order. */
function buildNotes(fb: VideoFeedback): Note[] {
  const out: Omit<Note, "key">[] = [];
  fb.sections.forEach((sec, section) => {
    sec.strengths.forEach((n) => out.push({ section, good: true, ...n, start: parseRange(n.time).start }));
    sec.improvements.forEach((n) => out.push({ section, good: false, ...n, start: parseRange(n.time).start }));
  });
  out.sort((a, b) => (a.start ?? 1e9) - (b.start ?? 1e9));
  return out.map((n, key) => ({ ...n, key }));
}

/** The note the playhead is on: the last one whose moment has passed. */
function currentNoteKey(notes: Note[], t: number): number | null {
  let last: number | null = null;
  for (const n of notes) {
    if (n.start == null) continue;
    if (n.start <= t + 0.4) last = n.key;
    else break;
  }
  return last;
}

/** Plain-text export for "Download notes". */
function notesText(r: Review, fb: VideoFeedback): string {
  const lines = [r.title, `Overall: ${letterGrade(fb.score)} (${fb.score.toFixed(1)}/10)`];
  fb.scoreBreakdown.forEach((c) => lines.push(`  ${c.name}: ${letterGrade(c.value)} (${c.value.toFixed(1)})`));
  if (fb.scoreSummary) lines.push("", fb.scoreSummary);
  fb.sections.forEach((sec) => {
    lines.push("", `${sec.title.toUpperCase()}  ${sec.range}`);
    if (sec.speakingTips) lines.push(`  Speaking tips: ${sec.speakingTips}`);
    sec.strengths.forEach((n) => lines.push(`  + ${n.time}  ${n.text}`));
    sec.improvements.forEach((n) => lines.push(`  ! ${n.time}  ${n.text}`));
  });
  return lines.join("\n");
}

function download(fileName: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "text/plain;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  a.click();
  URL.revokeObjectURL(url);
}

// ───────────────────────── the tool ─────────────────────────

type Notice = { text: string; tone: "info" | "error" } | null;

export function VideoReviewTool({ api, role }: { api: VideoReviewApi; role: Role }) {
  const isTeacher = role === "teacher";
  const [reviews, setReviews] = useState<Review[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [view, setView] = useState<"list" | "submit" | "review">("list");
  const [openId, setOpenId] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice>(null);

  const current = reviews.find((r) => r.id === openId) ?? null;

  const upsert = useCallback((review: Review) => {
    setReviews((prev) =>
      prev.some((r) => r.id === review.id) ? prev.map((r) => (r.id === review.id ? review : r)) : [review, ...prev],
    );
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      setReviews(await api.listReviews());
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "Couldn't load reviews.");
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => {
    void load();
  }, [load]);

  // Poll every review that is still being analysed until it settles.
  const processingIds = reviews.filter(isProcessing).map((r) => r.id).join(",");
  useEffect(() => {
    if (!processingIds) return;
    const timer = window.setInterval(() => {
      for (const id of processingIds.split(",")) api.getReview(id).then(upsert).catch(() => {});
    }, 3000);
    return () => window.clearInterval(timer);
  }, [api, processingIds, upsert]);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), 6000);
    return () => window.clearTimeout(timer);
  }, [notice]);

  function open(id: string) {
    setOpenId(id);
    setView("review");
    // Stored-file URLs are short-lived; fetch a fresh one on open.
    api.getReview(id).then(upsert).catch(() => {});
  }

  async function remove(id: string) {
    try {
      await api.deleteReview(id);
      setReviews((prev) => prev.filter((r) => r.id !== id));
      if (openId === id) setView("list");
    } catch (e) {
      setNotice({ text: e instanceof Error ? e.message : "Couldn't remove that review.", tone: "error" });
    }
  }

  async function retry(id: string) {
    try {
      upsert(await api.analyzeReview(id));
    } catch (e) {
      setNotice({ text: e instanceof Error ? e.message : "Couldn't restart the analysis.", tone: "error" });
    }
  }

  /** Uploads (if a file), creates the review and opens it. Throws a user-facing Error on failure. */
  async function submit(input: SubmitInput, onProgress: (fraction: number) => void) {
    let source: ReviewSource;
    if (input.source.kind === "link") {
      source = { kind: "link", url: input.source.url.trim() };
    } else {
      const { kind, file, durationSeconds } = input.source;
      const problem = checkFile(file);
      if (problem) throw new Error(problem);
      if (durationSeconds && durationSeconds > LIMITS.maxDurationSeconds) {
        throw new Error(`That video is too long. The limit is ${LIMITS.maxDurationSeconds / 60} minutes.`);
      }
      const { fileKey } = await api.uploadFile(file, onProgress);
      source = { kind, fileKey, contentType: file.type, durationSeconds };
    }
    const review = await api.createReview({ title: input.title.trim(), source, notes: input.notes.trim() || undefined });
    upsert(review);
    setOpenId(review.id);
    setView("review");
    setNotice({ text: "Submitted. Your feedback is being written.", tone: "info" });
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 bg-[#f5f4f0] p-4 md:p-6">
      <header className="flex flex-shrink-0 flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-[22px] font-extrabold text-[#1f2430]">Video Review</h1>
          <p className="text-[13px] text-[#6b7280]">
            {isTeacher ? "Your students' submitted speeches and their feedback." : "Submit a speech and get it reviewed."}
          </p>
        </div>
        {notice && (
          <p
            role="status"
            className={`rounded-[3px] border px-3 py-1.5 text-[12.5px] font-semibold ${
              notice.tone === "error" ? "border-red-200 bg-red-50 text-red-700" : "border-[#fde68a] bg-[#fefce8] text-[#a16207]"
            }`}
          >
            {notice.text}
          </p>
        )}
      </header>

      <div className="flex min-h-0 flex-1 flex-col">
        {view === "submit" && !isTeacher ? (
          <SubmitFlow onCancel={() => setView("list")} onSubmit={submit} />
        ) : view === "review" && current ? (
          <ReviewScreen
            key={current.id}
            review={current}
            onBack={() => setView("list")}
            onRetry={() => retry(current.id)}
          />
        ) : (
          <ListView
            reviews={reviews}
            isTeacher={isTeacher}
            loading={loading}
            error={loadError}
            onReload={load}
            onNew={() => setView("submit")}
            onOpen={open}
            onRemove={remove}
          />
        )}
      </div>
    </div>
  );
}

// ───────────────────────── list ─────────────────────────

function ListView({
  reviews,
  isTeacher,
  loading,
  error,
  onReload,
  onNew,
  onOpen,
  onRemove,
}: {
  reviews: Review[];
  isTeacher: boolean;
  loading: boolean;
  error: string | null;
  onReload: () => void;
  onNew: () => void;
  onOpen: (id: string) => void;
  onRemove: (id: string) => void;
}) {
  const label = isTeacher ? "Your students' reviews" : "Your reviews";
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      {!isTeacher && (
        <button type="button" onClick={onNew} className={`${primaryBtn} self-end`}>
          <Plus className="h-4 w-4" /> Submit a speech
        </button>
      )}
      <section className="flex min-h-[320px] flex-1 flex-col overflow-hidden rounded-[3px] border border-[#e0e0e0] bg-white">
        <div className="flex-shrink-0 border-b border-[#e0e0e0] px-4 py-3 text-[12px] font-extrabold uppercase tracking-wide text-[#ca8a04]">
          {label}
          {!loading && !error ? ` · ${reviews.length}` : ""}
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-3">
          {loading ? (
            <Centered>
              <Loader2 className="h-5 w-5 animate-spin text-[#ca8a04]" />
              <p className="text-[13px] text-[#6b7280]">Loading reviews…</p>
            </Centered>
          ) : error ? (
            <Centered>
              <AlertTriangle className="h-6 w-6 text-[#ca8a04]" />
              <p className="text-base font-extrabold text-[#1f2430]">Couldn&apos;t load reviews</p>
              <p className="max-w-[420px] text-[13px] text-[#6b7280]">{error}</p>
              <button type="button" onClick={onReload} className={ghostBtn}>
                <RotateCcw className="h-3.5 w-3.5" /> Try again
              </button>
            </Centered>
          ) : reviews.length === 0 ? (
            <Centered>
              <Film className="h-6 w-6 text-[#ca8a04]" />
              <p className="text-base font-extrabold text-[#1f2430]">No reviews yet</p>
              <p className="max-w-[360px] text-[13px] text-[#6b7280]">
                {isTeacher
                  ? "When a student in one of your classes submits a speech, it shows up here."
                  : "Submit a speech and its review shows up here."}
              </p>
            </Centered>
          ) : (
            <div className="grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fill,minmax(300px,1fr))" }}>
              {reviews.map((r) => (
                <ReviewCard key={r.id} review={r} onOpen={() => onOpen(r.id)} onRemove={() => onRemove(r.id)} />
              ))}
            </div>
          )}
        </div>
      </section>
    </div>
  );
}

function Centered({ children }: { children: ReactNode }) {
  return <div className="flex h-full flex-col items-center justify-center gap-2 px-6 py-10 text-center">{children}</div>;
}

function ReviewCard({ review, onOpen, onRemove }: { review: Review; onOpen: () => void; onRemove: () => void }) {
  const yt = youTubeId(review.videoUrl);
  const badge = review.feedback
    ? { text: `Grade ${letterGrade(review.feedback.score)}`, cls: "border-[#fde68a] bg-[#fefce8] text-[#a16207]" }
    : review.status === "FAILED"
      ? { text: "Analysis failed", cls: "border-red-200 bg-red-50 text-red-700" }
      : { text: "Analyzing…", cls: "border-[#e0e0e0] text-[#6b7280]" };
  return (
    <div className="relative flex min-w-0">
      <button
        type="button"
        onClick={onOpen}
        className="flex min-w-0 flex-1 items-center gap-3 rounded-[3px] border border-[#e0e0e0] bg-white p-3 text-left transition-colors hover:border-[#ca8a04]/50"
      >
        <span className="grid h-[46px] w-[72px] flex-shrink-0 place-items-center overflow-hidden rounded-[3px] bg-[#f5f4f0] text-[#6b7280]">
          {yt ? <img src={`https://img.youtube.com/vi/${yt}/mqdefault.jpg`} alt="" className="h-full w-full object-cover" /> : <Play className="h-5 w-5" />}
        </span>
        <span className="flex min-w-0 flex-1 flex-col gap-1 pr-7">
          <span className="truncate text-[14.5px] font-bold text-[#1f2430]">{review.title}</span>
          <span className="truncate text-[12px] text-[#6b7280]">
            {[review.studentName, new Date(review.createdAt).toLocaleDateString()].join(" · ")}
          </span>
          <span className={`mt-0.5 self-start rounded-[3px] border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ${badge.cls}`}>
            {badge.text}
          </span>
        </span>
      </button>
      {review.isOwn && (
        <span className="absolute right-2 top-2">
          <RemoveControl onConfirm={onRemove} />
        </span>
      )}
    </div>
  );
}

/** Two-press remove: the second press confirms. Disarms itself after 6 seconds. */
function RemoveControl({ onConfirm }: { onConfirm: () => void }) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const timer = window.setTimeout(() => setArmed(false), 6000);
    return () => window.clearTimeout(timer);
  }, [armed]);

  if (!armed) {
    return (
      <button
        type="button"
        onClick={() => setArmed(true)}
        aria-label="Remove review"
        className="grid h-[26px] w-[26px] place-items-center rounded-[3px] border border-[#e0e0e0] bg-white text-[#6b7280] hover:border-red-200 hover:bg-red-50 hover:text-red-600"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 rounded-[3px] border border-red-200 bg-red-50 px-2 py-1 text-[11px] font-bold text-red-700">
      Remove?
      <button type="button" onClick={onConfirm} className="underline underline-offset-2">
        Yes
      </button>
      <button type="button" onClick={() => setArmed(false)} className="font-semibold text-[#6b7280]">
        No
      </button>
    </span>
  );
}

// ───────────────────────── submit flow ─────────────────────────

type ChosenSource =
  | { kind: "record" | "upload"; file: File; durationSeconds?: number }
  | { kind: "link"; url: string };

interface SubmitInput {
  title: string;
  source: ChosenSource;
  notes: string;
}

type Route = ChosenSource["kind"];

const ROUTES: { value: Route; label: string; detail: string; icon: ReactNode }[] = [
  { value: "record", label: "Record it now", detail: "With this device's camera", icon: <Camera className="h-4 w-4" /> },
  { value: "upload", label: "Upload a file", detail: "A video or audio file", icon: <Upload className="h-4 w-4" /> },
  { value: "link", label: "Paste a link", detail: "YouTube or a video URL", icon: <Link2 className="h-4 w-4" /> },
];

const VIDEO_PROMPT: Record<Route, { prompt: string; detail: string }> = {
  record: { prompt: "Record your speech.", detail: "It's saved with your round, for you and your teacher." },
  upload: { prompt: "Choose the file.", detail: `Up to ${Math.round(LIMITS.maxBytes / 1024 / 1024)} MB and ${LIMITS.maxDurationSeconds / 60} minutes.` },
  link: { prompt: "Paste the link.", detail: "YouTube links play right beside the feedback." },
};

function SubmitFlow({
  onCancel,
  onSubmit,
}: {
  onCancel: () => void;
  onSubmit: (input: SubmitInput, onProgress: (fraction: number) => void) => Promise<void>;
}) {
  // Every answer lives here, so a failed submit loses nothing.
  const [title, setTitle] = useState("");
  const [route, setRoute] = useState<Route | null>(null);
  const [source, setSource] = useState<ChosenSource | null>(null);
  const [notes, setNotes] = useState("");
  const [index, setIndex] = useState(0);
  const [saving, setSaving] = useState<{ label: string; progress: number | null } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const linkOk = source?.kind !== "link" || /^https?:\/\/\S+$/i.test(source.url.trim());

  const steps: FlowStep[] = [
    {
      eyebrow: "Your round",
      prompt: "What round is this?",
      ready: title.trim().length > 0,
      body: (
        <input
          autoFocus
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          aria-label="Round title"
          placeholder="e.g. Round 3 vs. Westfield: Con"
          className="w-full rounded-[6px] border-2 border-[#e0e0e0] bg-white px-4 py-3 text-[16px] text-[#1f2430] outline-none placeholder:text-[#9ca3af] focus:border-[#ca8a04]"
        />
      ),
    },
    {
      eyebrow: "The speech",
      prompt: "How will you add it?",
      ready: route !== null,
      body: (
        <div role="radiogroup" aria-label="How will you add it?" className="grid gap-2.5 sm:grid-cols-3">
          {ROUTES.map((r) => {
            const picked = route === r.value;
            return (
              <button
                key={r.value}
                type="button"
                role="radio"
                aria-checked={picked}
                onClick={() => {
                  setRoute(r.value);
                  if (source?.kind !== r.value) setSource(null);
                }}
                className={`flex flex-col items-start gap-1 rounded-[6px] border-2 px-4 py-3 text-left transition-colors ${
                  picked ? "border-[#ca8a04] bg-[#fefce8] ring-1 ring-[#ca8a04]" : "border-[#e0e0e0] bg-white hover:border-[#ca8a04]/60"
                }`}
              >
                <span className="text-[#ca8a04]">{r.icon}</span>
                <span className="text-[15px] font-semibold text-[#1f2430]">{r.label}</span>
                <span className="text-[13px] text-[#6b7280]">{r.detail}</span>
              </button>
            );
          })}
        </div>
      ),
    },
    {
      eyebrow: "The speech",
      prompt: VIDEO_PROMPT[route ?? "record"].prompt,
      detail: VIDEO_PROMPT[route ?? "record"].detail,
      ready: !!source && linkOk,
      body: route && <SourceInput kind={route} value={source} onChange={setSource} nameHint={title} />,
    },
    {
      eyebrow: "Notes",
      prompt: "Anything the reviewer should know?",
      detail: "Optional: your side, which speech this is, what you want feedback on.",
      ready: true,
      body: (
        <textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          rows={4}
          aria-label="Notes for the reviewer"
          placeholder="e.g. Second speaker on Con. I want feedback on my weighing."
          className="w-full resize-none rounded-[6px] border-2 border-[#e0e0e0] bg-white px-4 py-3 text-[14.5px] leading-relaxed text-[#1f2430] outline-none placeholder:text-[#9ca3af] focus:border-[#ca8a04]"
        />
      ),
    },
  ];

  async function finish() {
    if (!source) return;
    setError(null);
    setSaving({ label: source.kind === "link" ? "Saving your round…" : "Uploading your video…", progress: source.kind === "link" ? null : 0 });
    try {
      await onSubmit({ title, source, notes }, (progress) => setSaving({ label: "Uploading your video…", progress }));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't save this round. Try again.");
      setSaving(null);
    }
  }

  return (
    <StepFrame
      title="Submit a speech"
      steps={steps}
      index={index}
      finishLabel="Submit for review"
      error={error}
      exit={
        <button type="button" onClick={onCancel} className={backLink}>
          <ArrowLeft className="h-3.5 w-3.5" /> Your reviews
        </button>
      }
      onBack={() => setIndex((i) => Math.max(0, i - 1))}
      onNext={() => (index < steps.length - 1 ? setIndex(index + 1) : void finish())}
      overlay={saving && <SavingScreen label={saving.label} progress={saving.progress} />}
    />
  );
}

interface FlowStep {
  eyebrow: string;
  prompt: string;
  detail?: string;
  /** Whether Continue is enabled. */
  ready: boolean;
  body: ReactNode;
}

/**
 * A minimal one-question-per-screen frame: top bar (way out, progress, "x of
 * n"), the question centred, and Back / Continue at the bottom. Enter presses
 * Continue (Ctrl/⌘+Enter inside a textarea).
 */
function StepFrame({
  title,
  steps,
  index,
  finishLabel,
  error,
  exit,
  onBack,
  onNext,
  overlay,
}: {
  title: string;
  steps: FlowStep[];
  index: number;
  finishLabel: string;
  error: string | null;
  exit: ReactNode;
  onBack: () => void;
  onNext: () => void;
  /** Replaces the step (and hides the buttons) while saving. */
  overlay?: ReactNode;
}) {
  const step = steps[index];
  const isLast = index === steps.length - 1;
  const canNext = step.ready && !overlay;

  const nextRef = useRef(onNext);
  nextRef.current = canNext ? onNext : () => {};
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Enter" || e.shiftKey || e.isComposing) return;
      const el = e.target as HTMLElement;
      if (el.tagName === "BUTTON" || el.tagName === "A") return; // Enter already clicks those
      if (el.tagName === "TEXTAREA" && !(e.metaKey || e.ctrlKey)) return;
      e.preventDefault();
      nextRef.current();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  return (
    <section aria-label={title} className="flex min-h-[480px] flex-1 flex-col overflow-hidden rounded-[3px] border border-[#e0e0e0] bg-white">
      <header className="flex flex-shrink-0 items-center gap-4 border-b border-[#e0e0e0] px-4 py-3 md:px-5">
        {exit}
        <span className="hidden flex-shrink-0 text-[12px] font-bold uppercase tracking-widest text-[#6b7280] md:inline">{title}</span>
        <Segments total={steps.length} index={overlay ? steps.length : index} />
        <span className="flex-shrink-0 text-[12.5px] font-semibold tabular-nums text-[#6b7280]">
          {Math.min(index + 1, steps.length)} of {steps.length}
        </span>
      </header>

      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-5 py-6 md:px-10">
        <div className="my-auto w-full">
          {overlay || (
            <div className="mx-auto flex w-full max-w-[680px] flex-col gap-5">
              <div className="space-y-2">
                <p className="text-[11px] font-bold uppercase tracking-widest text-[#ca8a04]">{step.eyebrow}</p>
                <h2 className="text-[22px] font-semibold leading-snug text-[#1f2430] md:text-[24px]">{step.prompt}</h2>
                {step.detail && <p className="text-[14px] text-[#6b7280]">{step.detail}</p>}
              </div>
              {step.body}
            </div>
          )}
        </div>
      </div>

      {!overlay && (
        <footer className="flex flex-shrink-0 items-center justify-between gap-3 border-t border-[#e0e0e0] px-4 py-3.5 md:px-6">
          <div className="min-w-0 flex-1">
            {error ? (
              <p role="alert" className="text-[13px] font-semibold text-red-700">
                {error}
              </p>
            ) : (
              index > 0 && (
                <button type="button" onClick={onBack} className={ghostBtn}>
                  <ChevronLeft className="h-4 w-4" /> Back
                </button>
              )
            )}
          </div>
          <button type="button" onClick={onNext} disabled={!canNext} className={`${primaryBtn} min-w-[132px]`}>
            {isLast ? finishLabel : "Continue"} <ChevronRight className="h-4 w-4" />
          </button>
        </footer>
      )}
    </section>
  );
}

/** Progress segments: done dark-yellow, current bright yellow, ahead grey. */
function Segments({ total, index }: { total: number; index: number }) {
  return (
    <div role="progressbar" aria-valuemin={1} aria-valuemax={total} aria-valuenow={Math.min(index + 1, total)} className="flex min-w-0 flex-1 gap-1">
      {Array.from({ length: total }, (_, i) => (
        <span
          key={i}
          className={`h-2.5 flex-1 rounded-full transition-colors ${i === index ? "bg-[#facc15]" : i < index ? "bg-[#ca8a04]" : "bg-[#ecebe6]"}`}
        />
      ))}
    </div>
  );
}

function SavingScreen({ label, progress }: { label: string; progress: number | null }) {
  const pct = progress == null ? null : Math.round(progress * 100);
  return (
    <div role="status" aria-live="polite" className="flex flex-col items-center gap-3 text-center">
      <Loader2 className="h-6 w-6 animate-spin text-[#ca8a04]" />
      <p className="text-[16px] font-semibold text-[#1f2430]">{label}</p>
      {pct != null && <ProgressBar pct={pct} />}
    </div>
  );
}

function ProgressBar({ pct }: { pct: number }) {
  return (
    <div className="w-full max-w-[320px]">
      <div className="h-1.5 overflow-hidden rounded-full bg-[#f0efea]">
        <div className="h-full bg-[#facc15] transition-[width]" style={{ width: `${pct}%` }} />
      </div>
      <p className="mt-1 text-[12px] text-[#6b7280]">{pct}%</p>
    </div>
  );
}

/** The input for the chosen route: the camera, a file picker, or a link field. */
function SourceInput({
  kind,
  value,
  onChange,
  nameHint,
}: {
  kind: Route;
  value: ChosenSource | null;
  onChange: (value: ChosenSource | null) => void;
  nameHint: string;
}) {
  if (value && value.kind !== "link") {
    return (
      <div className="space-y-2">
        <FilePreview
          file={value.file}
          // An upload's length is read from the file here; a recording's comes from the recorder.
          onDuration={(d) => {
            if (value.kind === "upload" && !value.durationSeconds) onChange({ ...value, durationSeconds: d });
          }}
        />
        <div className="flex items-center justify-center gap-3 text-[12.5px]">
          <span className="min-w-0 truncate text-[#6b7280]">{kind === "record" ? "Your recording" : value.file.name}</span>
          <button type="button" onClick={() => onChange(null)} className="inline-flex items-center gap-1 font-semibold text-[#6b7280] hover:text-[#1f2430]">
            <RotateCcw className="h-3.5 w-3.5" /> {kind === "record" ? "Record another take" : "Choose another"}
          </button>
        </div>
      </div>
    );
  }

  if (kind === "record") {
    return (
      <VideoRecorder
        nameHint={nameHint}
        maxDurationMs={LIMITS.maxDurationSeconds * 1000}
        onKeep={(file, durationSeconds) => onChange({ kind: "record", file, durationSeconds })}
      />
    );
  }

  if (kind === "upload") {
    return (
      <label className="flex cursor-pointer flex-col items-center gap-2 rounded-[6px] border-2 border-dashed border-[#c7c7c7] bg-white px-6 py-8 text-center transition-colors hover:border-[#ca8a04] hover:bg-[#fefce8]/50">
        <Upload className="h-6 w-6 text-[#ca8a04]" />
        <span className="text-[15px] font-semibold text-[#1f2430]">Choose a video or audio file</span>
        <input
          type="file"
          accept={LIMITS.contentTypes.join(",")}
          className="sr-only"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) onChange({ kind: "upload", file });
          }}
        />
      </label>
    );
  }

  const url = value?.kind === "link" ? value.url : "";
  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2 rounded-[6px] border-2 border-[#e0e0e0] bg-white px-3 focus-within:border-[#ca8a04]">
        <Link2 className="h-4 w-4 flex-shrink-0 text-[#6b7280]" />
        <input
          autoFocus
          value={url}
          onChange={(e) => onChange(e.target.value.trim() ? { kind: "link", url: e.target.value } : null)}
          aria-label="Video link"
          placeholder="https://youtube.com/watch?v=…"
          className="min-w-0 flex-1 bg-transparent py-3 text-[15px] text-[#1f2430] outline-none placeholder:text-[#9ca3af]"
        />
      </div>
      {url && !/^https?:\/\/\S+$/i.test(url.trim()) && <p className="text-[12px] text-red-700">Paste a full link starting with https://</p>}
    </div>
  );
}

/** Plays back a chosen or recorded file; owns (and revokes) its object URL. */
function FilePreview({ file, onDuration }: { file: File; onDuration: (seconds: number) => void }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    const next = URL.createObjectURL(file);
    setUrl(next);
    return () => URL.revokeObjectURL(next);
  }, [file]);
  if (!url) return null;
  const report = (e: SyntheticEvent<HTMLMediaElement>) => {
    const d = e.currentTarget.duration;
    if (Number.isFinite(d) && d > 0) onDuration(d);
  };
  if (file.type.startsWith("audio/")) return <audio src={url} controls onLoadedMetadata={report} className="w-full" />;
  return (
    <video
      src={url}
      controls
      playsInline
      preload="metadata"
      onLoadedMetadata={report}
      className="mx-auto block max-h-[30vh] max-w-full rounded-[3px] border border-[#e0e0e0] bg-black"
    />
  );
}

// ───────────────────────── player ─────────────────────────
// One interface over three sources: a YouTube embed, a plain <video> (stored
// file or direct media link), or — when nothing can be played — a clock, so
// the notes can still be stepped through against time.

type PlayerMode = "youtube" | "file" | "clock";

interface YTPlayer {
  playVideo(): void;
  pauseVideo(): void;
  seekTo(seconds: number, allowSeekAhead: boolean): void;
  getCurrentTime(): number;
  getDuration(): number;
  getPlayerState(): number;
  destroy(): void;
}
type YTWindow = Window & {
  YT?: { Player: new (id: string, options: object) => YTPlayer };
  onYouTubeIframeAPIReady?: () => void;
};

function loadYouTubeApi(onReady: () => void) {
  const w = window as YTWindow;
  if (w.YT?.Player) return onReady();
  const previous = w.onYouTubeIframeAPIReady;
  w.onYouTubeIframeAPIReady = () => {
    previous?.();
    onReady();
  };
  if (!document.getElementById("yt-iframe-api")) {
    const s = document.createElement("script");
    s.id = "yt-iframe-api";
    s.src = "https://www.youtube.com/iframe_api";
    document.head.appendChild(s);
  }
}

function usePlayer(mode: PlayerMode, ytId: string | null, mountId: string, onTime: (t: number) => void) {
  const [playing, setPlaying] = useState(false);
  const [duration, setDuration] = useState<number | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const ytRef = useRef<YTPlayer | null>(null);
  const clockRef = useRef(0);
  const onTimeRef = useRef(onTime);
  onTimeRef.current = onTime;

  // YouTube: create the embed, then read its time 4× a second while it plays.
  useEffect(() => {
    if (mode !== "youtube" || !ytId) return;
    let cancelled = false;
    let timer = 0;
    loadYouTubeApi(() => {
      const YT = (window as YTWindow).YT;
      if (cancelled || !YT || !document.getElementById(mountId)) return;
      ytRef.current = new YT.Player(mountId, {
        videoId: ytId,
        playerVars: { rel: 0, playsinline: 1, modestbranding: 1 },
        events: {
          onReady: () => setDuration(ytRef.current?.getDuration() || null),
          onStateChange: (e: { data: number }) => setPlaying(e.data === 1),
        },
      });
      timer = window.setInterval(() => {
        const p = ytRef.current;
        if (p?.getPlayerState?.() === 1) onTimeRef.current(p.getCurrentTime());
      }, 250);
    });
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      ytRef.current?.destroy();
      ytRef.current = null;
    };
  }, [mode, ytId, mountId]);

  // Clock: advance a fake playhead while "playing".
  useEffect(() => {
    if (mode !== "clock" || !playing) return;
    const timer = window.setInterval(() => {
      clockRef.current += 0.25;
      onTimeRef.current(clockRef.current);
    }, 250);
    return () => window.clearInterval(timer);
  }, [mode, playing]);

  const controls = useMemo(
    () => ({
      play() {
        if (mode === "youtube") ytRef.current?.playVideo();
        else if (mode === "file") void videoRef.current?.play();
        else setPlaying(true);
      },
      pause() {
        if (mode === "youtube") ytRef.current?.pauseVideo();
        else if (mode === "file") videoRef.current?.pause();
        else setPlaying(false);
      },
      /** Jump to `s` seconds and play from there. */
      seek(s: number) {
        onTimeRef.current(s);
        if (mode === "youtube") {
          ytRef.current?.seekTo(s, true);
          ytRef.current?.playVideo();
        } else if (mode === "file" && videoRef.current) {
          videoRef.current.currentTime = s;
          void videoRef.current.play();
        } else {
          clockRef.current = s;
          setPlaying(true);
        }
      },
    }),
    [mode],
  );

  /** Props for the <video> element in "file" mode. */
  const videoProps = {
    ref: videoRef,
    onPlay: () => setPlaying(true),
    onPause: () => setPlaying(false),
    onTimeUpdate: (e: SyntheticEvent<HTMLVideoElement>) => onTimeRef.current(e.currentTarget.currentTime),
    onLoadedMetadata: (e: SyntheticEvent<HTMLVideoElement>) => {
      const d = e.currentTarget.duration;
      if (Number.isFinite(d)) setDuration(d);
    },
  };

  return { playing, duration, videoProps, ...controls };
}

// ───────────────────────── review screen ─────────────────────────

type FeedbackStep = { kind: "overview" } | { kind: "note"; note: Note } | { kind: "summary" } | { kind: "next" } | { kind: "tips" };

function ReviewScreen({ review, onBack, onRetry }: { review: Review; onBack: () => void; onRetry: () => void }) {
  const fb = review.feedback;
  const notes = useMemo(() => (fb ? buildNotes(fb) : []), [fb]);

  // The feedback, one screen each: grade, every note in time order, then the summary pieces.
  const steps = useMemo<FeedbackStep[]>(() => {
    if (!fb) return [];
    const out: FeedbackStep[] = [{ kind: "overview" }, ...notes.map((note) => ({ kind: "note" as const, note }))];
    if (fb.coachSummary?.body || fb.scoreSummary) out.push({ kind: "summary" });
    if (fb.coachSummary?.improvements.length) out.push({ kind: "next" });
    if (fb.sections.some((s) => s.speakingTips)) out.push({ kind: "tips" });
    return out;
  }, [fb, notes]);

  const ytId = youTubeId(review.videoUrl);
  const fileUrl = ytId ? null : directMediaUrl(review);
  const mode: PlayerMode = ytId ? "youtube" : fileUrl ? "file" : "clock";
  const mountId = `vr-yt-${review.id}`;

  const [curTime, setCurTime] = useState(0);
  const [stepIdx, setStepIdx] = useState(0);
  const [showTranscript, setShowTranscript] = useState(false);
  const [pauseAtNotes, setPauseAtNotes] = useState(true);
  const [gateKey, setGateKey] = useState<number | null>(null);

  // "Pause at notes": each note stops the video once as the playhead reaches it.
  const firedRef = useRef(new Set<number>());
  const lastTRef = useRef<number | null>(null);
  const gateOpenRef = useRef(false);
  const pauseRef = useRef(pauseAtNotes);
  pauseRef.current = pauseAtNotes;

  function handleTime(t: number) {
    setCurTime(t);
    if (mode === "clock" && t >= duration) player.pause(); // a clock has no natural end
    if (gateOpenRef.current || !notes.length) return;
    // Scrubbing backwards re-arms the notes ahead of the new position.
    if (lastTRef.current != null && t < lastTRef.current - 1.2) {
      for (const n of notes) if (n.start != null && n.start > t + 0.25) firedRef.current.delete(n.key);
    }
    lastTRef.current = t;
    if (!pauseRef.current) return;
    for (const n of notes) {
      if (n.start == null || firedRef.current.has(n.key)) continue;
      if (t > n.start + 2.5) {
        firedRef.current.add(n.key); // jumped past it
        continue;
      }
      if (t >= n.start - 0.15) {
        gateOpenRef.current = true;
        firedRef.current.add(n.key);
        player.pause();
        setGateKey(n.key);
        setStepIdx(stepOfNote(n.key));
        setShowTranscript(false);
      }
      break; // notes are time-ordered: nothing later is due yet
    }
  }

  const player = usePlayer(mode, ytId, mountId, handleTime);

  function seek(s: number) {
    gateOpenRef.current = false;
    setGateKey(null);
    // A deliberate jump must not instantly stop on the note jumped to.
    for (const n of notes) if (n.start != null && n.start >= s - 0.25 && n.start < s + 2.5) firedRef.current.add(n.key);
    lastTRef.current = s;
    player.seek(s);
  }

  function resume() {
    gateOpenRef.current = false;
    setGateKey(null);
    player.play();
  }

  /** Show feedback item i; a note also takes the video to its moment. */
  function goTo(i: number) {
    const next = Math.max(0, Math.min(steps.length - 1, i));
    setStepIdx(next);
    setShowTranscript(false);
    const s = steps[next];
    if (s?.kind === "note" && s.note.start != null) seek(s.note.start);
  }

  // While playing, the feedback follows the video to whichever note it's on.
  const nowKey = currentNoteKey(notes, curTime);
  useEffect(() => {
    if (player.playing && nowKey != null) setStepIdx(stepOfNote(nowKey));
  }, [nowKey, player.playing]);

  // ← / → step through the feedback.
  const goToRef = useRef(goTo);
  goToRef.current = goTo;
  const stepIdxRef = useRef(stepIdx);
  stepIdxRef.current = stepIdx;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement;
      if (e.altKey || e.metaKey || e.ctrlKey || el.tagName === "INPUT" || el.tagName === "TEXTAREA") return;
      if (e.key === "ArrowRight") goToRef.current(stepIdxRef.current + 1);
      if (e.key === "ArrowLeft") goToRef.current(stepIdxRef.current - 1);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  const lastSectionEnd = fb ? parseRange(fb.sections[fb.sections.length - 1]?.range).end : null;
  const duration = review.durationSeconds ?? player.duration ?? lastSectionEnd ?? 60;
  const current = steps[Math.min(stepIdx, steps.length - 1)];
  const isLast = stepIdx >= steps.length - 1;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto lg:overflow-hidden">
      {/* header: one line */}
      <div className="flex flex-shrink-0 flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-baseline gap-3">
          <button type="button" onClick={onBack} className={backLink}>
            <ArrowLeft className="h-3.5 w-3.5" /> All reviews
          </button>
          <h2 className="min-w-0 truncate text-[18px] font-bold text-[#1f2430]">{review.title}</h2>
          <span className="hidden flex-shrink-0 text-[12.5px] text-[#6b7280] sm:inline">
            {[review.studentName, review.format, fmtClock(duration)].filter(Boolean).join(" · ")}
          </span>
        </div>
        {fb && (
          <button
            type="button"
            onClick={() => download(`${review.title.replace(/[^\w]+/g, "-") || "review"}-notes.txt`, notesText(review, fb))}
            className="inline-flex items-center gap-1.5 rounded-[3px] border border-[#e0e0e0] bg-white px-3 py-1.5 text-[12.5px] font-semibold text-[#1f2430]"
          >
            <Download className="h-3.5 w-3.5" /> Download notes
          </button>
        )}
      </div>

      <div className="grid min-h-0 flex-1 grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(320px,380px)]">
        {/* left: the player, its timeline, the sections */}
        <div className="flex min-h-0 min-w-0 flex-col gap-2.5">
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-[10px]" style={{ background: C.dark }}>
            <div className="relative aspect-video w-full lg:aspect-auto lg:min-h-0 lg:flex-1">
              {mode === "youtube" && <div id={mountId} className="absolute inset-0 h-full w-full" />}
              {mode === "file" && fileUrl && (
                <video {...player.videoProps} src={fileUrl} controls playsInline preload="metadata" className="absolute inset-0 h-full w-full bg-black" />
              )}
              {mode === "clock" && (
                <div
                  className="absolute inset-0 flex flex-col items-center justify-center gap-3 text-center"
                  style={{ backgroundImage: "repeating-linear-gradient(135deg, rgba(255,255,255,0.05) 0 1px, transparent 1px 11px)" }}
                >
                  <button
                    type="button"
                    onClick={player.playing ? player.pause : player.play}
                    aria-label={player.playing ? "Pause" : "Play"}
                    className="grid h-[68px] w-[68px] place-items-center rounded-full"
                    style={{ background: C.accentBright }}
                  >
                    {player.playing ? <Pause className="h-7 w-7" /> : <Play className="ml-1 h-7 w-7" fill={C.ink} />}
                  </button>
                  <p className="px-6 text-[12px]" style={{ color: C.darkMuted }}>
                    This video can&apos;t play here, so the notes play against a clock.{" "}
                    {review.videoUrl && (
                      <a href={review.videoUrl} target="_blank" rel="noopener noreferrer" className="font-bold underline" style={{ color: C.accentBright }}>
                        Open the video
                      </a>
                    )}
                  </p>
                </div>
              )}
            </div>

            <Timeline notes={notes} duration={duration} curTime={curTime} onSeek={seek} />

            <div className="flex flex-shrink-0 items-center gap-3 px-4 pb-3 pt-1">
              <button
                type="button"
                onClick={player.playing ? player.pause : player.play}
                aria-label={player.playing ? "Pause" : "Play"}
                className="grid h-8 w-8 flex-shrink-0 place-items-center rounded-full"
                style={{ background: C.accentBright }}
              >
                {player.playing ? <Pause className="h-4 w-4" /> : <Play className="ml-0.5 h-4 w-4" fill={C.ink} />}
              </button>
              <span className="text-[13px] font-semibold tabular-nums" style={{ color: C.darkInk }}>
                {fmtClock(curTime)} / {fmtClock(duration)}
              </span>
              {fb && (
                <button
                  type="button"
                  aria-pressed={pauseAtNotes}
                  onClick={() => {
                    setPauseAtNotes(!pauseAtNotes);
                    if (pauseAtNotes && gateOpenRef.current) resume(); // turning it off mid-stop carries on
                  }}
                  className="ml-auto rounded-full px-3 py-1.5 text-[12px] font-bold"
                  style={
                    pauseAtNotes
                      ? { background: C.accentBright, color: C.ink }
                      : { background: C.darkSoft, color: C.darkMuted, border: `1px solid ${C.darkLine}` }
                  }
                >
                  Pause at notes
                </button>
              )}
            </div>
          </div>

          {fb && (
            <div className="flex flex-shrink-0 gap-2 overflow-x-auto">
              {fb.sections.map((sec, i) => {
                const count = sec.strengths.length + sec.improvements.length;
                const first = notes.find((n) => n.section === i && n.start != null);
                const active = current?.kind === "note" && current.note.section === i;
                return (
                  <button
                    key={sec.title + i}
                    type="button"
                    onClick={() => (first ? goTo(stepOfNote(first.key)) : seek(parseRange(sec.range).start ?? 0))}
                    className={`min-w-[120px] flex-1 rounded-[3px] border px-3 py-1.5 text-left transition-colors ${
                      active ? "border-[#fde68a] border-b-2 border-b-[#facc15] bg-[#fefce8]" : "border-[#e0e0e0] bg-white"
                    }`}
                  >
                    <div className="truncate text-[13px] font-bold text-[#1f2430]">{sec.title}</div>
                    <div className="truncate text-[11.5px] tabular-nums text-[#6b7280]">
                      {sec.range} · <span className="font-semibold text-[#ca8a04]">{count === 1 ? "1 note" : `${count} notes`}</span>
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {/* right: the feedback one item at a time, or the analysis status */}
        {fb ? (
          <section aria-label="Feedback" className="flex min-h-[380px] min-w-0 flex-col overflow-hidden rounded-[3px] border border-[#e0e0e0] bg-white lg:min-h-0">
            <header className="flex flex-shrink-0 items-center gap-3 border-b border-[#e0e0e0] px-4 py-3">
              <Segments total={steps.length} index={stepIdx} />
              <span className="flex-shrink-0 text-[12.5px] font-semibold tabular-nums text-[#6b7280]">
                {stepIdx + 1} of {steps.length}
              </span>
              <button
                type="button"
                aria-pressed={showTranscript}
                onClick={() => setShowTranscript(!showTranscript)}
                className={`inline-flex flex-shrink-0 items-center gap-1 rounded-[3px] border px-2 py-1 text-[11.5px] font-semibold ${
                  showTranscript ? "border-[#ca8a04] bg-[#fefce8] text-[#ca8a04]" : "border-[#e0e0e0] text-[#6b7280]"
                }`}
              >
                {showTranscript ? <X className="h-3.5 w-3.5" /> : <FileText className="h-3.5 w-3.5" />} Transcript
              </button>
            </header>

            <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-5 py-5">
              {showTranscript ? (
                <Transcript review={review} curTime={curTime} onSeek={seek} />
              ) : (
                <div className="my-auto">
                  {current?.kind === "overview" && <Overview feedback={fb} notes={notes} />}
                  {current?.kind === "note" && (
                    <NoteCard
                      note={current.note}
                      total={notes.length}
                      section={fb.sections[current.note.section]?.title}
                      paused={gateKey === current.note.key}
                      onReplay={() => current.note.start != null && seek(current.note.start)}
                    />
                  )}
                  {current?.kind === "summary" && <Summary feedback={fb} />}
                  {current?.kind === "next" && (
                    <Listed title="Next time" items={fb.coachSummary?.improvements ?? []} />
                  )}
                  {current?.kind === "tips" && (
                    <Listed title="Speaking tips" items={fb.sections.flatMap((s) => (s.speakingTips ? [`${s.title}: ${s.speakingTips}`] : []))} />
                  )}
                </div>
              )}
            </div>

            <footer className="flex flex-shrink-0 items-center justify-between gap-2 border-t border-[#e0e0e0] px-4 py-3">
              <button type="button" onClick={() => goTo(stepIdx - 1)} disabled={stepIdx === 0} className={ghostBtn}>
                <ChevronLeft className="h-4 w-4" /> Previous
              </button>
              {gateKey != null ? (
                // Stopped at a note: carrying on is the main move; skipping ahead is still one press.
                <div className="flex items-center gap-2">
                  <button type="button" onClick={() => goTo(stepIdx + 1)} disabled={isLast} className={ghostBtn}>
                    Next <ChevronRight className="h-4 w-4" />
                  </button>
                  <button type="button" onClick={resume} autoFocus className={primaryBtn}>
                    <Play className="h-4 w-4" fill="currentColor" /> Resume
                  </button>
                </div>
              ) : (
                <button type="button" onClick={() => (isLast ? onBack() : goTo(stepIdx + 1))} className={`${primaryBtn} min-w-[132px]`}>
                  {isLast ? "Done" : stepIdx === 0 && notes.length ? "First note" : "Next"} <ChevronRight className="h-4 w-4" />
                </button>
              )}
            </footer>
          </section>
        ) : (
          <StatusPanel review={review} onRetry={onRetry} />
        )}
      </div>
    </div>
  );
}

/** Shown instead of the feedback until it exists: processing, or failed with the reason. */
function StatusPanel({ review, onRetry }: { review: Review; onRetry: () => void }) {
  const failed = review.status === "FAILED";
  const pct = review.progress == null ? null : Math.round(review.progress * 100);
  return (
    <div className="flex flex-col gap-3 self-start rounded-[3px] border border-[#e0e0e0] bg-white p-5">
      <div className="text-[11px] font-extrabold uppercase tracking-widest text-[#ca8a04]">AI analysis</div>
      {failed ? (
        <>
          <div role="alert" className="rounded-[3px] border border-red-200 bg-red-50 px-3 py-2.5">
            <p className="text-[14px] font-semibold text-red-800">The analysis didn&apos;t work.</p>
            <p className="mt-0.5 text-[12.5px] leading-snug text-red-700">{review.error || "No reason was given."}</p>
          </div>
          {review.isOwn ? (
            <button type="button" onClick={onRetry} className={primaryBtn}>
              <RotateCcw className="h-4 w-4" /> Retry analysis
            </button>
          ) : (
            <p className="text-[13px] text-[#6b7280]">The student can retry it.</p>
          )}
        </>
      ) : (
        <>
          <p className="flex items-center gap-2 text-[16px] font-semibold text-[#1f2430]">
            <Loader2 className="h-4 w-4 animate-spin text-[#ca8a04]" />
            {review.stage || (review.status === "QUEUED" ? "Waiting to start" : "Analyzing the speech")}…
          </p>
          {pct != null && <ProgressBar pct={pct} />}
          <p className="text-[13px] text-[#6b7280]">This can take a few minutes. You can leave this page; the review keeps going.</p>
        </>
      )}
    </div>
  );
}

// ───────────────────────── feedback screens ─────────────────────────

function Overview({ feedback, notes }: { feedback: VideoFeedback; notes: Note[] }) {
  const strengths = notes.filter((n) => n.good).length;
  const improvements = notes.length - strengths;
  const m = feedback.metrics;
  const metrics = [
    m?.wordsPerMinute != null && `${Math.round(m.wordsPerMinute)} words/min`,
    m?.fillerWords != null && `${m.fillerWords} filler words`,
    m?.longPauses != null && `${m.longPauses} long pauses`,
  ].filter(Boolean);
  return (
    <div className="space-y-4">
      <div className="rounded-[10px] p-5" style={{ background: C.dark }}>
        <div className="text-[10.5px] font-extrabold uppercase tracking-widest" style={{ color: C.darkMuted }}>
          Overall grade
        </div>
        <div className="mt-1.5 flex items-baseline gap-3">
          <span className="text-[52px] font-extrabold leading-none" style={{ color: C.accentBright }}>
            {letterGrade(feedback.score)}
          </span>
          <span className="text-[12.5px] font-semibold tabular-nums" style={{ color: C.darkMuted }}>
            {feedback.score.toFixed(1)}/10
          </span>
        </div>
        <dl className="mt-4 grid grid-cols-2 gap-x-5 gap-y-3 border-t pt-4" style={{ borderColor: C.darkLine }}>
          {feedback.scoreBreakdown.map((c) => (
            <div key={c.name} className="flex min-w-0 items-baseline justify-between gap-2">
              <dt className="truncate text-[12.5px]" style={{ color: C.darkMuted }}>
                {c.name}
              </dt>
              <dd className="text-[16px] font-extrabold" style={{ color: C.darkInk }} title={`${c.value.toFixed(1)}/10`}>
                {letterGrade(c.value)}
              </dd>
            </div>
          ))}
        </dl>
        {metrics.length > 0 && (
          <p className="mt-4 border-t pt-3 text-[12px]" style={{ borderColor: C.darkLine, color: C.darkMuted }}>
            {metrics.join(" · ")}
          </p>
        )}
      </div>
      <div>
        {(feedback.coachSummary?.headline || feedback.scoreLabel) && (
          <p className="text-[17px] font-semibold leading-snug text-[#1f2430]">{feedback.coachSummary?.headline || feedback.scoreLabel}</p>
        )}
        <p className="mt-1 text-[13px] text-[#6b7280]">
          {notes.length
            ? `${strengths} ${strengths === 1 ? "strength" : "strengths"} · ${improvements} to work on. Step through them next.`
            : "No timestamped notes on this round."}
        </p>
      </div>
    </div>
  );
}

function NoteCard({ note, total, section, paused, onReplay }: { note: Note; total: number; section?: string; paused: boolean; onReplay: () => void }) {
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2.5">
        <span
          className="rounded-[2px] px-1.5 py-0.5 text-[10px] font-extrabold uppercase tracking-wide text-[#1f2430]"
          style={{ background: note.good ? "#86efac" : "#fcd34d" }}
        >
          {note.good ? "Strength" : "Improvement"}
        </span>
        <span className="text-[12.5px] font-bold tabular-nums text-[#ca8a04]">{note.time}</span>
        {section && <span className="truncate text-[12px] text-[#6b7280]">{section}</span>}
      </div>
      <p className="border-l-[3px] pl-3 text-[18px] font-medium leading-snug text-[#1f2430]" style={{ borderColor: note.good ? C.good : C.warn }}>
        {note.text}
      </p>
      <div className="flex items-center justify-between gap-3 text-[12px] text-[#6b7280]">
        <span>{paused ? "Paused here." : `Note ${note.key + 1} of ${total}`}</span>
        {note.start != null && (
          <button type="button" onClick={onReplay} className="inline-flex items-center gap-1 font-semibold text-[#ca8a04] hover:text-[#1f2430]">
            <RotateCcw className="h-3.5 w-3.5" /> Watch from {note.time}
          </button>
        )}
      </div>
    </div>
  );
}

function Summary({ feedback }: { feedback: VideoFeedback }) {
  const cs = feedback.coachSummary;
  return (
    <div className="space-y-3">
      <div className="text-[11px] font-extrabold uppercase tracking-widest text-[#6b7280]">Summary</div>
      <p className="text-[14.5px] leading-relaxed text-[#1f2430]">{cs?.body || feedback.scoreSummary}</p>
      {cs && (
        <div className="flex items-center gap-2.5 border-t border-[#e0e0e0] pt-3">
          <span className="grid h-7 w-7 place-items-center rounded-full border border-[#e0e0e0] bg-[#f5f4f0] text-[11px] font-extrabold text-[#1f2430]">
            {cs.initials}
          </span>
          <span className="text-[12.5px] text-[#6b7280]">
            {cs.author} · {cs.date}
          </span>
        </div>
      )}
    </div>
  );
}

function Listed({ title, items }: { title: string; items: string[] }) {
  return (
    <div className="space-y-3">
      <div className="text-[11px] font-extrabold uppercase tracking-widest text-[#ca8a04]">{title}</div>
      <ol className="space-y-2.5">
        {items.map((text, i) => (
          <li key={i} className="flex items-start gap-2.5">
            <span className="mt-[1px] grid h-5 w-5 flex-shrink-0 place-items-center rounded-full border border-[#fde68a] bg-[#fefce8] text-[11px] font-extrabold text-[#ca8a04]">
              {i + 1}
            </span>
            <span className="text-[14px] leading-snug text-[#1f2430]">{text}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}

/** The track under the player: a tick per note (green strength, yellow improvement) and the playhead. */
function Timeline({ notes, duration, curTime, onSeek }: { notes: Note[]; duration: number; curTime: number; onSeek: (s: number) => void }) {
  const trackRef = useRef<HTMLDivElement>(null);
  const span = Math.max(duration, 1);
  const timeAt = (clientX: number) => {
    const r = trackRef.current!.getBoundingClientRect();
    return Math.max(0, Math.min(1, (clientX - r.left) / r.width)) * span;
  };
  return (
    <div className="flex-shrink-0 px-4 pt-3">
      <div
        ref={trackRef}
        onClick={(e) => onSeek(timeAt(e.clientX))}
        className="relative h-[30px] cursor-pointer rounded-[4px]"
        style={{ background: C.darkSoft, border: `1px solid ${C.darkLine}` }}
      >
        {notes.map(
          (n) =>
            n.start != null && (
              <button
                key={n.key}
                type="button"
                aria-label={`${n.time} ${n.good ? "strength" : "improvement"}`}
                title={`${n.time} · ${n.good ? "Strength" : "Improvement"}`}
                onClick={(e) => {
                  e.stopPropagation();
                  onSeek(n.start!);
                }}
                className="absolute top-1/2 h-4 w-[3px] -translate-x-1/2 -translate-y-1/2 rounded-[1px]"
                style={{ left: `${Math.max(1, Math.min(99, (n.start / span) * 100))}%`, background: n.good ? C.good : C.warn }}
              />
            ),
        )}
        <div
          className="pointer-events-none absolute bottom-0 top-0 w-[2px] -translate-x-1/2"
          style={{ left: `${Math.min(1, curTime / span) * 100}%`, background: C.accentBright }}
        />
      </div>
    </div>
  );
}

function Transcript({ review, curTime, onSeek }: { review: Review; curTime: number; onSeek: (s: number) => void }) {
  const lines = review.transcript ?? [];
  if (!lines.length) return <p className="my-auto text-center text-[13px] text-[#6b7280]">No transcript on this round.</p>;
  return (
    <div className="space-y-1.5">
      {lines.map((l, i) => {
        const now = curTime >= l.start && curTime < l.end;
        return (
          <div key={i} className={`flex items-start gap-2.5 rounded-[3px] px-1 ${now ? "bg-[#fefce8]" : ""}`}>
            <button type="button" onClick={() => onSeek(l.start)} className="min-w-[42px] flex-shrink-0 text-left text-[11.5px] font-bold tabular-nums text-[#ca8a04]">
              {fmtClock(l.start)}
            </button>
            <span className="min-w-0 flex-1 text-[13px] leading-relaxed text-[#1f2430]">{l.text}</span>
          </div>
        );
      })}
    </div>
  );
}


// ═══════════════════════════ 4. APP ═══════════════════════════
// The page to run: just Video Review, with a Student / Teacher switch at the
// top so you can see both views. Swap `mockApi` for `createHttpApi(...)` once
// the real backend exists (see README.md).


export default function App() {
  const [role, setRole] = useState<Role>("student");
  // Mock only: the fake backend needs to know who's looking. Remove this line
  // when switching to the real API, which knows from the session.
  setMockViewer(role);

  return (
    <div className="flex h-screen flex-col bg-[#f5f4f0] text-[#1f2430]">
      <header className="flex items-center justify-between border-b border-[#e0e0e0] bg-white px-6 py-3">
        <span className="text-sm font-semibold">Video Review</span>
        <div role="radiogroup" aria-label="View as" className="flex rounded-[4px] border border-[#e0e0e0] p-0.5">
          {(["student", "teacher"] as const).map((r) => (
            <button
              key={r}
              type="button"
              role="radio"
              aria-checked={role === r}
              onClick={() => setRole(r)}
              className={`rounded-[3px] px-3 py-1 text-xs font-semibold capitalize transition-colors ${
                role === r ? "bg-[#facc15] text-[#1f2430]" : "text-[#6b7280] hover:text-[#1f2430]"
              }`}
            >
              {r}
            </button>
          ))}
        </div>
      </header>

      {/* `key` resets the tool when switching views. */}
      <main className="min-h-0 flex-1 p-6">
        <VideoReviewTool key={role} api={mockApi} role={role} />
      </main>
    </div>
  );
}
