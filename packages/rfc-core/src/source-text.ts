import { Schema } from "effect";
import { makeUtf8OffsetMap, utf8OffsetUnit } from "./offsets";
import { schemaVersion } from "./protocol";
import { parseRfcStructure } from "./sections";
import type { RfcSource } from "./source";

/**
 * Request for source metadata or an exact half-open UTF-8 byte range.
 */
export const RfcSourceTextRequestSchema = Schema.Struct({
  schemaVersion: Schema.Literal(schemaVersion),
  rfc: Schema.NonEmptyString,
  startOffset: Schema.optionalKey(Schema.Natural),
  endOffset: Schema.optionalKey(Schema.Natural),
  expectedSourceHash: Schema.optionalKey(Schema.NonEmptyString),
});

/**
 * A validated source-text request.
 */
export type RfcSourceTextRequest = Schema.Schema.Type<typeof RfcSourceTextRequestSchema>;

/**
 * One parsed heading and its half-open UTF-8 source range.
 */
export const RfcSourceHeadingSchema = Schema.Struct({
  number: Schema.NullOr(Schema.String),
  title: Schema.String,
  depth: Schema.Natural,
  startOffset: Schema.Natural,
  endOffset: Schema.Natural,
});

/**
 * Source identity and either a navigable section index or an exact text slice.
 */
export const RfcSourceTextResultSchema = Schema.Struct({
  schemaVersion: Schema.Literal(schemaVersion),
  kind: Schema.Literal("source_text"),
  rfc: Schema.NonEmptyString,
  sourceUrl: Schema.NonEmptyString,
  sourceHash: Schema.NonEmptyString,
  offsetUnit: Schema.Literal(utf8OffsetUnit),
  totalBytes: Schema.Natural,
  startOffset: Schema.NullOr(Schema.Natural),
  endOffset: Schema.NullOr(Schema.Natural),
  text: Schema.NullOr(Schema.String),
  headings: Schema.Array(RfcSourceHeadingSchema),
});

/**
 * Decoded source-text result.
 */
export type RfcSourceTextResult = Schema.Schema.Type<typeof RfcSourceTextResultSchema>;

/**
 * Render a validated request from an authoritative source, preserving exact
 * byte offsets even when the text contains multi-byte characters.
 *
 * @param source Canonical RFC Editor text with its content hash.
 * @param request Decoded source-text request.
 * @returns A metadata index or the exact requested byte slice.
 * @throws Error for invalid ranges or a changed source identity.
 */
export const sourceTextResult = (
  source: RfcSource,
  request: RfcSourceTextRequest,
): RfcSourceTextResult => {
  if (
    request.expectedSourceHash !== undefined &&
    request.expectedSourceHash !== source.contentHash
  ) {
    throw new Error("RFC source hash changed; request fresh metadata before continuing");
  }
  const bytes = Buffer.from(source.text, "utf8");
  const base = {
    schemaVersion,
    kind: "source_text" as const,
    rfc: source.identifier,
    sourceUrl: source.sourceUrl,
    sourceHash: source.contentHash,
    offsetUnit: utf8OffsetUnit,
    totalBytes: bytes.length,
  };
  const { startOffset, endOffset } = request;
  if (startOffset === undefined && endOffset === undefined) {
    const offsets = makeUtf8OffsetMap(source.text);
    const byteOffsetAt = (position: number): number => {
      const offset = offsets.byteOffsetAtCodeUnit(position);
      if (offset === undefined) throw new Error("Parsed heading splits a UTF-8 character");
      return offset;
    };
    return {
      ...base,
      startOffset: null,
      endOffset: null,
      text: null,
      headings: parseRfcStructure(source.text).sections.map((section) => ({
        number: section.number ?? null,
        title: section.title,
        depth: section.depth,
        startOffset: byteOffsetAt(section.startOffset),
        endOffset: byteOffsetAt(section.endOffset),
      })),
    };
  }
  if (
    startOffset === undefined ||
    endOffset === undefined ||
    startOffset >= endOffset ||
    endOffset > bytes.length ||
    (startOffset > 0 && ((bytes[startOffset] ?? 0) & 0xc0) === 0x80) ||
    (endOffset < bytes.length && ((bytes[endOffset] ?? 0) & 0xc0) === 0x80)
  ) {
    throw new Error(
      "Source range must be non-empty, within the source, and on UTF-8 character boundaries",
    );
  }
  return {
    ...base,
    startOffset,
    endOffset,
    text: bytes.subarray(startOffset, endOffset).toString("utf8"),
    headings: [],
  };
};
