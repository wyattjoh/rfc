import { createHash } from "node:crypto";
import { Schema } from "effect";
import type { RfcMetadata } from "./metadata";

/**
 * The default RFC Editor plain-text base URL.
 */
export const defaultRfcEditorBaseUrl = "https://www.rfc-editor.org/rfc/";

/**
 * A source fetched from the authoritative RFC Editor plain-text endpoint.
 */
export const RfcSourceSchema = Schema.Struct({
  identifier: Schema.NonEmptyString,
  rfcNumber: Schema.Natural,
  sourceUrl: Schema.NonEmptyString,
  text: Schema.String,
  contentHash: Schema.NonEmptyString,
  fetchedAt: Schema.String,
});

/**
 * A decoded authoritative RFC source.
 */
export type RfcSource = Schema.Schema.Type<typeof RfcSourceSchema>;

/**
 * Failure while fetching authoritative RFC text.
 */
export class RfcSourceFetchError extends Schema.TaggedError<RfcSourceFetchError>()(
  "RfcSourceFetchError",
  {
    stage: Schema.Literals(["request", "decode"]),
    url: Schema.String,
    reason: Schema.String,
    /**
     * RFC Editor response status, when one was received.
     */
    status: Schema.optionalKey(Schema.Number),
  },
) {}

/**
 * Failure while reading, validating, or writing an RFC source cache entry.
 */
export class RfcSourceCacheError extends Schema.TaggedError<RfcSourceCacheError>()(
  "RfcSourceCacheError",
  {
    stage: Schema.Literals(["read", "decode", "write"]),
    sourcePath: Schema.String,
    reason: Schema.String,
  },
) {}

/**
 * A plain-text source payload supplied by a deterministic test or embedded caller.
 */
export interface RfcSourcePayload {
  /**
   * The authoritative source URL represented by the payload.
   */
  readonly sourceUrl: string | undefined;
  /**
   * The exact RFC Editor plain-text body.
   */
  readonly text: string;
}

/**
 * A Promise-returning source replacement used by deterministic tests.
 */
export type RfcSourceFetcher = (document: RfcMetadata) => Promise<RfcSourcePayload | string>;

/**
 * Calculate the stable SHA-256 identity for an RFC source body.
 *
 * @param text Exact source text encoded as UTF-8.
 * @returns A lowercase hexadecimal SHA-256 digest.
 */
export const hashRfcSource = (text: string): string =>
  createHash("sha256").update(text, "utf8").digest("hex");

/**
 * Build the authoritative RFC Editor plain-text URL for a published RFC.
 *
 * @param baseUrl RFC Editor base URL.
 * @param rfcNumber Published RFC number.
 * @returns The plain-text source URL derived from the configured base URL.
 * @throws Error when the configured base URL is invalid.
 */
export const makeRfcSourceUrl = (baseUrl: string, rfcNumber: number): string => {
  const base = new URL(baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);
  return new URL(`rfc${rfcNumber}.txt`, base).toString();
};
