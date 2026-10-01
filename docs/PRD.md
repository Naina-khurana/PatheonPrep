# Video Review: PRD for the backend and analysis

## Overview

Video Review is a practice tool for high-school debaters. A student submits a video of a debate speech (recorded in the browser, uploaded as a file, or linked from YouTube or elsewhere) and gets AI feedback on it: an overall score, category scores (argumentation, evidence, refutation, delivery…), and timestamped strengths and improvements. The student steps through the notes one at a time while the video jumps to each moment. A teacher sees the reviews of the students in their classes, read-only.

## What's provided and what you build

| Provided: `VideoReview.tsx` (one file) | You build |
|---|---|
| The complete UI: list, submit flow, review screen, in-browser recorder, and a Student / Teacher switch at the top | A backend (any stack) that implements the endpoints in section 1 of the file |
| Section 1 of the file, the **API contract**: every type, the limits, a typed HTTP client, and an in-memory `mockApi` so the UI runs today | File storage, a processing pipeline (transcription, then analysis), and a database |
| | The real analysis that produces a `VideoFeedback` from the video |

**To run it:** needs React 18+, Tailwind v3 and lucide-react. Render the file's default export full screen (`import App from "./VideoReview"`). It runs on the mock backend straight away; put "fail" in a round's title to see the error and retry screens. The header comment in the file explains how to switch to your real backend.

**How it works today (for context):** Next.js API routes, Supabase Postgres and Storage, and one LLM call. The student must type or dictate a `[m:ss] …` transcript, and the AI reads only that text, never the video. Nothing is transcribed from the audio. Your job is to replace that with real analysis of the video.

## Must have

Build in two milestones, so there's a working product halfway through.

### Milestone 1: real video in, real feedback out (target: about week 5)

1. **Three ways in:** a file upload, an in-browser recording (WebM or MP4 from `MediaRecorder`), or a link (YouTube, or a direct media URL).
2. **Uploads go straight to storage.** `POST /upload-url` returns a presigned URL; the browser `PUT`s the raw bytes to it, and the file never passes through an API server. Stored files are private, and playback uses short-lived signed URLs.
3. **Links are fetched server-side** for analysis. If a link can't be fetched (private video, unsupported site), the review fails with a clear reason. Don't guess.
4. **Transcribe the audio into a script, yourselves.** Nothing in the current system does this: today the student types the transcript. You need to find and wire up a way to turn the video's audio into a timestamped script, e.g. a speech-to-text service (OpenAI Whisper API, Deepgram, AssemblyAI, Google Speech-to-Text) or a self-hosted Whisper model. Extract the audio from the video first (e.g. with ffmpeg). Return it as `transcript: TranscriptSegment[]` (start/end in seconds). Pick one early and test it on real debate speeches: they're fast and full of jargon.
5. **Feedback in exactly the `VideoFeedback` shape** in section 1 of `VideoReview.tsx`: score and category scores from 1 to 10, 1–4 sections, notes with `time` as `"m:ss"` or `"m:ss-m:ss"`.
6. **Timestamps match the real video.** Every note's time falls inside the video and inside its section's range, and points at what the note describes.
7. **Asynchronous processing with a status:** `QUEUED` → `PROCESSING` (with an optional `stage`, e.g. "Transcribing audio") → `REVIEWED` or `FAILED`. The UI polls `GET /:id` every 3 seconds.
8. **Failures give a plain reason and can be retried.** Set `status: FAILED` and put a reason the student can understand in `error` (e.g. "No speech was found in the audio."). `POST /:id/analyze` re-runs the analysis. Workers must be idempotent and must time out rather than hang.
9. **Never fabricate.** If the model output can't be parsed or is missing a score, fail the review. Never fill in default scores or notes.
10. **Auth on every endpoint.** A student reads and deletes only their own reviews. A teacher can read the reviews of students in classes they teach, and nothing else. Take identity from the session, never from the request body. A review that doesn't exist and one the caller may not see both return the same 404.
11. **Limits enforced on the server:** 500 MB, 15 minutes, and the types in `LIMITS.contentTypes`. Errors carry a readable message, and the client pre-checks the same limits.
12. **Deleting a review deletes its stored file.**
13. **Errors are JSON `{ error, code? }`** with the right HTTP status. `error` is shown to the user verbatim.

### Milestone 2: the full experience (target: end of term)

14. **Delivery metrics** in `feedback.metrics`: words per minute, filler words ("um", "like"), long pauses. The UI already shows them.
15. **Speaking signals from the audio:** volume and pace changes over the speech, shown as notes or a category.
16. **Real progress** from 0 to 1 while processing (the UI already shows a bar).
17. **Feedback tuned to the format** (Public Forum, Lincoln-Douglas, Policy) and speech type (constructive, rebuttal, summary, final focus). Add optional `format` and `speechType` to the create request, and a picker in the submit flow.
18. **Comparison with past reviews:** "weighing improved since last week". Show it on the review overview.
19. **Teacher comments:** a teacher can add or edit a coach summary and individual notes on a student's review.
20. **Notification when feedback is ready,** by email and in the app.
21. **Captions and transcript search:** captions over the video, and a search box that jumps to the matching moment.
22. **Export notes as a PDF.**


## Nice to have

1. **Argument tracking:** from the transcript, pull out each argument the speaker makes (claim, warrant, impact) and which of the opponent's arguments it answers.
2. **Argument map:** show those arguments as a map (nodes and links: supports, responds to, turns), next to the video, where clicking an argument jumps to when it was said.
3. **Evidence detection:** flag each claim as backed by evidence (a card is read: author, date, quote) or not, and list the claims that had none.
4. **Eye contact and gestures** from the video frames (e.g. MediaPipe face and pose landmarks). This is real computer vision, far harder than everything else here, so only try it once Milestone 2 is done.

## API contract

Base path `/video-reviews`. All bodies are JSON, and every response review is a `VideoReview`.

| Method | Path | Purpose | Request | Response |
|---|---|---|---|---|
| GET | `/video-reviews` | List the reviews visible to the caller, newest first | — | `{ reviews: VideoReview[] }` |
| GET | `/video-reviews/:id` | One review (poll it; refreshes signed URLs) | — | `{ review }` |
| POST | `/video-reviews/upload-url` | Start an upload (student only) | `{ fileName, contentType, sizeBytes }` | `{ uploadUrl, uploadHeaders?, fileKey }` |
| (PUT) | `uploadUrl` | Browser sends the raw file bytes | file body, `Content-Type` | 2xx |
| POST | `/video-reviews` | Create a review and start analysis (student only) | `CreateReviewRequest` `{ title, source, notes? }` | `201 { review }` (status `QUEUED`) |
| POST | `/video-reviews/:id/analyze` | Retry the analysis (owner only) | — | `202 { review }`; `409` if already running |
| DELETE | `/video-reviews/:id` | Delete the review and its file (owner only) | — | `{ ok: true }` |

`source` is either `{ kind: "upload" | "record", fileKey, contentType, durationSeconds? }` or `{ kind: "link", url }`. The server must check that `fileKey` belongs to the caller and that the upload actually finished.

## Out of scope

- Redesigning the UI. Use it as delivered and add only what the new features need: the format picker, teacher comments, captions and search, PDF export, the past-review comparison, and (nice to have) the argument map.
- Sign-in and user or class management. Use the host app's session and its class and roster data.
- Live (real-time) feedback during recording.
- Any fallback that invents feedback, including demo or sample scores in production.

## Acceptance criteria

- [ ] With `createHttpApi` in place of `mockApi` in the file's `App` (and the mock-only `setMockViewer` line removed), all three input routes work end to end with no changes to the existing screens.
- [ ] A 10-minute 720p recording uploads and reaches `REVIEWED` within about 5 minutes.
- [ ] Clicking any note seeks the video to the moment it describes (spot-checked on 5 real speeches).
- [ ] The script is transcribed from the audio (not typed by the student), timestamped, and roughly accurate for clear English debate speech.
- [ ] Silent audio, a private YouTube link, an oversized file and a wrong file type each end in a clear error. None produces a score.
- [ ] Retrying a failed review works, and it is safe to run twice.
- [ ] A student can't read or delete another student's review. A teacher sees only their own students' reviews and can't delete them. Both are covered by tests.
- [ ] Stored files are private, and deleting a review removes its file.
- [ ] No secrets or storage keys reach the browser.
