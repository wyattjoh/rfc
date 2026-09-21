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

const splitsSurrogatePair = (text: string, offset: number): boolean => {
  if (offset <= 0 || offset >= text.length) return false;
  const previous = text.charCodeAt(offset - 1);
  const current = text.charCodeAt(offset);
  return previous >= 0xd800 && previous <= 0xdbff && current >= 0xdc00 && current <= 0xdfff;
};

/**
 * Count the UTF-8 bytes encoding a code-unit range that starts and ends on a
 * complete boundary. An unpaired surrogate encodes as the replacement
 * character, matching `TextEncoder` and `Buffer.byteLength`.
 */
const utf8ByteLengthBetween = (text: string, from: number, to: number): number => {
  let bytes = 0;
  for (let index = from; index < to; index += 1) {
    const code = text.charCodeAt(index);
    if (code < 0x80) {
      bytes += 1;
      continue;
    }
    if (code < 0x800) {
      bytes += 2;
      continue;
    }
    if (code >= 0xd800 && code <= 0xdbff && index + 1 < to) {
      const next = text.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        index += 1;
        continue;
      }
    }
    bytes += 3;
  }
  return bytes;
};

/**
 * Build UTF-8 byte offsets for the exact JavaScript string used as source text.
 *
 * Offsets are computed on demand rather than materialized, because a source is
 * an entire RFC while a request resolves only a handful of block boundaries.
 * The cursor makes the common ascending access pattern linear across all of a
 * source's lookups instead of rescanning the prefix for each one.
 *
 * @param text Exact authoritative source text.
 * @returns A map that validates and converts string boundaries to UTF-8 bytes.
 */
export const makeUtf8OffsetMap = (text: string): Utf8OffsetMap => {
  let cursorCodeUnit = 0;
  let cursorByte = 0;
  return {
    byteOffsetAtCodeUnit: (offset) => {
      if (!Number.isInteger(offset) || offset < 0 || offset > text.length) return undefined;
      if (splitsSurrogatePair(text, offset)) return undefined;
      if (offset < cursorCodeUnit) {
        cursorCodeUnit = 0;
        cursorByte = 0;
      }
      cursorByte += utf8ByteLengthBetween(text, cursorCodeUnit, offset);
      cursorCodeUnit = offset;
      return cursorByte;
    },
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
  if (!splitsSurrogatePair(text, offset)) return offset;
  return direction === "forward" ? offset + 1 : offset - 1;
};
