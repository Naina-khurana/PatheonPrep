// Runs stage 1 on one file or link, without the server or the UI, and prints
// the TranscriptionHandoff JSON. For testing Groq Whisper on real speeches.
//
//   npm run transcribe -- path/to/speech.mp4 --format "Public Forum" --speech Rebuttal
//   npm run transcribe -- https://youtu.be/xxxx --out handoff.json

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DEBATE_FORMATS } from "../contract.js";
import type { TranscriptionHandoff } from "../pipeline/handoff.js";
import { downloadAudio, inspectLink } from "../pipeline/link.js";
import { extractMp3, probe } from "../pipeline/media.js";
import { transcribeAudio } from "../pipeline/transcribe.js";

function parseArgs(argv: string[]) {
  const out: { input?: string; format?: string; speech?: string; out?: string } = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--format") out.format = argv[++i];
    else if (a === "--speech") out.speech = argv[++i];
    else if (a === "--out") out.out = argv[++i];
    else if (!out.input) out.input = a;
  }
  return out;
}

const clock = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.input) {
    console.error('usage: npm run transcribe -- <file-or-url> [--format "Public Forum"] [--speech Rebuttal] [--out file.json]');
    process.exit(2);
  }
  if (args.format && !(DEBATE_FORMATS as readonly string[]).includes(args.format)) {
    console.error(`--format must be one of: ${DEBATE_FORMATS.join(", ")}`);
    process.exit(2);
  }

  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), "vr-transcribe-"));
  try {
    let source = args.input;
    if (/^https?:\/\//i.test(source)) {
      console.error("Checking the link…");
      const info = await inspectLink(source);
      console.error(`  ${info.title ?? "(untitled)"}${info.durationSeconds ? ` · ${clock(info.durationSeconds)}` : ""}`);
      console.error("Fetching the audio…");
      source = await downloadAudio(source, workDir);
    }
    const info = await probe(source);
    if (!info.hasAudio) throw new Error("That file has no audio track.");
    console.error(`Extracting audio (${clock(info.durationSeconds)})…`);
    const mp3 = path.join(workDir, "audio.mp3");
    await extractMp3(source, mp3);

    console.error("Transcribing with Groq Whisper…");
    const started = Date.now();
    const t = await transcribeAudio(mp3, { format: args.format, workDir });
    console.error(`  ${t.segments.length} segments in ${((Date.now() - started) / 1000).toFixed(1)}s\n`);

    for (const s of t.segments) console.error(`[${clock(s.start)}] ${s.text}`);

    const handoff: TranscriptionHandoff = {
      reviewId: `cli-${Date.now()}`,
      title: path.basename(args.input),
      format: args.format,
      speechType: args.speech,
      durationSeconds: t.durationSeconds,
      transcript: t.segments,
      transcription: { provider: "groq", model: t.model, language: t.language, createdAt: new Date().toISOString() },
    };
    const json = JSON.stringify(handoff, null, 2);
    if (args.out) {
      await fs.writeFile(args.out, json);
      console.error(`\nWrote ${args.out}`);
    } else {
      console.log(json);
    }
  } finally {
    await fs.rm(workDir, { recursive: true, force: true });
  }
}

main().catch((e) => {
  console.error(`\nFailed: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
