import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { extractAnswer, extractToolCalls, measure, parseSession } from "../src/transcript";

const fixture = parseSession(
  readFileSync(join(import.meta.dir, "fixtures", "web-rfc-q5.jsonl"), "utf8"),
);

const at = (seconds: number): string => new Date(Date.UTC(2026, 0, 1, 0, 0, seconds)).toISOString();

describe("transcript", () => {
  test("measures a real web-rfc session like the original bench scripts", () => {
    // Expected values are what the original metrics15.ts reported for this run.
    expect(measure(fixture)).toEqual({
      lat: 26.8,
      calls: 2,
      out: 1,
      cost: 0.0384,
      ts: 0.000326,
      tools: expect.any(Array),
    });
    expect(extractAnswer(fixture)).toContain("RFC 8297");
    expect(extractToolCalls(fixture).length).toBeGreaterThan(0);
  });

  test("stops at the first answer after the last tool result", () => {
    // pi-web-access can inject a message after the answer, triggering an extra turn.
    const entries = [
      { timestamp: at(0), message: { role: "user", content: [{ type: "text", text: "q" }] } },
      {
        timestamp: at(1),
        message: { role: "assistant", content: [{ type: "toolCall", name: "web_search" }] },
      },
      {
        timestamp: at(3),
        message: {
          role: "toolResult",
          toolName: "web_search",
          content: [{ type: "text", text: "abcd" }],
        },
      },
      {
        timestamp: at(5),
        message: {
          role: "assistant",
          content: [{ type: "text", text: "the answer" }],
          usage: { cost: { total: 0.01 } },
        },
      },
      {
        timestamp: at(9),
        message: { role: "user", content: [{ type: "text", text: "content ready" }] },
      },
      {
        timestamp: at(12),
        message: {
          role: "assistant",
          content: [{ type: "text", text: "No further action needed." }],
          usage: { cost: { total: 0.5 } },
        },
      },
    ];
    expect(extractAnswer(entries)).toBe("the answer");
    expect(measure(entries)).toEqual({
      lat: 5,
      calls: 1,
      out: 0,
      cost: 0.01,
      ts: 0,
      tools: ["web_search"],
    });
  });

  test("measures a trial without an answer to its last message", () => {
    const entries = [
      { timestamp: at(0), message: { role: "user", content: [{ type: "text", text: "q" }] } },
      { timestamp: at(4), message: { role: "toolResult", toolName: "rfc_research", content: [] } },
    ];
    expect(extractAnswer(entries)).toBeUndefined();
    expect(measure(entries)?.lat).toBe(4);
  });

  test("skips a last line cut short when a timed-out trial was killed", () => {
    const jsonl = [
      JSON.stringify({ timestamp: at(0), message: { role: "user", content: [] } }),
      '{"timestamp":"2026-01-01T00:00:09.000Z","message":{"role":"assis',
    ].join("\n");
    expect(parseSession(jsonl)).toHaveLength(1);
  });
});
