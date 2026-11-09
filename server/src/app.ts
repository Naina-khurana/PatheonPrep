import cors from "cors";
import express, { type NextFunction, type Request, type Response } from "express";
import { config } from "./config.js";
import { HttpError } from "./errors.js";
import { createReviewRouter, getMedia, putUpload } from "./routes.js";
import type { ReviewWorker } from "./worker.js";

export function createApp(worker: ReviewWorker) {
  const app = express();
  app.disable("x-powered-by");
  app.use(
    cors({
      origin: config.webOrigins,
      methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
      allowedHeaders: ["Content-Type", "Authorization", "X-Dev-User"],
    }),
  );
  app.use(express.json({ limit: "1mb" }));

  app.get("/health", (_req, res) => {
    res.json({ ok: true, transcription: config.groqApiKey ? "groq" : "not configured" });
  });
  app.put("/uploads/:fileKey", putUpload);
  app.get("/media/:fileKey", getMedia);
  app.use("/video-reviews", createReviewRouter(worker));

  app.use((_req, res) => res.status(404).json({ error: "Not found.", code: "NOT_FOUND" }));
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof HttpError) return res.status(err.status).json({ error: err.message, code: err.code });
    const e = err as { type?: string; status?: number };
    if (e?.type === "entity.parse.failed") return res.status(400).json({ error: "That request wasn't valid JSON.", code: "BAD_JSON" });
    if (e?.type === "entity.too.large") return res.status(413).json({ error: "That request was too large.", code: "TOO_LARGE" });
    console.error("[http] unhandled error:", err);
    res.status(500).json({ error: "Something went wrong. Try again.", code: "INTERNAL" });
  });
  return app;
}
