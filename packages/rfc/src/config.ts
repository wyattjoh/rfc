import { readFileSync } from "node:fs";
import { Schema } from "effect";
import {
  automaticAnswerActivationFromReport,
  evaluationPolicy,
  pinnedJevModel,
} from "@wyattjoh/rfc-core";
import type { AutomaticAnswerActivation } from "@wyattjoh/rfc-core";
import { ENV } from "./env";

/**
 * Schema for configuration consumed by the CLI composition root.
 */
export const RfcCliConfigSchema = Schema.Struct({
  apiKey: Schema.String,
  modelAlias: Schema.Literal(pinnedJevModel),
  policyPreset: Schema.Literal(evaluationPolicy.policyVersion),
  evaluationModel: Schema.NonEmptyString,
  pinnedModel: Schema.NonEmptyString,
  liveEvaluation: Schema.Boolean,
  automaticAnswerEnabled: Schema.Boolean,
  evaluationCacheDirectory: Schema.NonEmptyString,
  evaluationOutput: Schema.NonEmptyString,
});

/**
 * Configuration needed by the CLI composition root after Varlock has loaded.
 */
export type RfcCliConfig = Schema.Schema.Type<typeof RfcCliConfigSchema>;

/**
 * Read and validate typed, Varlock-backed configuration without exposing
 * process environment access to the core.
 *
 * @returns The CLI configuration, including the provider credential for wiring.
 * @throws Schema.SchemaError when Varlock does not provide valid configuration.
 */
export const readCliConfig = (): RfcCliConfig =>
  Schema.decodeUnknownSync(RfcCliConfigSchema)({
    apiKey: ENV.TYPESAFE_API_KEY,
    modelAlias: ENV.TYPESAFE_MODEL,
    policyPreset: ENV.RFC_POLICY_PRESET,
    evaluationModel: ENV.RFC_EVALUATION_MODEL,
    pinnedModel: ENV.RFC_PINNED_MODEL,
    liveEvaluation: ENV.RFC_LIVE_EVALUATION,
    automaticAnswerEnabled: ENV.RFC_AUTOMATIC_ANSWER_ENABLED,
    evaluationCacheDirectory: ENV.RFC_EVALUATION_CACHE_DIRECTORY,
    evaluationOutput: ENV.RFC_EVALUATION_OUTPUT,
  });

/**
 * Resolve automatic-answer activation from an explicit environment opt-in and
 * a passing calibration artifact with the current release attestation.
 *
 * @param config Validated Varlock-backed CLI configuration.
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
