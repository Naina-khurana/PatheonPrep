import assert from "node:assert/strict";
import { test } from "node:test";
import { config } from "../src/config.js";
import { analyzeTranscript } from "../src/pipeline/analyze.js";

test("judge sends the selected rubric and rejects an invented timestamp", async (t) => {
  const original = { ...config };
  t.after(() => Object.assign(config, original));
  config.judgeApiKey = "test-key";
  config.judgeModel = "test-model";
  config.judgeRubricsJson = JSON.stringify({ Policy: { "1AC": "Approved rubric" } });

  const note = { time: "0:02", text: "You gave a clear claim: extend bus service." };
  const feedback = {
    score: 8,
    scoreLabel: "B",
    scoreSummary: "Clear claim.",
    scoreBreakdown: ["Delivery", "Argumentation", "Evidence & Warrants", "Refutation & Weighing"]
      .map((name) => ({ name, value: 8 })),
    sections: [{ title: "Constructive", range: "0:00-0:10", strengths: [note], improvements: [] }],
  };
  const signal = new AbortController().signal;
  const fetchMock = t.mock.method(globalThis, "fetch", async (_url: unknown, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    assert.equal(body.model, "test-model");
    assert.equal(JSON.parse(body.messages[1].content).rubric, "Approved rubric");
    assert.equal(init.signal, signal);
    return Response.json({ choices: [{ message: { content: JSON.stringify(feedback) } }] });
  });
  const input = {
    reviewId: "test",
    title: "Test speech",
    format: "Policy",
    speechType: "1AC",
    durationSeconds: 10,
    transcript: [{ start: 2, end: 5, text: "Extend bus service." }],
    transcription: { provider: "groq" as const, model: "test", createdAt: "" },
  };
  const ctx = { signal, onProgress: () => {} };
  assert.deepEqual(await analyzeTranscript(input, ctx), feedback);
  note.time = "0:07";
  await assert.rejects(analyzeTranscript(input, ctx), { code: "BAD_FEEDBACK" });
  await assert.rejects(analyzeTranscript({ ...input, speechType: "2AC" }, ctx), { code: "RUBRIC_UNAVAILABLE" });
  assert.equal(fetchMock.mock.callCount(), 2);
});
