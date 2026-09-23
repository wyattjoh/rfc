import { describe, expect, test } from "bun:test";
import { finalReply, judgePrompt, parseVerdict } from "../src/judge";
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

  test("finds the verdict among several brace groups", () => {
    expect(
      parseVerdict('The key says {§2.2.1}. {"verdict": "incorrect", "reason": "cites §2.2"}'),
    ).toEqual({ verdict: "incorrect", reason: "cites §2.2" });
  });

  test("reads the final reply from JSON-mode output, skipping malformed lines", () => {
    const end = {
      type: "agent_end",
      messages: [
        {
          role: "assistant",
          content: [{ type: "text", text: '{"verdict":"correct","reason":"ok"}' }],
          usage: { cost: { total: 0.002 } },
        },
      ],
    };
    const stdout = ['{"type":"agent_start"}', "{truncated", JSON.stringify(end)].join("\n");
    expect(finalReply(stdout)).toEqual({
      text: '{"verdict":"correct","reason":"ok"}',
      cost: 0.002,
    });
  });

  test("the prompt names only the claim being graded", () => {
    const task = loadTask("q5");
    const prompt = judgePrompt(task, 2, "RFC 8297 is Experimental (§2).");
    expect(prompt).toContain("Grade only claim 2:");
    expect(prompt).toContain(task.claims[1]!);
    expect(prompt).toContain("RFC 8297 is Experimental");
  });
});
