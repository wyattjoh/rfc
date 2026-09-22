import { Cause, Clock, Data, Duration, Effect, Schedule, Schema } from "effect";
import * as AiError from "effect/unstable/ai/AiError";

/**
 * A typed failure from an official DecisionModel request.
 */
export class DecisionModelError extends Schema.TaggedError<DecisionModelError>()(
  "DecisionModelError",
  {
    stage: Schema.Literals(["rank", "section", "paragraph", "citation"]),
    reason: Schema.String,
    attempts: Schema.optionalKey(Schema.Natural),
  },
) {}

/**
 * How one caller retries DecisionModel requests and words the failures.
 */
export interface DecisionRetryPolicy {
  /**
   * Pipeline stage recorded on every `DecisionModelError`.
   */
  readonly stage: DecisionModelError["stage"];
  /**
   * Total attempts, including the first.
   */
  readonly maxAttempts: number;
  /**
   * Elapsed-time budget shared by every attempt and retry delay.
   */
  readonly maxElapsedMilliseconds: number;
  /**
   * When the budget started; `undefined` starts it when the retry begins.
   */
  readonly startedAt: number | undefined;
  /**
   * Retry delay used when the provider supplies no usable `retryAfter`.
   *
   * @param error The retryable provider failure.
   * @param failedAttempts Attempts that have failed so far, starting at 1.
   * @returns The delay in milliseconds before the next attempt.
   */
  readonly baseDelayMilliseconds: (error: AiError.AiError, failedAttempts: number) => number;
  /**
   * Failure reasons, kept per caller so existing error wording is preserved.
   */
  readonly reasons: {
    /**
     * The budget ran out before attempt `attempt` could start.
     */
    readonly budgetBeforeAttempt: (attempt: number) => string;
    /**
     * Attempt `attempt` timed out or finished past the budget.
     */
    readonly budgetDuringAttempt: (attempt: number) => string;
    /**
     * The provider failed with an error that is not retryable.
     */
    readonly rejected: (error: unknown) => string;
    /**
     * A retryable failure remained after the attempt or time budget ran out.
     */
    readonly exhausted: (error: AiError.AiError, attempts: number) => string;
  };
}

class BudgetExhausted extends Data.TaggedError("BudgetExhausted")<{
  readonly phase: "before" | "during";
  readonly attempt: number;
}> {}

const retryDelayMilliseconds = (
  policy: DecisionRetryPolicy,
  error: AiError.AiError,
  failedAttempts: number,
): number => {
  const retryAfter =
    error.retryAfter === undefined ? Number.NaN : Duration.toMillis(error.retryAfter);
  return Number.isFinite(retryAfter) && retryAfter >= 0
    ? retryAfter
    : policy.baseDelayMilliseconds(error, failedAttempts);
};

/**
 * Run a DecisionModel request with bounded retries and one elapsed-time budget.
 *
 * Retryable `AiError`s are retried after the provider's `retryAfter` or the
 * policy's base delay. A retry whose delay would cross the budget is refused
 * rather than slept on, and each attempt is timed out at the budget that remains.
 * `operation` is re-run for each attempt, so build it with `Effect.suspend` when
 * constructing it has side effects.
 *
 * @param policy Attempt, budget, delay, and failure-wording policy.
 * @param operation The DecisionModel request to run.
 * @returns The request result, or a `DecisionModelError` with the attempts made.
 */
export const retryDecisionModel = <A, R>(
  policy: DecisionRetryPolicy,
  operation: Effect.Effect<A, AiError.AiError, R>,
): Effect.Effect<A, DecisionModelError, R> =>
  Effect.gen(function* () {
    const startedAt = policy.startedAt ?? (yield* Clock.currentTimeMillis);
    let attempts = 0;
    // Scheduled delays count against the budget even when a test clock does not advance.
    let scheduledDelay = 0;
    const elapsedAt = (now: number): number => Math.max(0, now - startedAt, scheduledDelay);

    const attempt = Effect.gen(function* () {
      const elapsedBefore = elapsedAt(yield* Clock.currentTimeMillis);
      if (elapsedBefore >= policy.maxElapsedMilliseconds) {
        return yield* new BudgetExhausted({ phase: "before", attempt: attempts + 1 });
      }
      attempts += 1;
      const current = attempts;
      const value = yield* operation.pipe(
        Effect.timeout(Duration.millis(policy.maxElapsedMilliseconds - elapsedBefore)),
        Effect.catchIf(Cause.isTimeoutError, () =>
          Effect.fail(new BudgetExhausted({ phase: "during", attempt: current })),
        ),
      );
      if (elapsedAt(yield* Clock.currentTimeMillis) > policy.maxElapsedMilliseconds) {
        return yield* new BudgetExhausted({ phase: "during", attempt: current });
      }
      return value;
    });

    const schedule = Schedule.fromStepWithMetadata(
      Effect.succeed((meta: Schedule.InputMetadata<AiError.AiError | BudgetExhausted>) => {
        const error = meta.input;
        if (!AiError.isAiError(error) || !error.isRetryable) return Cause.done(meta.attempt);
        const delay = retryDelayMilliseconds(policy, error, meta.attempt);
        if (
          meta.attempt >= policy.maxAttempts ||
          elapsedAt(meta.now) + delay > policy.maxElapsedMilliseconds
        ) {
          return Cause.done(meta.attempt);
        }
        scheduledDelay += delay;
        return Effect.succeed<[number, Duration.Duration]>([meta.attempt, Duration.millis(delay)]);
      }),
    );

    return yield* attempt.pipe(
      Effect.retry(schedule),
      Effect.mapError((error) => {
        if (error._tag === "BudgetExhausted") {
          return new DecisionModelError({
            stage: policy.stage,
            reason:
              error.phase === "before"
                ? policy.reasons.budgetBeforeAttempt(error.attempt)
                : policy.reasons.budgetDuringAttempt(error.attempt),
            attempts: error.phase === "before" ? error.attempt - 1 : error.attempt,
          });
        }
        return new DecisionModelError({
          stage: policy.stage,
          reason: error.isRetryable
            ? policy.reasons.exhausted(error, attempts)
            : policy.reasons.rejected(error),
          attempts,
        });
      }),
    );
  });
