/**
 * Default eval settings. Every value can be overridden per run with a CLI flag
 * (see `bun run eval --help`); change a default here when the preference should
 * stick for everyone running the suite.
 */
export const defaults = {
  /**
   * Pi model under test, as `provider/id`.
   */
  model: "openai-codex/gpt-5.6-sol",
  /**
   * Pi thinking level for the model under test.
   */
  thinking: "low",
  /**
   * Trials per task per arm. Two is enough to spot large effects; use more to
   * separate small time or cost differences from noise.
   */
  trials: 2,
  /**
   * Trials running at once across both arms.
   */
  concurrency: 4,
  /**
   * A trial still running after this long is killed and recorded as a timeout.
   */
  trialTimeoutMs: 540_000,
  /**
   * Model that grades each claim, as `provider/id`.
   */
  judgeModel: "openai-codex/gpt-5.6-sol",
  /**
   * Thinking level for the judge.
   */
  judgeThinking: "low",
  /**
   * Judge calls running at once.
   */
  judgeConcurrency: 8,
  /**
   * A judge call still running after this long is retried once, then recorded as unknown.
   */
  judgeTimeoutMs: 120_000,
} as const;
