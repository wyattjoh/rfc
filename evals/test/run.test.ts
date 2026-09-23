import { describe, expect, test } from "bun:test";
import { type ResumeSettings, resumeSettings, trialStatus } from "../src/run";

const none = {
  model: undefined,
  thinking: undefined,
  trials: undefined,
  tasks: undefined,
  arms: undefined,
};

const recorded: ResumeSettings = {
  model: "openai-codex/gpt-6-luna",
  thinking: "max",
  trials: 1,
  tasks: ["q1", "q5"],
  arms: ["web", "web-rfc"],
};

describe("trialStatus", () => {
  test("a timeout wins over the exit code Pi reports when stopped", () => {
    expect(trialStatus({ timedOut: true, exitCode: 143, hasAnswer: true })).toBe("timeout");
  });

  test("a non-zero exit is an error, a clean exit without an answer is no-answer", () => {
    expect(trialStatus({ timedOut: false, exitCode: 1, hasAnswer: true })).toBe("error");
    expect(trialStatus({ timedOut: false, exitCode: null, hasAnswer: false })).toBe("error");
    expect(trialStatus({ timedOut: false, exitCode: 0, hasAnswer: false })).toBe("no-answer");
    expect(trialStatus({ timedOut: false, exitCode: 0, hasAnswer: true })).toBe("ok");
  });
});

describe("resumeSettings", () => {
  test("keeps the recorded settings when no flags are given", () => {
    expect(resumeSettings(recorded, none)).toEqual(recorded);
  });

  test("accepts flags that repeat the recorded settings", () => {
    expect(
      resumeSettings(recorded, { ...recorded, tasks: ["q1", "q5"], arms: ["web", "web-rfc"] }),
    ).toEqual(recorded);
  });

  test("rejects flags that would change the model or grow the run", () => {
    expect(() => resumeSettings(recorded, { ...none, model: "openai-codex/gpt-5.6-sol" })).toThrow(
      "--model openai-codex/gpt-6-luna",
    );
    expect(() => resumeSettings(recorded, { ...none, trials: 2, tasks: ["q1"] })).toThrow(
      "--trials 1 --tasks q1,q5",
    );
  });
});
