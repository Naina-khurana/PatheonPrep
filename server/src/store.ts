import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";
import type { ReviewSource, TranscriptSegment, VideoFeedback, VideoReviewStatus, VideoSourceKind } from "./contract.js";

/** An upload ticket and, once the PUT finishes, the stored file. */
export interface UploadRecord {
  fileKey: string;
  ownerId: string;
  fileName: string;
  contentType: string;
  /** Size the client declared; the PUT may not exceed it. */
  sizeBytes: number;
  createdAt: string;
  completed: boolean;
  storedBytes?: number;
  /** Set once a review uses this file. A file backs at most one review. */
  reviewId?: string;
}

/** A review as stored. `toClientReview` turns it into the contract's VideoReview. */
export interface ReviewRecord {
  id: string;
  title: string;
  studentId: string;
  createdAt: string;
  source: ReviewSource;
  sourceKind: VideoSourceKind;
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
  /** Held by the worker run that owns this review; cleared when it ends. */
  runId?: string;
}

interface Snapshot {
  reviews: ReviewRecord[];
  uploads: UploadRecord[];
}

/**
 * A JSON file on disk. Enough for development and tests; swap for Postgres
 * (same methods) when the host app's database is available.
 */
export class Store {
  private reviews = new Map<string, ReviewRecord>();
  private uploads = new Map<string, UploadRecord>();
  private saveTimer: NodeJS.Timeout | null = null;
  readonly file: string;

  constructor(readonly dir: string) {
    this.file = path.join(dir, "reviews.json");
    for (const sub of ["media", "audio", "work", "handoff"]) fs.mkdirSync(path.join(dir, sub), { recursive: true });
    if (fs.existsSync(this.file)) {
      const snap = JSON.parse(fs.readFileSync(this.file, "utf8")) as Partial<Snapshot>;
      for (const r of snap.reviews ?? []) this.reviews.set(r.id, r);
      for (const u of snap.uploads ?? []) this.uploads.set(u.fileKey, u);
    }
  }

  /** The uploaded original. */
  mediaPath(fileKey: string) {
    return path.join(this.dir, "media", fileKey);
  }
  /** The mono MP3 extracted for transcription, kept so a retry skips the extraction. */
  audioPath(reviewId: string) {
    return path.join(this.dir, "audio", `${reviewId}.mp3`);
  }
  /** The JSON handed to the analysis stage. */
  handoffPath(reviewId: string) {
    return path.join(this.dir, "handoff", `${reviewId}.json`);
  }
  /** Scratch space for one run; wiped before and after. */
  workDir(reviewId: string) {
    return path.join(this.dir, "work", reviewId);
  }

  listReviews(): ReviewRecord[] {
    return [...this.reviews.values()];
  }
  getReview(id: string): ReviewRecord | undefined {
    return this.reviews.get(id);
  }
  putReview(r: ReviewRecord): ReviewRecord {
    this.reviews.set(r.id, r);
    this.scheduleSave();
    return r;
  }
  deleteReview(id: string) {
    this.reviews.delete(id);
    this.scheduleSave();
  }

  getUpload(fileKey: string): UploadRecord | undefined {
    return this.uploads.get(fileKey);
  }
  putUpload(u: UploadRecord): UploadRecord {
    this.uploads.set(u.fileKey, u);
    this.scheduleSave();
    return u;
  }
  deleteUpload(fileKey: string) {
    this.uploads.delete(fileKey);
    this.scheduleSave();
  }

  private scheduleSave() {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.flush();
    }, 50);
    this.saveTimer.unref();
  }

  /** Writes the snapshot now. Atomic: temp file, then rename. */
  flush() {
    const snap: Snapshot = { reviews: this.listReviews(), uploads: [...this.uploads.values()] };
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(snap, null, 2));
    fs.renameSync(tmp, this.file);
  }
}

export const store = new Store(config.dataDir);
