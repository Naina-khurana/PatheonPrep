# Sample transcripts

Hand-written transcripts in the exact `TranscriptSegment` shape the real pipeline will
produce, so the AI work can start before transcription exists.

Each file is an array of segments. `start` and `end` are seconds from the beginning of the
video, and `text` is what was said in that stretch.

Replace these with real pipeline output as soon as it exists. Real transcripts are messier,
with filler words, run on sentences and no punctuation in places, and the prompt has to
hold up against those.
