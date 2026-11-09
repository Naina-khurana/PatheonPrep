# PatheonPrep

AI feedback on high school debate speeches. A student submits a video (recorded in the
browser, uploaded, or linked), and gets back an overall score, category scores, and
timestamped notes they step through while the video jumps to each moment. A teacher sees
their students' reviews, read only.

The client gave us the finished frontend. We build everything behind it: the server,
storage, transcription and the AI analysis. Read `docs/PRD.md` first.

**Where things stand.** The server, file storage, link fetching and transcription
(stage 1) are built and tested. The analysis (stage 2), which turns a transcript into
feedback, is not. Until it is, every review ends `FAILED` with "Your speech was
transcribed, but the feedback stage isn't built yet." See [Adding the analysis
stage](#adding-the-analysis-stage).

## Contents

- [Setup](#setup)
- [Running it](#running-it)
- [Checking it works](#checking-it-works)
- [Repo layout](#repo-layout)
- [How a review is processed](#how-a-review-is-processed)
- [Adding to the system](#adding-to-the-system)
- [Troubleshooting](#troubleshooting)
- [Rules](#rules)

## Setup

You need:

- **Node 20 or newer.** Check with `node -v`.
- **ffmpeg, ffprobe and yt-dlp** on your PATH. On a Mac: `brew install ffmpeg yt-dlp`.
  Keep yt-dlp current with `brew upgrade yt-dlp`; see [Troubleshooting](#troubleshooting).
- **A Groq API key** for transcription. Groq hosts Whisper with a free tier. Make a key at
  https://console.groq.com/keys.

Then clone and install both halves:

```bash
git clone https://github.com/Naina-khurana/PatheonPrep.git
cd PatheonPrep
(cd web && npm install)
(cd server && npm install)
```

Ignore the npm audit warnings. They come from esbuild inside Vite, they only affect the
local dev server, and `npm audit fix --force` would break the app.

Create the two env files. Neither is committed.

```bash
cp server/.env.example server/.env       # then open it and set GROQ_API_KEY=your-key
cp web/.env.example web/.env.local       # points the UI at http://localhost:8787
```

Every other value in `server/.env.example` has a working default. `SIGNING_SECRET` is worth
setting to any random string so upload and playback links survive a server restart.

## Running it

Two terminals.

```bash
# terminal 1: the server, on http://localhost:8787
cd server && npm run dev

# terminal 2: the frontend, on http://localhost:5173
cd web && npm run dev
```

Open http://localhost:5173. The server reloads when you edit its code (`tsx watch`), and
Vite reloads the frontend.

**Who you are.** There is no sign-in yet. The Student / Teacher switch at the top sends an
`X-Dev-User` header of `student-1` or `teacher-1`, and the server looks those up in the
dev roster in `server/src/auth.ts`. `teacher-1` teaches `student-1` and `student-2`, and
`student-3` is in nobody's class, which the tests use to prove isolation.

**Where data goes.** Uploaded files, extracted audio, transcripts and the review database
(a JSON file) live in `server/data/`, ignored by git. Delete the folder to start clean.

**Without the server.** If `web/.env.local` is missing, the UI runs on `mockApi`, an
in-memory fake with a sample round. Nothing survives a refresh. That is the mock, not a
bug. The easy tell: the "Sample round (mock data)" entry only exists on the mock.

### Transcribing one speech from the terminal

Stage 1 can run on its own, without the server or UI, which is the fastest way to test
Whisper on a real speech:

```bash
cd server
npm run transcribe -- path/to/speech.mp4 --format "Public Forum" --speech Rebuttal
npm run transcribe -- "https://www.youtube.com/watch?v=0fgLUQDqtiE" --format "Lincoln-Douglas" --out handoff.json
```

It prints the transcript with timestamps and writes the same `TranscriptionHandoff` JSON
the worker hands to stage 2. The second example is a public 5:23 LD constructive that is
known to work; its output is saved as `samples/transcripts/ld-ac-01.json`.

## Checking it works

Automated:

```bash
cd server
npm run typecheck     # tsc
npm test              # 18 tests: visibility rules, uploads, signed links, limits, validation
cd ../web
npm run build         # tsc + vite
```

By hand, with both servers running:

1. As Student, click **Submit a speech**, name it, choose **Paste a link**, paste
   `https://www.youtube.com/watch?v=0fgLUQDqtiE`, pick Lincoln-Douglas and
   "Affirmative Constructive (1AC)", submit.
2. Watch the stage move through "Checking the link", "Fetching the video", "Extracting
   audio", "Transcribing audio". It ends `FAILED` with the "feedback stage isn't built yet"
   message. That is correct today.
3. Confirm the transcript exists. The UI only shows it once feedback exists, so look at
   `server/data/handoff/<review id>.json`, or:
   ```bash
   curl -s -H "X-Dev-User: student-1" http://localhost:8787/video-reviews | python3 -m json.tool
   ```
4. Switch to Teacher. The review is listed under "Jordan Lee" with no delete button.
5. Try the failure paths: a video over 15 minutes, a private YouTube link, a file with no
   audio track. Each should fail with a plain sentence and no score.

## Repo layout

```
docs/PRD.md                  What the client wants. Read this first.
web/                         The frontend. Do not redesign it.
  src/VideoReview.tsx        The whole UI in one file, as delivered. Lines 56 to 270 are the
                             API contract: the types every endpoint must return.
  .env.example               VITE_API_BASE_URL, copy to .env.local
server/                      Our backend. Express + TypeScript, run with tsx.
  .env.example               Every setting, documented. Copy to .env
  src/index.ts               Boot: starts the HTTP server and the worker
  src/app.ts                 Express app: CORS, routes, JSON error handler
  src/routes.ts              The six /video-reviews endpoints, PUT /uploads, GET /media
  src/auth.ts                DEV identity (X-Dev-User header) and the visibility rule
  src/store.ts               Reviews and uploads, persisted to data/reviews.json
  src/signing.ts             HMAC-signed upload and playback links
  src/worker.ts              The job queue: fetch, extract audio, transcribe, analyse
  src/contract.ts            The API types, mirrored from VideoReview.tsx
  src/pipeline/media.ts      ffprobe and ffmpeg
  src/pipeline/link.ts       yt-dlp: inspect a link, download its audio, explain failures
  src/pipeline/groq.ts       Groq Whisper client (retries, error mapping)
  src/pipeline/transcribe.ts Chunking, timestamp re-basing, segment clean-up, the prompt
  src/pipeline/handoff.ts    TranscriptionHandoff and AnalyzeStage: the stage 1 → 2 contract
  src/pipeline/analyze.ts    STAGE 2 GOES HERE
  src/pipeline/validateFeedback.ts  Rejects incomplete feedback before it is stored
  src/cli/transcribe.ts      `npm run transcribe`
  test/                      node:test suites, `npm test`
samples/transcripts/         Transcripts in the pipeline's shape; ld-ac-01.json is real output
samples/feedback/            Example feedback output to check against
```

## How a review is processed

1. **Submit.** For a file, the browser asks `POST /video-reviews/upload-url` for a signed,
   single-use link and `PUT`s the bytes to it. The server checks the content type and size
   as they stream in. Then `POST /video-reviews` creates the review with the file key, or
   with a YouTube / media link, plus the optional `format` and `speechType`. The review is
   `QUEUED` and the worker is told.
2. **Audio.** The worker fetches a link's audio with yt-dlp (private, removed or
   over-length videos fail here with a plain reason). ffprobe checks there is an audio
   track and the length is under 15 minutes. ffmpeg extracts mono 16 kHz MP3 at 48 kbps,
   about 5 MB for 15 minutes, kept in `data/audio/` so a retry skips this step.
3. **Transcribe.** The MP3 goes to Groq's `whisper-large-v3` with a debate vocabulary
   prompt. Anything over Groq's 25 MB cap is split and the pieces' timestamps shifted back
   onto the whole recording. Segments are trimmed, de-duplicated, clamped to the recording
   and stripped of Whisper's silence hallucinations. If nothing is left, the review fails
   with "No speech was found in the audio." The result is stored as `transcript`.
4. **Hand off.** A `TranscriptionHandoff` (transcript, format, speech type, notes,
   duration) is written to `data/handoff/<id>.json` and passed to `analyzeTranscript`.
5. **Feedback.** The returned `VideoFeedback` is validated: scores 1 to 10, 1 to 4
   sections, every time inside the recording and its section. Anything short of that fails
   the review. Nothing is ever filled in.

Status moves `QUEUED` → `PROCESSING` (with `stage` and `progress`) → `REVIEWED` or
`FAILED`, and the UI polls `GET /video-reviews/:id` every 3 seconds. A run times out after
10 minutes (`JOB_TIMEOUT_MS`). Retrying is safe: each run owns the review through a run id,
so a review deleted or re-queued mid-run is never overwritten by a stale result. Reviews
left `QUEUED` or `PROCESSING` by a crash are picked up again on boot.

Stored files are private. Playback uses signed links that expire after 15 minutes; the UI
refetches the review on open and while polling, so it always has a fresh one.

## Adding to the system

### Adding the analysis stage

This is the next piece of work. It is one function:

```ts
// server/src/pipeline/analyze.ts
export const analyzeTranscript: AnalyzeStage = async (input, ctx) => { ... };
```

`input` is a `TranscriptionHandoff` (`server/src/pipeline/handoff.ts`):

| Field | What it is |
|---|---|
| `transcript` | `TranscriptSegment[]`, each `{ start, end, text }` in seconds |
| `durationSeconds` | Length of the recording. Every note time must be inside it |
| `format` | "Public Forum", "Lincoln-Douglas" or "Policy", if the student picked one |
| `speechType` | e.g. "Rebuttal", one of `SPEECH_TYPES[format]`, if picked |
| `notes` | What the student typed when submitting, if anything |
| `title`, `reviewId`, `transcription` | Context and provenance |

`ctx.signal` aborts when the review times out or is deleted; pass it to your fetch calls.
`ctx.onProgress(0..1)` drives the progress bar during this stage.

Return a complete `VideoFeedback` (`server/src/contract.ts`, same as section 1 of
`VideoReview.tsx`). Note times are `"m:ss"` or `"m:ss-m:ss"` and section ranges are
`"m:ss-m:ss"`. `validateFeedback` runs on your output and the worker fails the review if
it finds a problem, logging exactly what was wrong. Never return defaults, sample scores or
feedback for a transcript you didn't read.

How to work on it:

- Put the model's API key in `server/.env` as a new variable and read it in
  `server/src/config.ts` next to the Groq settings. Document it in `.env.example`.
- Develop against real transcripts. Every review you run through the UI leaves its handoff
  in `server/data/handoff/`, and `samples/transcripts/` has more. A small script that loads
  one, calls `analyzeTranscript`, then `validateFeedback`, is a fast loop.
- Write tests in `server/test/`. Mock the model call; assert on the validation result.
- Milestone 2 items that belong in this stage: `feedback.metrics` (words per minute,
  filler words, long pauses, all computable from the transcript), and tuning the prompt
  to `format` and `speechType`.

### Changing the API contract

The types live in two places and must match: section 1 of `web/src/VideoReview.tsx` (the
source of truth, shared with the client) and `server/src/contract.ts`. To add a field to a
review:

1. Add it to `VideoReview` in both files.
2. Add it to `ReviewRecord` in `server/src/store.ts` and copy it out in `toClientReview`
   in `server/src/routes.ts`.
3. If the client sends it, add it to `CreateReviewRequest` in both files and validate it in
   `parseCreateBody` in `routes.ts`. Reject anything you don't recognise with a readable
   `HttpError(400, …)`.
4. Add a test in `server/test/api.test.ts`.

### Adding an endpoint

Routes are in `server/src/routes.ts`. Each handler is wrapped in `wrap()` so it can be
`async` and throw. Throw `new HttpError(status, "message for the student", "CODE")` for
any failure; the error handler in `app.ts` turns it into `{ error, code }`. The router
already runs `requireViewer`, so `viewerOf(res)` gives you the caller, and `canSee(viewer,
studentId)` is the one visibility rule. A review the caller may not see must 404 exactly
like one that doesn't exist.

### Changing how a review is processed

The steps are in order in `Worker.process` in `server/src/worker.ts`. Call
`stage("Label", 0.xx)` between steps so the UI shows what is happening. Throw
`new PipelineError("plain sentence", "CODE")` for anything the student should read; any
other error becomes "Something went wrong while processing this speech." and the detail
goes to the server log. To swap the speech-to-text provider, replace `groqTranscribe` in
`transcribe.ts` with something that returns the same `WhisperSegment[]` shape.

### Replacing the dev pieces

- **Auth.** `requireViewer` in `server/src/auth.ts` is the only place identity comes from.
  Replace the `DEV_USERS` lookup with the host app's session (cookie or bearer token) and
  fill `Viewer.studentIds` from its rosters. On the frontend, change `getHeaders` in `App`
  at the bottom of `VideoReview.tsx`, or use `credentials: "include"` for cookies.
- **Storage.** `Store` in `server/src/store.ts` is a JSON file with Map-like methods.
  Postgres fits behind the same methods. For files, keep the signed-URL design: issue a
  presigned PUT from `/upload-url` and a short-lived GET for `videoUrl`, and `putUpload` /
  `getMedia` in `routes.ts` go away.
- **The worker.** It is in-process. For more than one server instance, move
  `Worker.enqueue` onto a queue and run `Worker.process` in a separate worker service; it
  only needs the store and the data directory.

## Troubleshooting

**The UI still shows "Sample round (mock data)".** `web/.env.local` is missing or Vite
started before it existed. Create it from `web/.env.example` and restart `npm run dev` in
`web/`.

**Review fails with "Transcription isn't set up on this server yet".** `GROQ_API_KEY` is
empty in `server/.env`. Set it and restart the server. `curl localhost:8787/health` reports
`"transcription": "groq"` when the key is loaded.

**Review fails with "YouTube refused to hand over this video"** (or the server log shows
`HTTP Error 403`). yt-dlp is out of date. `brew upgrade yt-dlp`, then click Retry. No
server restart needed.

**Review fails with "A tool this server needs (ffmpeg) isn't installed".** Install it, or
set `FFMPEG_PATH` / `FFPROBE_PATH` / `YTDLP_PATH` in `server/.env`.

**"You need to be signed in" (401).** The request had no `X-Dev-User` header. From curl,
add `-H "X-Dev-User: student-1"`.

**Upload fails right after a server restart.** Upload and playback links are signed with
`SIGNING_SECRET`, which is random per boot when unset. Set it in `server/.env`.

**Where is the transcript of a failed review?** `server/data/handoff/<id>.json`, or
`GET /video-reviews/:id`. The UI shows the transcript only once feedback exists.

## Rules

- Never commit a `.env` file. API keys live in server environment variables only
- Never commit test videos. They are large and they are real students
- Do not change the existing screens. The client requires the delivered UI to work
  unchanged. The only additions so far are the optional format and speech picker in the
  submit flow and the `format` / `speechType` fields, both called for in the PRD
- Nobody pushes to `main`. Branch, then open a pull request
- Never return made up feedback. If the model output cannot be parsed or a score is missing,
  the review fails
