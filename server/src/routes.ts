import { randomBytes } from "node:crypto";
import { createWriteStream, existsSync } from "node:fs";
import fs from "node:fs/promises";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { Router, type NextFunction, type Request, type Response } from "express";
import { canSee, displayName, requireViewer, viewerOf, type Viewer } from "./auth.js";
import { config } from "./config.js";
import { ALL_SPEECH_TYPES, DEBATE_FORMATS, LIMITS, SPEECH_TYPES, type DebateFormat, type ReviewSource, type VideoReview } from "./contract.js";
import { HttpError } from "./errors.js";
import { signedMediaUrl, uploadUrl, verify } from "./signing.js";
import { store, type ReviewRecord } from "./store.js";
import type { ReviewWorker } from "./worker.js";

const FILE_KEY = /^[a-f0-9]{32}$/;
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const notFound = () => new HttpError(404, "That review doesn't exist.", "NOT_FOUND");
const maxMb = Math.round(LIMITS.maxBytes / 1024 / 1024);
const contentTypes = LIMITS.contentTypes as readonly string[];

/** The contract's VideoReview for this viewer: ownership, display name, a fresh playback link. */
export function toClientReview(r: ReviewRecord, viewer: Viewer): VideoReview {
  const isOwn = r.studentId === viewer.id;
  let videoUrl: string | undefined;
  if (r.source.kind === "link") videoUrl = r.source.url;
  else if (existsSync(store.mediaPath(r.source.fileKey))) videoUrl = signedMediaUrl(r.source.fileKey);
  return {
    id: r.id,
    title: r.title,
    studentId: r.studentId,
    studentName: isOwn ? "You" : displayName(r.studentId),
    isOwn,
    createdAt: r.createdAt,
    sourceKind: r.sourceKind,
    videoUrl,
    contentType: r.contentType,
    durationSeconds: r.durationSeconds,
    format: r.format,
    speechType: r.speechType,
    notes: r.notes,
    status: r.status,
    stage: r.stage,
    progress: r.progress,
    error: r.error,
    transcript: r.transcript,
    feedback: r.feedback,
  };
}

/** Lets `async (req, res) => …` handlers throw into Express's error handler. */
const wrap =
  (fn: (req: Request, res: Response) => Promise<unknown> | unknown) => (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res)).catch(next);
  };

function choice(value: unknown, allowed: readonly string[], what: string): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || !allowed.includes(value)) {
    throw new HttpError(400, `That ${what} isn't one we know. Choose one of: ${allowed.join(", ")}.`, "BAD_CHOICE");
  }
  return value;
}

function parseCreateBody(body: unknown, viewer: Viewer) {
  const b = isObj(body) ? body : {};
  const title = typeof b.title === "string" ? b.title.trim() : "";
  if (!title) throw new HttpError(400, "Give this round a title.", "TITLE_REQUIRED");
  if (title.length > 200) throw new HttpError(400, "That title is too long. Keep it under 200 characters.", "TITLE_TOO_LONG");
  const notes = typeof b.notes === "string" && b.notes.trim() ? b.notes.trim().slice(0, 4000) : undefined;
  const format = choice(b.format, DEBATE_FORMATS, "format");
  const speechType = choice(b.speechType, ALL_SPEECH_TYPES, "speech type");
  if (format && speechType && !SPEECH_TYPES[format as DebateFormat].includes(speechType)) {
    throw new HttpError(400, `"${speechType}" isn't a speech in ${format}.`, "BAD_SPEECH_TYPE");
  }

  const src = isObj(b.source) ? b.source : null;
  if (!src) throw new HttpError(400, "Choose a video to review.", "SOURCE_REQUIRED");
  let source: ReviewSource;
  if (src.kind === "link") {
    const url = typeof src.url === "string" ? src.url.trim() : "";
    if (!/^https?:\/\/\S+$/i.test(url)) throw new HttpError(400, "Paste a full link starting with https://", "BAD_LINK");
    source = { kind: "link", url };
  } else if (src.kind === "upload" || src.kind === "record") {
    const fileKey = typeof src.fileKey === "string" ? src.fileKey : "";
    const up = FILE_KEY.test(fileKey) ? store.getUpload(fileKey) : undefined;
    if (!up || up.ownerId !== viewer.id) throw new HttpError(400, "That upload wasn't found. Upload the file again.", "UPLOAD_NOT_FOUND");
    if (!up.completed) throw new HttpError(400, "That upload didn't finish. Upload the file again.", "UPLOAD_INCOMPLETE");
    if (up.reviewId) throw new HttpError(400, "That file is already attached to a review.", "UPLOAD_USED");
    if (src.contentType !== up.contentType) throw new HttpError(400, "The file type doesn't match the upload.", "CONTENT_TYPE_MISMATCH");
    let durationSeconds: number | undefined;
    if (src.durationSeconds !== undefined) {
      if (typeof src.durationSeconds !== "number" || !Number.isFinite(src.durationSeconds) || src.durationSeconds <= 0) {
        throw new HttpError(400, "The video's length isn't valid.", "BAD_DURATION");
      }
      if (src.durationSeconds > LIMITS.maxDurationSeconds) {
        throw new HttpError(400, `That video is too long. The limit is ${LIMITS.maxDurationSeconds / 60} minutes.`, "TOO_LONG");
      }
      durationSeconds = src.durationSeconds;
    }
    source = { kind: src.kind, fileKey, contentType: up.contentType, durationSeconds };
  } else {
    throw new HttpError(400, "Choose how you'll add the speech.", "BAD_SOURCE");
  }
  return { title, notes, format, speechType, source };
}

/** `/video-reviews`: the six endpoints of the contract. */
export function createReviewRouter(worker: ReviewWorker): Router {
  const r = Router();
  r.use(requireViewer);

  r.get(
    "/",
    wrap((_req, res) => {
      const viewer = viewerOf(res);
      const reviews = store
        .listReviews()
        .filter((x) => canSee(viewer, x.studentId))
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .map((x) => toClientReview(x, viewer));
      res.json({ reviews });
    }),
  );

  r.post(
    "/upload-url",
    wrap((req, res) => {
      const viewer = viewerOf(res);
      if (viewer.role !== "student") throw new HttpError(403, "Only students can submit speeches.", "STUDENTS_ONLY");
      const b = isObj(req.body) ? req.body : {};
      const contentType = typeof b.contentType === "string" ? b.contentType : "";
      if (!contentTypes.includes(contentType)) {
        throw new HttpError(400, "That file isn't a supported video or audio format. Use MP4, MOV, WebM, MP3, M4A or WAV.", "BAD_CONTENT_TYPE");
      }
      const sizeBytes = typeof b.sizeBytes === "number" ? b.sizeBytes : NaN;
      if (!Number.isInteger(sizeBytes) || sizeBytes <= 0) throw new HttpError(400, "That file looks empty.", "BAD_SIZE");
      if (sizeBytes > LIMITS.maxBytes) throw new HttpError(413, `That file is too large. The limit is ${maxMb} MB.`, "TOO_LARGE");
      const fileName = typeof b.fileName === "string" && b.fileName.trim() ? b.fileName.trim().slice(0, 255) : "upload";

      const fileKey = randomBytes(16).toString("hex");
      const exp = Date.now() + config.uploadTicketTtlMs;
      store.putUpload({ fileKey, ownerId: viewer.id, fileName, contentType, sizeBytes, createdAt: new Date().toISOString(), completed: false });
      res.json({ uploadUrl: uploadUrl(fileKey, exp), fileKey });
    }),
  );

  r.post(
    "/",
    wrap((req, res) => {
      const viewer = viewerOf(res);
      if (viewer.role !== "student") throw new HttpError(403, "Only students can submit speeches.", "STUDENTS_ONLY");
      const input = parseCreateBody(req.body, viewer);
      const review: ReviewRecord = {
        id: randomBytes(12).toString("hex"),
        title: input.title,
        studentId: viewer.id,
        createdAt: new Date().toISOString(),
        source: input.source,
        sourceKind: input.source.kind,
        contentType: input.source.kind === "link" ? undefined : input.source.contentType,
        durationSeconds: input.source.kind === "link" ? undefined : input.source.durationSeconds,
        format: input.format,
        speechType: input.speechType,
        notes: input.notes,
        status: "QUEUED",
        stage: "Waiting",
      };
      if (input.source.kind !== "link") store.putUpload({ ...store.getUpload(input.source.fileKey)!, reviewId: review.id });
      store.putReview(review);
      worker.enqueue(review.id);
      res.status(201).json({ review: toClientReview(review, viewer) });
    }),
  );

  r.get(
    "/:id",
    wrap((req, res) => {
      const viewer = viewerOf(res);
      const review = store.getReview(req.params.id);
      if (!review || !canSee(viewer, review.studentId)) throw notFound();
      res.json({ review: toClientReview(review, viewer) });
    }),
  );

  r.post(
    "/:id/analyze",
    wrap((req, res) => {
      const viewer = viewerOf(res);
      const review = store.getReview(req.params.id);
      if (!review || !canSee(viewer, review.studentId)) throw notFound();
      if (review.studentId !== viewer.id) throw new HttpError(403, "Only the student who submitted this review can retry it.", "OWNER_ONLY");
      if (worker.isRunning(review.id) || review.status === "QUEUED" || review.status === "PROCESSING") {
        throw new HttpError(409, "This review is already being analysed.", "ALREADY_RUNNING");
      }
      const next = store.putReview({ ...review, status: "QUEUED", stage: "Waiting", progress: undefined, error: undefined, feedback: undefined });
      worker.enqueue(next.id);
      res.status(202).json({ review: toClientReview(next, viewer) });
    }),
  );

  r.delete(
    "/:id",
    wrap(async (req, res) => {
      const viewer = viewerOf(res);
      const review = store.getReview(req.params.id);
      if (!review || !canSee(viewer, review.studentId)) throw notFound();
      if (review.studentId !== viewer.id) throw new HttpError(403, "Only the student who submitted this review can delete it.", "OWNER_ONLY");
      // Removing the record first makes any in-flight worker run a no-op.
      store.deleteReview(review.id);
      const files = [store.audioPath(review.id), store.handoffPath(review.id)];
      if (review.source.kind !== "link") {
        files.push(store.mediaPath(review.source.fileKey));
        store.deleteUpload(review.source.fileKey);
      }
      await Promise.all(files.map((f) => fs.rm(f, { force: true })));
      res.json({ ok: true });
    }),
  );

  return r;
}

/** PUT /uploads/:fileKey — the browser sends the file's bytes to a signed, single-use link. */
export const putUpload = wrap(async (req, res) => {
  const { fileKey } = req.params;
  const exp = String(req.query.exp ?? "");
  const sig = String(req.query.sig ?? "");
  const up = FILE_KEY.test(fileKey) ? store.getUpload(fileKey) : undefined;
  if (!up || !verify(sig, "upload", fileKey, exp) || Number(exp) < Date.now()) {
    throw new HttpError(403, "This upload link has expired. Start the upload again.", "UPLOAD_EXPIRED");
  }
  if (up.completed) throw new HttpError(409, "This file was already uploaded.", "ALREADY_UPLOADED");
  const contentType = (req.header("content-type") ?? "").split(";")[0].trim();
  if (contentType !== up.contentType) throw new HttpError(400, "The file type doesn't match the upload request.", "CONTENT_TYPE_MISMATCH");
  const declared = Number(req.header("content-length"));
  if (Number.isFinite(declared) && declared > up.sizeBytes) throw new HttpError(413, `That file is too large. The limit is ${maxMb} MB.`, "TOO_LARGE");

  const dest = store.mediaPath(fileKey);
  let bytes = 0;
  const limit = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      bytes += chunk.length;
      if (bytes > up.sizeBytes) return cb(new HttpError(413, `That file is too large. The limit is ${maxMb} MB.`, "TOO_LARGE"));
      cb(null, chunk);
    },
  });
  try {
    await pipeline(req, limit, createWriteStream(dest));
  } catch (e) {
    await fs.rm(dest, { force: true });
    throw e;
  }
  if (bytes === 0) {
    await fs.rm(dest, { force: true });
    throw new HttpError(400, "That file looks empty.", "EMPTY_UPLOAD");
  }
  store.putUpload({ ...up, completed: true, storedBytes: bytes });
  res.json({ ok: true });
});

/** GET /media/:fileKey — plays a stored file through a short-lived signed link. Supports range requests. */
export const getMedia = wrap(async (req, res) => {
  const { fileKey } = req.params;
  const exp = String(req.query.exp ?? "");
  const sig = String(req.query.sig ?? "");
  if (!FILE_KEY.test(fileKey) || !verify(sig, "media", fileKey, exp) || Number(exp) < Date.now()) {
    throw new HttpError(403, "This video link has expired. Reopen the review.", "MEDIA_EXPIRED");
  }
  const up = store.getUpload(fileKey);
  const file = store.mediaPath(fileKey);
  if (!up?.completed || !existsSync(file)) throw new HttpError(404, "That video isn't stored any more.", "NOT_FOUND");
  await new Promise<void>((resolve, reject) => {
    res.sendFile(file, { headers: { "Content-Type": up.contentType, "Cache-Control": "private, max-age=0" }, acceptRanges: true, dotfiles: "deny" }, (err) =>
      err ? reject(err) : resolve(),
    );
  });
});
