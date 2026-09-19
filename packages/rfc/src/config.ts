import { Schema } from "effect";
import { ENV } from "./env";

/**
 * Schema for configuration consumed by the CLI composition root.
 */
export const RfcCliConfigSchema = Schema.Struct({
  apiKey: Schema.String,
  modelAlias: Schema.NonEmptyString,
  policyPreset: Schema.NonEmptyString,
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
  });
