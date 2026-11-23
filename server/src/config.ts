import "dotenv/config";
import path from "node:path";
import { randomBytes } from "node:crypto";

const num = (v: string | undefined, fallback: number) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

const port = num(process.env.PORT, 8787);

export const config = {
  port,
  /** Where signed upload and playback links point. */
  publicBaseUrl: (process.env.PUBLIC_BASE_URL ?? `http://localhost:${port}`).replace(/\/+$/, ""),
  /** Allowed browser origins for CORS. */
  webOrigins: (process.env.WEB_ORIGIN ?? "http://localhost:5173")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
  dataDir: path.resolve(process.env.DATA_DIR ?? "data"),
  groqApiKey: process.env.GROQ_API_KEY?.trim() ?? "",
  groqModel: process.env.GROQ_WHISPER_MODEL?.trim() || "whisper-large-v3",
  judgeEndpoint: process.env.JUDGE_ENDPOINT?.trim() || "https://api.groq.com/openai/v1/chat/completions",
  judgeModel: process.env.JUDGE_MODEL?.trim() ?? "",
  judgeApiKey: process.env.JUDGE_API_KEY?.trim() || (!process.env.JUDGE_ENDPOINT?.trim() ? process.env.GROQ_API_KEY?.trim() : "") || "",
  judgeRubricFile: process.env.JUDGE_RUBRIC_FILE?.trim() ?? "",
  judgeRubricsJson: process.env.JUDGE_RUBRICS_JSON?.trim() ?? "",
  /** Email goes through Resend when both are set; otherwise it is logged, not sent. */
  resendApiKey: process.env.RESEND_API_KEY?.trim() ?? "",
  emailFrom: process.env.EMAIL_FROM?.trim() ?? "",
  /** Where the link in a notification email points. Defaults to the first WEB_ORIGIN. */
  appUrl: (process.env.APP_URL?.trim() || (process.env.WEB_ORIGIN ?? "http://localhost:5173").split(",")[0].trim()).replace(/\/+$/, ""),
  signingSecret: process.env.SIGNING_SECRET?.trim() || randomBytes(32).toString("hex"),
  ffmpegPath: process.env.FFMPEG_PATH || "ffmpeg",
  ffprobePath: process.env.FFPROBE_PATH || "ffprobe",
  ytDlpPath: process.env.YTDLP_PATH || "yt-dlp",
  jobTimeoutMs: num(process.env.JOB_TIMEOUT_MS, 10 * 60 * 1000),
  /** How long an upload link stays valid. */
  uploadTicketTtlMs: 60 * 60 * 1000,
  /** How long a playback link stays valid. The UI refetches on open and while polling. */
  mediaUrlTtlMs: 15 * 60 * 1000,
};
