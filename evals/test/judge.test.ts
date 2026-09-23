import { describe, expect, test } from "bun:test";
import { judgePrompt, parseVerdict } from "../src/judge";
import { loadTask } from "../src/tasks";

describe("judge", () => {
  test("parses a verdict object, tolerating surrounding text", () => {
    expect(parseVerdict('Here: {"verdict": "correct", "reason": "matches §2"}')).toEqual({
      verdict: "correct",
      reason: "matches §2",
    });
  });

  test("rejects replies without a valid verdict", () => {
    expect(parseVerdict("correct")).toBeUndefined();
    expect(parseVerdict('{"verdict": "maybe"}')).toBeUndefined();
    expect(parseVerdict("{not json}")).toBeUndefined();
  });

  test("the prompt names only the claim being graded", () => {
    const task = loadTask("q5");
    const prompt = judgePrompt(task, 2, "RFC 8297 is Experimental (§2).");
    expect(prompt).toContain("Grade only claim 2:");
    expect(prompt).toContain(task.claims[1]!);
    expect(prompt).toContain("RFC 8297 is Experimental");
  });
});
