import type { NextFunction, Request, Response } from "express";
import { HttpError } from "./errors.js";

export const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** One 404 for a review that doesn't exist and one the caller may not see. */
export const notFound = () => new HttpError(404, "That review doesn't exist.", "NOT_FOUND");

/** Lets `async (req, res) => …` handlers throw into Express's error handler. */
export const wrap =
  (fn: (req: Request, res: Response) => Promise<unknown> | unknown) => (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res)).catch(next);
  };
