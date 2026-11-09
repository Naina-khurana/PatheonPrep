# Sample transcripts

Hand-written transcripts in the exact `TranscriptSegment` shape the real pipeline will
produce, so the AI work can start before transcription exists.

Each file is an array of segments. `start` and `end` are seconds from the beginning of the
video, and `text` is what was said in that stretch.

Replace these with real pipeline output as soon as it exists. Real transcripts are messier,
with filler words, run on sentences and no punctuation in places, and the prompt has to
hold up against those.

## Real pipeline output

`ld-ac-01.json` came from the real pipeline (Groq `whisper-large-v3` through
`npm run transcribe` in `server/`) on a public 5:23 Lincoln-Douglas affirmative constructive,
https://www.youtube.com/watch?v=0fgLUQDqtiE. Format Lincoln-Douglas, speech
"Affirmative Constructive (1AC)". It shows what the model gets right (the jargon, the
citations) and what it doesn't: a few very long run-on segments where the speaker never
pauses, and "Herzberg" heard as "Heisenberg".
