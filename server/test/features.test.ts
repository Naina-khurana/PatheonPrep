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
process.env.RESEND_API_KEY = "";
process.env.PUBLIC_BASE_URL = "http://127.0.0.1:0";

const { createApp } = await import("../src/app.js");
const { store } = await import("../src/store.js");
const { buildCues, searchTranscript, toVtt } = await import("../src/captions.js");
const { notifyFeedbackReady } = await import("../src/notifications.js");
const { validateFeedback } = await import("../src/pipeline/validateFeedback.js");

const worker = { enqueue: () => {}, isRunning: () => false };
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
  const res = await fetch(base + p, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const raw = await res.text();
  let data: Record<string, any> = {};
  try {
    data = JSON.parse(raw);
  } catch {}
  return { status: res.status, data, raw, type: res.headers.get("content-type") ?? "" };
}

const LONG =
  "I affirm the resolution because justice requires that we treat every person as an end in themselves. My value is morality and my criterion is respecting human dignity, which Kant explains is the only thing with unconditional worth.";

const transcript = [
  { start: 0, end: 4, text: "Thank you judge. Is everyone ready?" },
  { start: 4, end: 24, text: LONG },
  { start: 24, end: 30, text: "Contention one is   structural violence." },
];

const feedback = {
  score: 7.5,
  scoreSummary: "A clear case.",
  scoreBreakdown: [{ name: "Argumentation", value: 7 }],
  sections: [{ title: "Constructive", range: "0:00-0:30", strengths: [{ time: "0:05", text: "Clear framework." }], improvements: [] }],
};

/** A review put straight into the store, as the pipeline would leave it. */
async function seed(student: string, patch: Record<string, unknown> = {}) {
  const made = await call(student, "POST", "/video-reviews", { title: "Seeded round", source: { kind: "link", url: "https://example.com/a.mp4" } });
  assert.equal(made.status, 201);
  const id = made.data.review.id as string;
  store.putReview({ ...store.getReview(id)!, status: "REVIEWED", stage: undefined, durationSeconds: 30, transcript, feedback, ...patch });
  return id;
}

describe("teacher comments", () => {
  it("the seeded feedback is valid, so these tests look like real reviews", () => {
    assert.deepEqual(validateFeedback(feedback, 30), []);
  });

  it("a teacher adds a coach summary to their student's review, and only a teacher can", async () => {
    const id = await seed("student-1");
    const body = { headline: "Strong framework", body: "Slow down in the contentions.", improvements: ["Signpost each contention"] };

    assert.equal((await call("student-1", "PUT", `/video-reviews/${id}/coach-summary`, body)).status, 403);
    assert.equal((await call("student-2", "PUT", `/video-reviews/${id}/coach-summary`, body)).status, 404);
    assert.equal((await call(null, "PUT", `/video-reviews/${id}/coach-summary`, body)).status, 401);
    assert.equal((await call("teacher-1", "PUT", `/video-reviews/${id}/coach-summary`, { ...body, headline: " " })).status, 400);
    assert.equal((await call("teacher-1", "PUT", `/video-reviews/${id}/coach-summary`, { ...body, improvements: "x" })).status, 400);

    // The author can't be chosen by the caller.
    const saved = await call("teacher-1", "PUT", `/video-reviews/${id}/coach-summary`, { ...body, author: "Someone Else", initials: "XX" });
    assert.equal(saved.status, 200);
    const cs = saved.data.review.feedback.coachSummary;
    assert.equal(cs.headline, "Strong framework");
    assert.equal(cs.author, "Ms. Rivera");
    assert.equal(cs.initials, "MR");
    assert.deepEqual(cs.improvements, ["Signpost each contention"]);
    assert.equal(saved.data.review.feedback.score, 7.5, "the AI feedback is untouched");

    const seen = await call("student-1", "GET", `/video-reviews/${id}`);
    assert.equal(seen.data.review.feedback.coachSummary.body, "Slow down in the contentions.");

    // A retry clears the AI feedback but keeps what the teacher wrote.
    assert.equal((await call("student-1", "POST", `/video-reviews/${id}/analyze`)).status, 202);
    assert.equal(store.getReview(id)!.coachSummary?.headline, "Strong framework");
    assert.equal((await call("teacher-1", "PUT", `/video-reviews/${id}/coach-summary`, body)).status, 409, "no commenting while it is re-analysed");
    store.putReview({ ...store.getReview(id)!, status: "REVIEWED", feedback });
    assert.equal((await call("student-1", "GET", `/video-reviews/${id}`)).data.review.feedback.coachSummary.headline, "Strong framework");

    const gone = await call("teacher-1", "DELETE", `/video-reviews/${id}/coach-summary`);
    assert.equal(gone.status, 200);
    assert.equal(gone.data.review.feedback.coachSummary, undefined);
    await call("student-1", "DELETE", `/video-reviews/${id}`);
  });

  it("a teacher can't comment on a student outside their classes", async () => {
    const id = await seed("student-3");
    const res = await call("teacher-1", "POST", `/video-reviews/${id}/teacher-notes`, { time: "0:05", text: "x", kind: "strength" });
    assert.equal(res.status, 404);
    await call("student-3", "DELETE", `/video-reviews/${id}`);
  });

  it("timestamped notes can be added, edited and removed, and must point inside the video", async () => {
    const id = await seed("student-1");
    const url = `/video-reviews/${id}/teacher-notes`;
    assert.equal((await call("teacher-1", "POST", url, { time: "soon", text: "x", kind: "strength" })).status, 400);
    assert.equal((await call("teacher-1", "POST", url, { time: "2:00", text: "x", kind: "strength" })).status, 400, "after the end of a 30s video");
    assert.equal((await call("teacher-1", "POST", url, { time: "0:05", text: "x", kind: "praise" })).status, 400);
    assert.equal((await call("teacher-1", "POST", url, { time: "0:05", text: "", kind: "strength" })).status, 400);
    assert.equal((await call("student-1", "POST", url, { time: "0:05", text: "x", kind: "strength" })).status, 403);

    const added = await call("teacher-1", "POST", url, { time: "0:05-0:12", text: "Good eye contact here.", kind: "strength" });
    assert.equal(added.status, 201);
    const [note] = added.data.review.teacherNotes;
    assert.equal(note.author, "Ms. Rivera");
    assert.equal(note.time, "0:05-0:12");

    const edited = await call("teacher-1", "PUT", `${url}/${note.id}`, { time: "0:20", text: "Slow down.", kind: "improvement" });
    assert.equal(edited.status, 200);
    assert.deepEqual(
      edited.data.review.teacherNotes.map((n: any) => [n.id, n.time, n.text, n.kind]),
      [[note.id, "0:20", "Slow down.", "improvement"]],
    );
    assert.equal((await call("teacher-1", "PUT", `${url}/nope`, { time: "0:20", text: "x", kind: "strength" })).status, 404);

    assert.equal((await call("student-1", "GET", `/video-reviews/${id}`)).data.review.teacherNotes.length, 1, "the student sees the note");
    assert.equal((await call("student-1", "DELETE", `${url}/${note.id}`)).status, 403);
    const removed = await call("teacher-1", "DELETE", `${url}/${note.id}`);
    assert.equal(removed.status, 200);
    assert.equal(removed.data.review.teacherNotes, undefined);
    await call("student-1", "DELETE", `/video-reviews/${id}`);
  });
});

describe("captions and search", () => {
  it("splits long segments into caption-sized cues that keep the segment's time span", () => {
    const cues = buildCues(transcript);
    assert.equal(cues[0].text, "Thank you judge. Is everyone ready?");
    assert.ok(cues.every((c) => c.text.length <= 84), "no cue is longer than two lines");
    const middle = cues.filter((c) => c.start >= 4 && c.end <= 24);
    assert.ok(middle.length >= 3, "the long segment was split");
    assert.equal(middle[0].start, 4);
    assert.equal(middle[middle.length - 1].end, 24);
    middle.forEach((c, i) => {
      assert.ok(c.end > c.start);
      if (i) assert.equal(c.start, middle[i - 1].end, "no gaps or overlaps");
    });
    assert.equal(middle.map((c) => c.text).join(" "), LONG, "no words lost");
    assert.equal(cues[cues.length - 1].text, "Contention one is structural violence.", "whitespace is tidied");
    assert.deepEqual(buildCues([{ start: 0, end: 1, text: "   " }]), []);
  });

  it("writes WebVTT", () => {
    const vtt = toVtt([
      { start: 0, end: 4.5, text: "a < b & c" },
      { start: 3725.25, end: 3726, text: "late" },
      { start: 5, end: 5, text: "zero length is dropped" },
    ]);
    assert.equal(vtt, "WEBVTT\n\n1\n00:00:00.000 --> 00:00:04.500\na &lt; b &amp; c\n\n2\n01:02:05.250 --> 01:02:06.000\nlate\n");
  });

  it("finds what was said and where", () => {
    const hits = searchTranscript(transcript, "  human   DIGNITY ");
    assert.equal(hits.length, 1);
    assert.equal(hits[0].start, 4);
    assert.ok(hits[0].time > 14 && hits[0].time < 20, `seeks into the long segment, not to its start (got ${hits[0].time})`);
    assert.match(hits[0].text, /respecting human dignity/);
    assert.equal(searchTranscript(transcript, "contention one")[0].time, 24);
    assert.deepEqual(searchTranscript(transcript, "economy"), []);
    assert.equal(searchTranscript([{ start: 0, end: 10, text: "no no no no" }], "no", 3).length, 3, "respects the limit");
  });

  it("serves captions and search to those who can see the review, and nobody else", async () => {
    const id = await seed("student-1");
    const cues = await call("student-1", "GET", `/video-reviews/${id}/captions`);
    assert.equal(cues.status, 200);
    assert.deepEqual(cues.data.cues, buildCues(transcript));
    const vtt = await call("teacher-1", "GET", `/video-reviews/${id}/captions.vtt`);
    assert.equal(vtt.status, 200);
    assert.match(vtt.type, /^text\/vtt/);
    assert.ok(vtt.raw.startsWith("WEBVTT\n\n1\n00:00:00.000 --> 00:00:04.000\nThank you judge."));

    const found = await call("student-1", "GET", `/video-reviews/${id}/search?q=structural%20violence`);
    assert.equal(found.status, 200);
    assert.equal(found.data.matches.length, 1);
    assert.equal(found.data.matches[0].start, 24);
    assert.equal((await call("student-1", "GET", `/video-reviews/${id}/search`)).status, 400);
    assert.equal((await call("student-1", "GET", `/video-reviews/${id}/search?q=${"x".repeat(101)}`)).status, 400);

    for (const p of ["captions", "captions.vtt", "search?q=judge"]) {
      assert.equal((await call("student-2", "GET", `/video-reviews/${id}/${p}`)).status, 404, p);
      assert.equal((await call(null, "GET", `/video-reviews/${id}/${p}`)).status, 401, p);
    }

    // Not transcribed yet: empty, not an error.
    const bare = await seed("student-1", { transcript: undefined });
    assert.deepEqual((await call("student-1", "GET", `/video-reviews/${bare}/captions`)).data.cues, []);
    assert.deepEqual((await call("student-1", "GET", `/video-reviews/${bare}/search?q=judge`)).data.matches, []);
    await call("student-1", "DELETE", `/video-reviews/${id}`);
    await call("student-1", "DELETE", `/video-reviews/${bare}`);
  });
});

describe("notifications", () => {
  it("feedback ready: the student gets an in-app notification and an email; nobody else does", async () => {
    const id = await seed("student-1");
    const sent: { to: string; subject: string; text: string }[] = [];
    await notifyFeedbackReady(store.getReview(id)!, { send: async (e) => void sent.push(e) });

    assert.equal(sent.length, 1);
    assert.equal(sent[0].to, "student-1@example.com");
    assert.match(sent[0].subject, /Seeded round/);

    const mine = await call("student-1", "GET", "/notifications");
    assert.equal(mine.status, 200);
    assert.equal(mine.data.unreadCount, 1);
    const [n] = mine.data.notifications;
    assert.equal(n.kind, "FEEDBACK_READY");
    assert.equal(n.reviewId, id);
    assert.equal(n.userId, undefined, "who it is for isn't echoed back");
    assert.equal(n.readAt, undefined);

    assert.equal((await call(null, "GET", "/notifications")).status, 401);
    for (const other of ["student-2", "teacher-1"]) {
      assert.deepEqual((await call(other, "GET", "/notifications")).data, { notifications: [], unreadCount: 0 }, other);
      assert.equal((await call(other, "POST", `/notifications/${n.id}/read`)).status, 404, other);
    }

    const read = await call("student-1", "POST", `/notifications/${n.id}/read`);
    assert.equal(read.status, 200);
    assert.ok(read.data.notification.readAt);
    assert.equal((await call("student-1", "GET", "/notifications")).data.unreadCount, 0);

    // Deleting the review takes its notifications with it.
    await call("student-1", "DELETE", `/video-reviews/${id}`);
    assert.deepEqual((await call("student-1", "GET", "/notifications")).data.notifications, []);
  });

  it("a mail failure never throws, and the in-app notification still lands", async () => {
    const id = await seed("student-2");
    await notifyFeedbackReady(store.getReview(id)!, {
      send: async () => {
        throw new Error("mail is down");
      },
    });
    await notifyFeedbackReady(store.getReview(id)!, { send: async () => {} });
    assert.equal((await call("student-2", "GET", "/notifications")).data.unreadCount, 2);
    assert.equal((await call("student-2", "POST", "/notifications/read-all")).status, 200);
    assert.equal((await call("student-2", "GET", "/notifications")).data.unreadCount, 0);
    await call("student-2", "DELETE", `/video-reviews/${id}`);
  });
});
