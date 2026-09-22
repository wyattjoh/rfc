import { Schema } from "effect";
import { retrievalPolicy } from "@wyattjoh/rfc-core";

/**
 * Schema for non-secret configuration consumed by the CLI composition root.
 */
export const RfcCliConfigSchema = Schema.Struct({
  modelAlias: Schema.Literal(retrievalPolicy.pinnedModel),
});

/**
 * Configuration needed by the CLI composition root after typed defaults are
 * applied. It contains no provider credential.
 */
export type RfcCliConfig = Schema.Schema.Type<typeof RfcCliConfigSchema>;

/**
 * The typed non-secret defaults used by ordinary CLI commands.
 */
export const defaultCliConfig: RfcCliConfig = Object.freeze(
  Schema.decodeUnknownSync(RfcCliConfigSchema)({ modelAlias: retrievalPolicy.pinnedModel }),
);

/**
 * Read typed non-secret CLI configuration without consulting environment
 * variables, dotenv files, or a credential store.
 *
 * @returns Schema-validated CLI configuration.
 */
export const readCliConfig = (): RfcCliConfig =>
  Schema.decodeUnknownSync(RfcCliConfigSchema)(defaultCliConfig);
