import { describe, expect, test } from "bun:test";
import { type Summary, type SummaryTrial, incompleteReason } from "../src/summary";

const trial = (claims: SummaryTrial["claims"]): SummaryTrial => ({
  arm: "web",
  task: "q1",
  trial: 1,
  status: "ok",
  lat: 1,
  calls: 1,
  out: 1,
  cost: 0,
  ts: 0,
  correct: 0,
  claims,
});

const summary = (trials: Array<SummaryTrial>): Summary =>
  ({ run: { trials: 1, tasks: ["q1"], arms: ["web", "web-rfc"] }, trials }) as unknown as Summary;

describe("incompleteReason", () => {
  test("a run with every trial graded is complete", () => {
    expect(incompleteReason(summary([trial(["correct"]), trial(["incorrect"])]))).toBeUndefined();
  });

  test("hand-graded trials without per-claim verdicts count as graded", () => {
    expect(incompleteReason(summary([trial(null), trial(null)]))).toBeUndefined();
  });

  test("names missing trials and ungraded claims", () => {
    expect(incompleteReason(summary([trial(["correct"])]))).toBe("1/2 trials ran");
    expect(incompleteReason(summary([trial(["correct"]), trial([null])]))).toContain(
      "1 trials have ungraded claims",
    );
  });
});
