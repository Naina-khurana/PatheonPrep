# PatheonPrep

AI feedback on high school debate speeches. A student submits a video (recorded in the
browser, uploaded, or linked), and gets back an overall score, category scores, and
timestamped notes they step through while the video jumps to each moment. A teacher sees
their students' reviews, read only.

The client gave us the finished frontend. We build everything behind it, the server,
storage, transcription and the AI analysis.

## Running it

You need Node 20 or newer. Check with `node -v`.

```bash
git clone https://github.com/Naina-khurana/PatheonPrep.git
cd PatheonPrep/web
npm install
npm run dev
```

Open the link it prints, usually http://localhost:5173.

The app runs on `mockApi`, a fake in-memory backend, so it works before our server exists.
Nothing you submit survives a page refresh. That is the mock, not a bug.

Ignore the npm audit warnings. They come from esbuild inside Vite, they only affect the
local dev server, and `npm audit fix --force` would break the app.

### Things to try

- Switch between Student and Teacher at the top to see both views
- Open the sample round to see the review screen, and click a note to seek the video
- Put the word **fail** in a round's title to see the failure and retry screens
- Recording only works on localhost or https

## Repo layout

```
docs/PRD.md              What the client wants. Read this first.
web/                     The frontend. Do not redesign it.
  src/VideoReview.tsx    The whole UI in one file, as delivered
samples/transcripts/     Hand-written transcripts, for working without the pipeline
samples/feedback/        Example feedback output to check against
```

## Before writing code

Read lines 56 to 265 of `web/src/VideoReview.tsx`. That section is the API contract and it
is the spec. Every type is documented with exactly what our backend has to return.

The endpoints we are building, all under `/video-reviews`.

| Method | Path | What it does |
|---|---|---|
| GET | `/video-reviews` | List the reviews the caller can see, newest first |
| GET | `/video-reviews/:id` | One review. The UI polls this every 3 seconds while processing |
| POST | `/video-reviews/upload-url` | Returns a one time link the browser uploads the file to |
| POST | `/video-reviews` | Create a review and start the analysis |
| POST | `/video-reviews/:id/analyze` | Re-run a failed analysis. Owner only |
| DELETE | `/video-reviews/:id` | Delete the review and its stored file |

To point the app at our backend, swap `mockApi` for `createHttpApi` in `App` at the bottom
of `VideoReview.tsx` and delete the `setMockViewer(role)` line. Nothing else changes.

## Rules

- Never commit a `.env` file. API keys live in server environment variables only
- Never commit test videos. They are large and they are real students
- Do not change the existing screens. The client requires the delivered UI to work unchanged
- Nobody pushes to `main`. Branch, then open a pull request
- Never return made up feedback. If the model output cannot be parsed or a score is missing,
  the review fails
