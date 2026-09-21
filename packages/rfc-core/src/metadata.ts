import { Schema } from "effect";

/**
 * Schema for request-local RFC metadata returned by live discovery.
 *
 * Relationship fields contain only edges fetched while handling the current
 * request. Values are never persisted or assembled into a complete corpus.
 */
export const RfcMetadataSchema = Schema.Struct({
  identifier: Schema.NonEmptyString.check(Schema.isMaxLength(64)),
  rfcNumber: Schema.Int.check(Schema.isGreaterThan(0)),
  title: Schema.String.check(Schema.isMaxLength(2_000)),
  abstract: Schema.String.check(Schema.isMaxLength(100_000)),
  status: Schema.NonEmptyString.check(Schema.isMaxLength(256)),
  stream: Schema.NonEmptyString.check(Schema.isMaxLength(256)),
  canonicalUrl: Schema.NonEmptyString.check(Schema.isMaxLength(2_048)),
  updates: Schema.Array(Schema.NonEmptyString),
  updatedBy: Schema.Array(Schema.NonEmptyString),
  obsoletes: Schema.Array(Schema.NonEmptyString),
  obsoletedBy: Schema.Array(Schema.NonEmptyString),
}).check(
  Schema.makeFilter((document) =>
    document.identifier === `RFC${document.rfcNumber}`
      ? undefined
      : {
          path: ["identifier"],
          issue: "identifier must be RFC followed by its RFC number",
        },
  ),
);

/**
 * Request-local RFC metadata used by discovery and semantic research.
 */
export type RfcMetadata = Schema.Schema.Type<typeof RfcMetadataSchema>;
