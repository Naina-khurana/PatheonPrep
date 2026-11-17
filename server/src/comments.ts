import { randomBytes } from "node:crypto";
import type { Request, Response, Router } from "express";
import { canSee, viewerOf, type Viewer } from "./auth.js";
import type { CoachSummary, TeacherNote } from "./contract.js";
import { HttpError } from "./errors.js";
import { isObj, notFound, wrap } from "./httpUtil.js";
import { parseNoteTime } from "./pipeline/validateFeedback.js";
import { toClientReview } from "./routes.js";
import { store, type ReviewRecord } from "./store.js";

const MAX_NOTES = 100;

/** "Ms. Rivera" → "MR". */
function initialsOf(name: string): string {
  const letters = name
    .split(/\s+/)
    .map((w) => w.replace(/[^\p{L}]/gu, "")[0])
    .filter(Boolean);
  return (letters.length > 1 ? letters[0] + letters[letters.length - 1] : (letters[0] ?? "?")).toUpperCase();
}

function text(value: unknown, what: string, max: number): string {
  const s = typeof value === "string" ? value.trim() : "";
  if (!s) throw new HttpError(400, `Write ${what}.`, "TEXT_REQUIRED");
  if (s.length > max) throw new HttpError(400, `Keep ${what} under ${max} characters.`, "TEXT_TOO_LONG");
  return s;
}

/** The review a teacher is commenting on. Students get 403; anyone who can't see it gets the usual 404. */
function target(req: Request, res: Response, mustBeReviewed: boolean): { viewer: Viewer; review: ReviewRecord } {
  const viewer = viewerOf(res);
  const review = store.getReview(req.params.id);
  if (!review || !canSee(viewer, review.studentId)) throw notFound();
  if (viewer.role !== "teacher") throw new HttpError(403, "Only the student's teacher can comment on a review.", "TEACHERS_ONLY");
  if (mustBeReviewed && review.status !== "REVIEWED") {
    throw new HttpError(409, "You can comment once this review's feedback is ready.", "NOT_REVIEWED");
  }
  return { viewer, review };
}

function parseNote(body: unknown, review: ReviewRecord): Pick<TeacherNote, "time" | "text" | "kind"> {
  const b = isObj(body) ? body : {};
  const time = typeof b.time === "string" ? b.time.trim() : "";
  const span = parseNoteTime(time);
  if (!span) throw new HttpError(400, 'Give the note a time like "1:05" or "1:05-1:22".', "BAD_TIME");
  if (review.durationSeconds && span[1] > review.durationSeconds + 1) {
    throw new HttpError(400, "That time is after the end of the video.", "TIME_OUT_OF_RANGE");
  }
  if (b.kind !== "strength" && b.kind !== "improvement") {
    throw new HttpError(400, "Mark the note as a strength or an improvement.", "BAD_KIND");
  }
  return { time, text: text(b.text, "the note", 1000), kind: b.kind };
}

/** Teacher comments: one coach summary per review, and any number of timestamped notes. */
export function registerCommentRoutes(r: Router) {
  const send = (res: Response, review: ReviewRecord, status = 200) => res.status(status).json({ review: toClientReview(review, viewerOf(res)) });

  // Add or replace the coach summary. Author, initials and date come from the session, never the body.
  r.put(
    "/:id/coach-summary",
    wrap((req, res) => {
      const { viewer, review } = target(req, res, true);
      const b = isObj(req.body) ? req.body : {};
      const list = b.improvements === undefined ? [] : b.improvements;
      if (!Array.isArray(list) || list.length > 10) throw new HttpError(400, "List up to 10 things to work on.", "BAD_IMPROVEMENTS");
      const coachSummary: CoachSummary = {
        headline: text(b.headline, "a headline", 200),
        body: text(b.body, "the summary", 4000),
        improvements: list.map((item) => text(item, "each thing to work on", 300)),
        author: viewer.name,
        initials: initialsOf(viewer.name),
        date: new Date().toLocaleDateString("en-US", { month: "short", day: "numeric" }),
      };
      send(res, store.putReview({ ...review, coachSummary }));
    }),
  );

  r.delete(
    "/:id/coach-summary",
    wrap((req, res) => {
      const { review } = target(req, res, false);
      send(res, store.putReview({ ...review, coachSummary: undefined }));
    }),
  );

  r.post(
    "/:id/teacher-notes",
    wrap((req, res) => {
      const { viewer, review } = target(req, res, true);
      const notes = review.teacherNotes ?? [];
      if (notes.length >= MAX_NOTES) throw new HttpError(400, `A review can have up to ${MAX_NOTES} teacher notes.`, "TOO_MANY_NOTES");
      const now = new Date().toISOString();
      const note: TeacherNote = { id: randomBytes(8).toString("hex"), ...parseNote(req.body, review), author: viewer.name, createdAt: now, updatedAt: now };
      send(res, store.putReview({ ...review, teacherNotes: [...notes, note] }), 201);
    }),
  );

  r.put(
    "/:id/teacher-notes/:noteId",
    wrap((req, res) => {
      const { viewer, review } = target(req, res, true);
      const notes = review.teacherNotes ?? [];
      const old = notes.find((n) => n.id === req.params.noteId);
      if (!old) throw new HttpError(404, "That note doesn't exist.", "NOTE_NOT_FOUND");
      const next: TeacherNote = { ...old, ...parseNote(req.body, review), author: viewer.name, updatedAt: new Date().toISOString() };
      send(res, store.putReview({ ...review, teacherNotes: notes.map((n) => (n.id === old.id ? next : n)) }));
    }),
  );

  r.delete(
    "/:id/teacher-notes/:noteId",
    wrap((req, res) => {
      const { review } = target(req, res, false);
      const notes = review.teacherNotes ?? [];
      if (!notes.some((n) => n.id === req.params.noteId)) throw new HttpError(404, "That note doesn't exist.", "NOTE_NOT_FOUND");
      send(res, store.putReview({ ...review, teacherNotes: notes.filter((n) => n.id !== req.params.noteId) }));
    }),
  );
}
