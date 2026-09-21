import { describe, expect, test } from "bun:test";
import { makeUtf8OffsetMap, moveToUtf8Boundary, utf8OffsetUnit } from "../src/index";

const encoder = new TextEncoder();

/**
 * Independent reference: encode the prefix and measure it. This is the
 * definition the declared `utf8-byte` offset unit has to satisfy, derived
 * separately from the implementation under test.
 */
const referenceByteOffset = (text: string, codeUnitOffset: number): number =>
  encoder.encode(text.slice(0, codeUnitOffset)).byteLength;

const astral = "a\u{1F600}b";
const loneHighSurrogate = "a\uD800b";

describe("utf8 offset map", () => {
  test("declares the canonical offset unit", () => {
    expect(utf8OffsetUnit).toBe("utf8-byte");
  });

  test("agrees with encoding the prefix, across scripts and planes", () => {
    for (const text of [
      "",
      "ascii only",
      "café latte",
      "中文测试",
      "é combining",
      astral,
      "\u{1F600}\u{1F468}‍\u{1F469}‍\u{1F467}",
      "mixed é 中 \u{1F600} end",
    ]) {
      const offsets = makeUtf8OffsetMap(text);
      for (let codeUnit = 0; codeUnit <= text.length; codeUnit += 1) {
        if (moveToUtf8Boundary(text, codeUnit, "forward") !== codeUnit) continue;
        expect(offsets.byteOffsetAtCodeUnit(codeUnit)).toBe(referenceByteOffset(text, codeUnit));
      }
    }
  });

  test("quotes sliced at mapped offsets round-trip through UTF-8 bytes", () => {
    const text = `intro ${astral} middle 中文 tail`;
    const offsets = makeUtf8OffsetMap(text);
    const start = text.indexOf(astral);
    const end = start + astral.length;
    const startByte = offsets.byteOffsetAtCodeUnit(start);
    const endByte = offsets.byteOffsetAtCodeUnit(end);
    expect(startByte).toBeDefined();
    expect(endByte).toBeDefined();

    const sourceBytes = encoder.encode(text);
    const quotedBytes = sourceBytes.slice(startByte, endByte);
    expect(new TextDecoder("utf8", { fatal: true }).decode(quotedBytes)).toBe(
      text.slice(start, end),
    );
  });

  test("refuses an offset inside a surrogate pair", () => {
    const offsets = makeUtf8OffsetMap(astral);
    // "a" is one code unit; the emoji occupies the next two.
    expect(offsets.byteOffsetAtCodeUnit(1)).toBe(1);
    expect(offsets.byteOffsetAtCodeUnit(2)).toBeUndefined();
    expect(offsets.byteOffsetAtCodeUnit(3)).toBe(5);
  });

  test("refuses offsets outside the source", () => {
    const offsets = makeUtf8OffsetMap("abc");
    expect(offsets.byteOffsetAtCodeUnit(-1)).toBeUndefined();
    expect(offsets.byteOffsetAtCodeUnit(4)).toBeUndefined();
    expect(offsets.byteOffsetAtCodeUnit(1.5)).toBeUndefined();
    expect(offsets.byteOffsetAtCodeUnit(Number.NaN)).toBeUndefined();
  });

  test("encodes an unpaired surrogate as the replacement character", () => {
    const offsets = makeUtf8OffsetMap(loneHighSurrogate);
    expect(offsets.byteOffsetAtCodeUnit(3)).toBe(
      referenceByteOffset(loneHighSurrogate, loneHighSurrogate.length),
    );
  });

  test("returns the same offset whatever order boundaries are requested in", () => {
    const text = `${astral} 中文 plain ${astral}`;
    const ascending = makeUtf8OffsetMap(text);
    const descending = makeUtf8OffsetMap(text);
    const boundaries = [...Array(text.length + 1).keys()].filter(
      (codeUnit) => moveToUtf8Boundary(text, codeUnit, "forward") === codeUnit,
    );
    const forward = boundaries.map((codeUnit) => ascending.byteOffsetAtCodeUnit(codeUnit));
    const backward = [...boundaries]
      .reverse()
      .map((codeUnit) => descending.byteOffsetAtCodeUnit(codeUnit));
    expect(forward).toEqual([...backward].reverse());
  });

  test("resolves a whole source's boundaries without materializing per code point", () => {
    // Regression guard for the per-passage rebuild that dominated research
    // latency: an RFC-scale source resolved repeatedly must stay cheap.
    let text = "";
    while (text.length < 600_000) text += "The server MUST send a Location header field.\n   ";
    const started = Bun.nanoseconds();
    for (let passage = 0; passage < 8; passage += 1) {
      const offsets = makeUtf8OffsetMap(text);
      expect(offsets.byteOffsetAtCodeUnit(Math.floor((text.length * passage) / 8))).toBeDefined();
      expect(offsets.byteOffsetAtCodeUnit(text.length)).toBe(text.length);
    }
    expect((Bun.nanoseconds() - started) / 1e6).toBeLessThan(250);
  });
});

describe("utf8 boundary movement", () => {
  test("leaves a complete boundary untouched", () => {
    for (const offset of [0, 1, 4]) {
      expect(moveToUtf8Boundary(astral, offset, "forward")).toBe(offset);
      expect(moveToUtf8Boundary(astral, offset, "backward")).toBe(offset);
    }
  });

  test("steps out of a split surrogate pair in the requested direction", () => {
    expect(moveToUtf8Boundary(astral, 2, "forward")).toBe(3);
    expect(moveToUtf8Boundary(astral, 2, "backward")).toBe(1);
  });
});
