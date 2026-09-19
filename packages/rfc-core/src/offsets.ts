/**
 * The canonical unit for source offsets exchanged by the evidence APIs.
 */
export const utf8OffsetUnit = "utf8-byte" as const;

/**
 * A lookup between JavaScript code-unit boundaries and UTF-8 byte offsets.
 */
export interface Utf8OffsetMap {
  /**
   * Convert a JavaScript string boundary to a UTF-8 byte offset.
   *
   * The result is undefined for an offset in the middle of a surrogate pair,
   * because that position cannot identify a boundary in the UTF-8 source.
   */
  readonly byteOffsetAtCodeUnit: (offset: number) => number | undefined;
}

const utf8Encoder = new TextEncoder();

/**
 * Build UTF-8 byte offsets for the exact JavaScript string used as source text.
 *
 * @param text Exact authoritative source text.
 * @returns A map that validates and converts string boundaries to UTF-8 bytes.
 */
export const makeUtf8OffsetMap = (text: string): Utf8OffsetMap => {
  const byteOffsets = new Map<number, number>([[0, 0]]);
  let codeUnitOffset = 0;
  let byteOffset = 0;
  for (const codePoint of text) {
    codeUnitOffset += codePoint.length;
    byteOffset += utf8Encoder.encode(codePoint).byteLength;
    byteOffsets.set(codeUnitOffset, byteOffset);
  }
  return {
    byteOffsetAtCodeUnit: (offset) => byteOffsets.get(offset),
  };
};

/**
 * Move a JavaScript string position away from the interior of a surrogate pair.
 *
 * @param text Exact source text containing the position.
 * @param offset JavaScript UTF-16 code-unit position.
 * @param direction Direction used when the position splits a surrogate pair.
 * @returns A position that is a complete UTF-8 source boundary.
 */
export const moveToUtf8Boundary = (
  text: string,
  offset: number,
  direction: "forward" | "backward",
): number => {
  if (offset <= 0 || offset >= text.length) return offset;
  const previous = text.charCodeAt(offset - 1);
  const current = text.charCodeAt(offset);
  const splitsSurrogatePair =
    previous >= 0xd800 && previous <= 0xdbff && current >= 0xdc00 && current <= 0xdfff;
  if (!splitsSurrogatePair) return offset;
  return direction === "forward" ? offset + 1 : offset - 1;
};
