import type { NextFunction, Request, Response } from "express";
import { HttpError } from "./errors.js";

export interface Viewer {
  id: string;
  name: string;
  role: "student" | "teacher";
  /** Students whose reviews this teacher may read. Empty for students. */
  studentIds: string[];
}

// DEV ONLY. Sign-in and class rosters belong to the host app. Replace this table
// and `requireViewer` with a lookup of its session (cookie or bearer token).
// Identity never comes from the request body.
const DEV_USERS: Record<string, Viewer> = {
  "student-1": { id: "student-1", name: "Jordan Lee", role: "student", studentIds: [] },
  "student-2": { id: "student-2", name: "Sam Patel", role: "student", studentIds: [] },
  // Not in teacher-1's class, so the teacher must never see their reviews.
  "student-3": { id: "student-3", name: "Riley Chen", role: "student", studentIds: [] },
  "teacher-1": { id: "teacher-1", name: "Ms. Rivera", role: "teacher", studentIds: ["student-1", "student-2"] },
};

export function displayName(userId: string): string {
  return DEV_USERS[userId]?.name ?? "Unknown student";
}

/** Reads the dev identity header and puts the viewer on `res.locals`. */
export function requireViewer(req: Request, res: Response, next: NextFunction) {
  const id = req.header("x-dev-user");
  const viewer = id ? DEV_USERS[id] : undefined;
  if (!viewer) return next(new HttpError(401, "You need to be signed in.", "UNAUTHENTICATED"));
  res.locals.viewer = viewer;
  next();
}

export const viewerOf = (res: Response): Viewer => res.locals.viewer as Viewer;

/** Students see their own reviews; teachers see their students'. Nobody else sees anything. */
export function canSee(viewer: Viewer, studentId: string): boolean {
  return viewer.id === studentId || (viewer.role === "teacher" && viewer.studentIds.includes(studentId));
}
