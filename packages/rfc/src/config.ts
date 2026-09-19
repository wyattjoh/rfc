import { readFileSync } from "node:fs";
import { Schema } from "effect";
import {
  automaticAnswerActivationFromReport,
  evaluationModelAlias,
  evaluationPolicy,
  pinnedJevModel,
} from "@wyattjoh/rfc-core";
import type { AutomaticAnswerActivation } from "@wyattjoh/rfc-core";

/**
 * Schema for non-secret configuration consumed by the CLI composition root.
 */
export const RfcCliConfigSchema = Schema.Struct({
  modelAlias: Schema.Literal(pinnedJevModel),
  policyPreset: Schema.Literal(evaluationPolicy.policyVersion),
  evaluationModel: Schema.Literal(evaluationModelAlias),
  pinnedModel: Schema.Literal(pinnedJevModel),
  liveEvaluation: Schema.Boolean,
  automaticAnswerEnabled: Schema.Boolean,
  evaluationCacheDirectory: Schema.NonEmptyString,
  evaluationOutput: Schema.NonEmptyString,
});

/**
 * Configuration needed by the CLI composition root after typed defaults are
 * applied. It contains no provider credential.
 */
export type RfcCliConfig = Schema.Schema.Type<typeof RfcCliConfigSchema>;

/**
 * Explicit non-secret configuration overrides used by the live evaluator and
 * deterministic callers. Every field is intentionally typed and non-secret.
 */
export interface RfcCliConfigOverrides {
  /**
   * Whether the caller explicitly enabled the live evaluator.
   */
  readonly liveEvaluation: boolean | undefined;
  /**
   * Whether a reviewed calibration report may activate answered results.
   */
  readonly automaticAnswerEnabled: boolean | undefined;
  /**
   * Directory used for evaluation source caches.
   */
  readonly evaluationCacheDirectory: string | undefined;
  /**
   * Path used for the sanitized evaluation report.
   */
  readonly evaluationOutput: string | undefined;
}

const defaultConfigValue = {
  modelAlias: pinnedJevModel,
  policyPreset: evaluationPolicy.policyVersion,
  evaluationModel: evaluationModelAlias,
  pinnedModel: pinnedJevModel,
  liveEvaluation: false,
  automaticAnswerEnabled: false,
  evaluationCacheDirectory: ".scratch/rfc-evaluation-cache",
  evaluationOutput: ".scratch/rfc-evaluation-report.json",
} satisfies RfcCliConfig;

const noOverrides: RfcCliConfigOverrides = {
  liveEvaluation: undefined,
  automaticAnswerEnabled: undefined,
  evaluationCacheDirectory: undefined,
  evaluationOutput: undefined,
};

/**
 * The typed non-secret defaults used by ordinary CLI commands.
 */
export const defaultCliConfig: RfcCliConfig = Object.freeze(
  Schema.decodeUnknownSync(RfcCliConfigSchema)(defaultConfigValue),
);

/**
 * Read typed non-secret CLI configuration without consulting environment
 * variables, dotenv files, or a credential store.
 *
 * @param overrides Explicit non-secret values supplied by a command or test.
 * @returns Schema-validated CLI configuration.
 */
export const readCliConfig = (overrides: RfcCliConfigOverrides = noOverrides): RfcCliConfig =>
  Schema.decodeUnknownSync(RfcCliConfigSchema)({
    ...defaultCliConfig,
    liveEvaluation: overrides.liveEvaluation ?? defaultCliConfig.liveEvaluation,
    automaticAnswerEnabled:
      overrides.automaticAnswerEnabled ?? defaultCliConfig.automaticAnswerEnabled,
    evaluationCacheDirectory:
      overrides.evaluationCacheDirectory ?? defaultCliConfig.evaluationCacheDirectory,
    evaluationOutput: overrides.evaluationOutput ?? defaultCliConfig.evaluationOutput,
  });

/**
 * Resolve automatic-answer activation from an explicit opt-in and a passing
 * calibration artifact with the current release attestation.
 *
 * @param config Validated non-secret CLI configuration.
 * @returns An opaque activation proof, or undefined when activation fails closed.
 */
export const automaticAnswerActivationFor = (
  config: RfcCliConfig,
): AutomaticAnswerActivation | undefined => {
  if (!config.automaticAnswerEnabled) return undefined;
  try {
    const report = JSON.parse(readFileSync(config.evaluationOutput, "utf8")) as unknown;
    return automaticAnswerActivationFromReport(report);
  } catch {
    return undefined;
  }
};
