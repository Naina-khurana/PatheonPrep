import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { cleanSegments, whisperPrompt } from "../src/pipeline/transcribe.js";
import { parseNoteTime, parseRange, validateFeedback } from "../src/pipeline/validateFeedback.js";
import { userMessage } from "../src/worker.js";
import { PipelineError } from "../src/errors.js";
import { StageNotImplementedError } from "../src/pipeline/handoff.js";

describe("cleanSegments", () => {
  it("trims, drops empties and hallucinated silence, clamps to the recording", () => {
    const out = cleanSegments(
      [
        { start: 0, end: 3.456, text: "  Good   evening. " },
        { start: 3.5, end: 5, text: "   " },
        { start: 5, end: 8, text: "Thank you for watching.", noSpeechProb: 0.9, avgLogprob: -1.4 },
        { start: 8, end: 12, text: "Our first contention is congestion.", noSpeechProb: 0.7, avgLogprob: -0.3 },
        { start: 12, end: 30, text: "runs past the end" },
        { start: 31, end: 35, text: "after the end" },
      ],
      20,
    );
    assert.deepEqual(out, [
      { start: 0, end: 3.46, text: "Good evening." },
      { start: 8, end: 12, text: "Our first contention is congestion." },
      { start: 12, end: 20, text: "runs past the end" },
    ]);
  });

  it("drops an exact repeat at the same moment but keeps a real repeat later", () => {
    const out = cleanSegments(
      [
        { start: 0, end: 2, text: "Extend the impact." },
        { start: 0.1, end: 2, text: "Extend the impact." },
        { start: 40, end: 42, text: "Extend the impact." },
      ],
      60,
    );
    assert.equal(out.length, 2);
  });

  it("shifts nothing when the recording length is unknown", () => {
    const out = cleanSegments([{ start: 100, end: 105, text: "late" }], 0);
    assert.deepEqual(out, [{ start: 100, end: 105, text: "late" }]);
  });
});

describe("whisperPrompt", () => {
  it("adds the format's vocabulary", () => {
    assert.match(whisperPrompt("Policy"), /counterplan/);
    assert.match(whisperPrompt("Public Forum"), /final focus/);
    assert.doesNotMatch(whisperPrompt(), /counterplan/);
  });
});

describe("time parsing", () => {
  it("reads m:ss and ranges", () => {
    assert.deepEqual(parseRange("0:00-1:30"), [0, 90]);
    assert.equal(parseRange("1:30-0:00"), null);
    assert.equal(parseRange("1:30"), null);
    assert.deepEqual(parseNoteTime("1:05"), [65, 65]);
    assert.deepEqual(parseNoteTime("1:05-1:22"), [65, 82]);
    assert.equal(parseNoteTime("1:65"), null);
  });
});

describe("validateFeedback", () => {
  const good = {
    score: 7.5,
    scoreSummary: "Clear case.",
    scoreBreakdown: [{ name: "Argumentation", value: 8 }],
    sections: [
      { title: "Constructive", range: "0:00-2:00", strengths: [{ time: "0:12", text: "Good roadmap." }], improvements: [] },
      { title: "Rebuttal", range: "2:00-4:00", strengths: [], improvements: [{ time: "2:30-2:45", text: "Attack the warrant." }] },
    ],
  };

  it("accepts a complete feedback", () => {
    assert.deepEqual(validateFeedback(good, 240), []);
  });

  it("names every problem instead of filling defaults", () => {
    const bad = {
      ...good,
      score: undefined,
      scoreBreakdown: [{ name: "Delivery", value: 11 }],
      sections: [
        { title: "", range: "0:00", strengths: [], improvements: [] },
        { title: "Late", range: "3:00-9:00", strengths: [{ time: "8:00", text: "x" }], improvements: [] },
      ],
    };
    const errors = validateFeedback(bad, 240);
    assert.ok(errors.some((e) => e.includes("score is missing")));
    assert.ok(errors.some((e) => e.includes("scoreBreakdown[0]")));
    assert.ok(errors.some((e) => e.includes("sections[0].title")));
    assert.ok(errors.some((e) => e.includes('sections[0].range must be "m:ss-m:ss"')));
    assert.ok(errors.some((e) => e.includes("sections[0] has no notes")));
    assert.ok(errors.some((e) => e.includes("ends after the recording")));
    assert.ok(errors.some((e) => e.includes("after the end of the recording")));
  });

  it("rejects a note outside its section", () => {
    const errors = validateFeedback({ ...good, sections: [{ ...good.sections[0], strengths: [{ time: "3:00", text: "x" }] }] }, 240);
    assert.ok(errors.some((e) => e.includes("outside its section")));
  });

  it("rejects non-objects and too many sections", () => {
    assert.equal(validateFeedback(null, 10).length, 1);
    assert.ok(validateFeedback({ ...good, sections: Array(5).fill(good.sections[0]) }, 600).some((e) => e.includes("1 to 4")));
  });
});

describe("userMessage", () => {
  it("shows pipeline reasons verbatim and hides everything else", () => {
    assert.equal(userMessage(new PipelineError("No speech was found in the audio.")), "No speech was found in the audio.");
    assert.match(userMessage(new StageNotImplementedError("x")), /feedback stage isn't built yet/);
    assert.equal(userMessage(new TypeError("undefined is not a function")), "Something went wrong while processing this speech. Try again.");
  });
});
