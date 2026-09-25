import { describe, expect, test } from "bun:test";
import { hashRfcSource } from "../src/source";
import { sourceTextResult } from "../src/source-text";

const text = "Abstract\n\nCafé.\n\n1. Requirements\n\nThe client MUST send.\n";
const source = {
  identifier: "RFC9110",
  rfcNumber: 9110,
  sourceUrl: "https://www.rfc-editor.org/rfc/rfc9110.txt",
  text,
  contentHash: hashRfcSource(text),
  fetchedAt: "2026-01-01T00:00:00Z",
};

const request = { schemaVersion: 3 as const, rfc: "RFC9110" };

describe("RFC source text ranges", () => {
  test("returns metadata and navigable UTF-8 section ranges without text", () => {
    const result = sourceTextResult(source, request);
    expect(result.text).toBeNull();
    expect(result.totalBytes).toBe(Buffer.byteLength(text));
    expect(result.sourceHash).toBe(source.contentHash);
    expect(result.offsetUnit).toBe("utf8-byte");
    expect(result.headings).toEqual([
      { number: null, title: "Abstract", depth: 1, startOffset: 0, endOffset: 18 },
      {
        number: "1",
        title: "Requirements",
        depth: 1,
        startOffset: 18,
        endOffset: Buffer.byteLength(text),
      },
    ]);
  });

  test("returns an exact citation-compatible range with no truncation", () => {
    const startOffset = Buffer.byteLength("Abstract\n\n");
    const endOffset = startOffset + Buffer.byteLength("Café.");
    expect(
      sourceTextResult(source, {
        ...request,
        startOffset,
        endOffset,
        expectedSourceHash: source.contentHash,
      }),
    ).toMatchObject({
      startOffset,
      endOffset,
      text: "Café.",
      headings: [],
    });
    expect(
      sourceTextResult(source, { ...request, startOffset: 0, endOffset: Buffer.byteLength(text) })
        .text,
    ).toBe(text);
  });

  test("rejects split UTF-8 boundaries, empty and out-of-bounds ranges, and drift", () => {
    const startOffset = Buffer.byteLength("Abstract\n\nCaf");
    expect(() =>
      sourceTextResult(source, {
        ...request,
        startOffset: startOffset + 1,
        endOffset: startOffset + 3,
      }),
    ).toThrow("UTF-8 character boundaries");
    expect(() => sourceTextResult(source, { ...request, startOffset: 0, endOffset: 0 })).toThrow(
      "non-empty",
    );
    expect(() => sourceTextResult(source, { ...request, startOffset: 0, endOffset: 999 })).toThrow(
      "within the source",
    );
    expect(() => sourceTextResult(source, { ...request, startOffset: 0 })).toThrow("non-empty");
    expect(() => sourceTextResult(source, { ...request, expectedSourceHash: "older" })).toThrow(
      "source hash changed",
    );
  });
});
