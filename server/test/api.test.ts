import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

// Config reads the environment when it loads, so set it before importing the app.
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "vr-test-"));
process.env.DATA_DIR = dataDir;
process.env.SIGNING_SECRET = "test-secret";
process.env.GROQ_API_KEY = "";
process.env.PUBLIC_BASE_URL = "http://127.0.0.1:0";

const { createApp } = await import("../src/app.js");
const { store } = await import("../src/store.js");

/** Records what would have been queued; never runs the pipeline. */
const queued: string[] = [];
const worker = { enqueue: (id: string) => void queued.push(id), isRunning: () => false };

let base = "";
let server: ReturnType<ReturnType<typeof createApp>["listen"]>;

before(async () => {
  server = createApp(worker).listen(0);
  await new Promise<void>((r) => server.once("listening", r));
  const addr = server.address();
  if (!addr || typeof addr === "string") throw new Error("no port");
  base = `http://127.0.0.1:${addr.port}`;
});
after(() => {
  server.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

async function call(user: string | null, method: string, p: string, body?: unknown) {
  const headers: Record<string, string> = {};
  if (user) headers["X-Dev-User"] = user;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const res = await fetch(`${base}/video-reviews${p}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = (await res.json().catch(() => ({}))) as Record<string, any>;
  return { status: res.status, data };
}

const link = (title = "Round 1") => ({ title, source: { kind: "link", url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" } });

describe("auth and visibility", () => {
  it("rejects anonymous callers", async () => {
    const { status } = await call(null, "GET", "");
    assert.equal(status, 401);
  });

  it("a student sees only their own reviews; a teacher sees their students' and nothing else", async () => {
    const a = await call("student-1", "POST", "", link("S1 round"));
    assert.equal(a.status, 201);
    assert.equal(a.data.review.status, "QUEUED");
    assert.ok(queued.includes(a.data.review.id), "created review is queued");
    const b = await call("student-3", "POST", "", link("S3 round"));
    assert.equal(b.status, 201);

    const s1 = await call("student-1", "GET", "");
    assert.deepEqual(s1.data.reviews.map((r: any) => r.title), ["S1 round"]);
    assert.equal(s1.data.reviews[0].studentName, "You");
    assert.equal(s1.data.reviews[0].isOwn, true);

    const other = await call("student-2", "GET", `/${a.data.review.id}`);
    assert.equal(other.status, 404);
    const missing = await call("student-2", "GET", "/does-not-exist");
    assert.equal(missing.status, 404);
    assert.deepEqual(other.data, missing.data, "unknown and forbidden look identical");

    const t = await call("teacher-1", "GET", "");
    const titles = t.data.reviews.map((r: any) => r.title);
    assert.ok(titles.includes("S1 round"));
    assert.ok(!titles.includes("S3 round"), "student-3 is not in teacher-1's class");
    const tv = await call("teacher-1", "GET", `/${a.data.review.id}`);
    assert.equal(tv.status, 200);
    assert.equal(tv.data.review.studentName, "Jordan Lee");
    assert.equal(tv.data.review.isOwn, false);

    const del = await call("teacher-1", "DELETE", `/${a.data.review.id}`);
    assert.equal(del.status, 403);
    const retry = await call("teacher-1", "POST", `/${a.data.review.id}/analyze`);
    assert.equal(retry.status, 403);
    const create = await call("teacher-1", "POST", "", link("Teacher round"));
    assert.equal(create.status, 403);

    const own = await call("student-1", "DELETE", `/${a.data.review.id}`);
    assert.equal(own.status, 200);
    assert.equal((await call("student-1", "GET", `/${a.data.review.id}`)).status, 404);
    await call("student-3", "DELETE", `/${b.data.review.id}`);
  });
});

describe("creating a review", () => {
  it("validates the body with readable errors", async () => {
    assert.equal((await call("student-1", "POST", "", { source: link().source })).status, 400);
    assert.equal((await call("student-1", "POST", "", { title: "x" })).status, 400);
    assert.equal((await call("student-1", "POST", "", { title: "x", source: { kind: "link", url: "not a url" } })).status, 400);
    const badFormat = await call("student-1", "POST", "", { ...link(), format: "Parliamentary" });
    assert.equal(badFormat.status, 400);
    assert.match(badFormat.data.error, /Public Forum/);
    const mismatch = await call("student-1", "POST", "", { ...link(), format: "Policy", speechType: "Final Focus" });
    assert.equal(mismatch.status, 400);
  });

  it("keeps format and speech type and returns the link as the playback URL", async () => {
    const r = await call("student-1", "POST", "", { ...link(), format: "Public Forum", speechType: "Rebuttal", notes: "  second speaker " });
    assert.equal(r.status, 201);
    assert.equal(r.data.review.format, "Public Forum");
    assert.equal(r.data.review.speechType, "Rebuttal");
    assert.equal(r.data.review.notes, "second speaker");
    assert.equal(r.data.review.videoUrl, link().source.url);
    assert.equal(r.data.review.sourceKind, "link");
    await call("student-1", "DELETE", `/${r.data.review.id}`);
  });

  it("retry is owner-only and refuses while queued", async () => {
    const r = await call("student-1", "POST", "", link());
    assert.equal((await call("student-1", "POST", `/${r.data.review.id}/analyze`)).status, 409);
    store.putReview({ ...store.getReview(r.data.review.id)!, status: "FAILED", error: "boom" });
    const again = await call("student-1", "POST", `/${r.data.review.id}/analyze`);
    assert.equal(again.status, 202);
    assert.equal(again.data.review.status, "QUEUED");
    assert.equal(again.data.review.error, undefined);
    await call("student-1", "DELETE", `/${r.data.review.id}`);
  });
});

describe("uploads", () => {
  it("enforces type and size before issuing a ticket", async () => {
    const bad = await call("student-1", "POST", "/upload-url", { fileName: "a.txt", contentType: "text/plain", sizeBytes: 10 });
    assert.equal(bad.status, 400);
    const big = await call("student-1", "POST", "/upload-url", { fileName: "a.mp4", contentType: "video/mp4", sizeBytes: 600 * 1024 * 1024 });
    assert.equal(big.status, 413);
    assert.match(big.data.error, /500 MB/);
    const teacher = await call("teacher-1", "POST", "/upload-url", { fileName: "a.mp4", contentType: "video/mp4", sizeBytes: 10 });
    assert.equal(teacher.status, 403);
  });

  it("stores the bytes behind a signed link, then serves them only through a signed link", async () => {
    const bytes = Buffer.from("fake video bytes");
    const ticket = await call("student-1", "POST", "/upload-url", { fileName: "a.mp4", contentType: "video/mp4", sizeBytes: bytes.length });
    assert.equal(ticket.status, 200);
    const uploadUrl = (ticket.data.uploadUrl as string).replace("http://127.0.0.1:0", base);

    // Not finished yet: the review must be refused.
    const early = await call("student-1", "POST", "", { title: "x", source: { kind: "upload", fileKey: ticket.data.fileKey, contentType: "video/mp4" } });
    assert.equal(early.status, 400);
    assert.match(early.data.error, /didn't finish/);

    const wrongType = await fetch(uploadUrl, { method: "PUT", headers: { "Content-Type": "video/webm" }, body: bytes });
    assert.equal(wrongType.status, 400);
    const tampered = await fetch(uploadUrl.replace(/sig=\w+/, "sig=0000"), { method: "PUT", headers: { "Content-Type": "video/mp4" }, body: bytes });
    assert.equal(tampered.status, 403);
    const tooBig = await fetch(uploadUrl, { method: "PUT", headers: { "Content-Type": "video/mp4" }, body: Buffer.concat([bytes, bytes]) });
    assert.equal(tooBig.status, 413);
    const ok = await fetch(uploadUrl, { method: "PUT", headers: { "Content-Type": "video/mp4" }, body: bytes });
    assert.equal(ok.status, 200);
    assert.equal((await fetch(uploadUrl, { method: "PUT", headers: { "Content-Type": "video/mp4" }, body: bytes })).status, 409);

    // Another student can't attach this file.
    const stolen = await call("student-2", "POST", "", { title: "x", source: { kind: "upload", fileKey: ticket.data.fileKey, contentType: "video/mp4" } });
    assert.equal(stolen.status, 400);

    const r = await call("student-1", "POST", "", {
      title: "Uploaded round",
      source: { kind: "upload", fileKey: ticket.data.fileKey, contentType: "video/mp4", durationSeconds: 90 },
    });
    assert.equal(r.status, 201);
    assert.equal(r.data.review.contentType, "video/mp4");
    assert.equal(r.data.review.durationSeconds, 90);
    const videoUrl = (r.data.review.videoUrl as string).replace("http://127.0.0.1:0", base);
    assert.match(videoUrl, /\/media\/[a-f0-9]{32}\?exp=\d+&sig=/);

    const played = await fetch(videoUrl);
    assert.equal(played.status, 200);
    assert.equal(played.headers.get("content-type"), "video/mp4");
    assert.equal(Buffer.from(await played.arrayBuffer()).toString(), bytes.toString());
    const unsigned = await fetch(videoUrl.replace(/sig=\w+/, "sig=0000"));
    assert.equal(unsigned.status, 403);
    const partial = await fetch(videoUrl, { headers: { Range: "bytes=0-3" } });
    assert.equal(partial.status, 206);
    assert.equal(await partial.text(), "fake");

    // A file backs one review only.
    const reuse = await call("student-1", "POST", "", { title: "x", source: { kind: "upload", fileKey: ticket.data.fileKey, contentType: "video/mp4" } });
    assert.equal(reuse.status, 400);

    // Deleting the review deletes the file.
    const mediaPath = store.mediaPath(ticket.data.fileKey);
    assert.ok(fs.existsSync(mediaPath));
    assert.equal((await call("student-1", "DELETE", `/${r.data.review.id}`)).status, 200);
    assert.ok(!fs.existsSync(mediaPath));
    assert.equal((await fetch(videoUrl)).status, 404);
  });

  it("rejects a too-long upload at create time", async () => {
    const bytes = Buffer.from("x");
    const ticket = await call("student-1", "POST", "/upload-url", { fileName: "a.mp4", contentType: "video/mp4", sizeBytes: 1 });
    await fetch((ticket.data.uploadUrl as string).replace("http://127.0.0.1:0", base), { method: "PUT", headers: { "Content-Type": "video/mp4" }, body: bytes });
    const r = await call("student-1", "POST", "", { title: "x", source: { kind: "upload", fileKey: ticket.data.fileKey, contentType: "video/mp4", durationSeconds: 16 * 60 } });
    assert.equal(r.status, 400);
    assert.match(r.data.error, /15 minutes/);
  });
});
