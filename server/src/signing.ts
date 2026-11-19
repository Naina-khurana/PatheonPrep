import { createHmac, timingSafeEqual } from "node:crypto";
import { config } from "./config.js";

export function sign(...parts: string[]): string {
  return createHmac("sha256", config.signingSecret).update(parts.join("\n")).digest("hex");
}

export function verify(sig: string | undefined, ...parts: string[]): boolean {
  if (!sig) return false;
  const a = Buffer.from(sig);
  const b = Buffer.from(sign(...parts));
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Where the browser PUTs the file. Valid until `exp` (ms since epoch). */
export function uploadUrl(fileKey: string, exp: number): string {
  return `${config.publicBaseUrl}/uploads/${fileKey}?exp=${exp}&sig=${sign("upload", fileKey, String(exp))}`;
}

/** A short-lived playback link for a stored file. Stored files are never served without one. */
export function signedMediaUrl(fileKey: string): string {
  const exp = Date.now() + config.mediaUrlTtlMs;
  return `${config.publicBaseUrl}/media/${fileKey}?exp=${exp}&sig=${sign("media", fileKey, String(exp))}`;
}
