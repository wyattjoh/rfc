import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { makeUtf8OffsetMap } from "../src/offsets";
import { paragraphMaximumCharacters, parseRfcStructure, sectionAtOffset } from "../src/sections";

const rfc6585 = readFileSync(join(import.meta.dir, "fixtures", "rfc6585.txt"), "utf8");

const pageBreak = [
  "Example & Author             Standards Track                    [Page 3]",
  "\f",
  "RFC 9999                 Example Protocol                  March 2024",
  "",
  "",
].join("\n");

const synthetic = [
  "Internet Engineering Task Force (IETF)                         E. Author",
  "Request for Comments: 9999                                    March 2024",
  "",
  "Abstract",
  "",
  "   This document describes an example protocol.",
  "",
  "Table of Contents",
  "",
  "   1. Introduction ....................................................2",
  "   Appendix A. Extras .................................................3",
  "",
  "1.  Introduction",
  "",
  "   The first half of a paragraph that runs across",
  pageBreak,
  "   a page break and ends here.",
  "",
  "2.  Long Section",
  "",
  ...Array.from(
    { length: 40 },
    (_, index) => `   Line ${index} of a very long paragraph with enough text to be long.`,
  ),
  "",
  "Appendix A.  Extras",
  "",
  "   Appendix text with a non-ASCII name: Dürst.",
  "",
  "A.1.  Nested Extras",
  "",
  "   Nested appendix text.",
  "",
].join("\n");

describe("parseRfcStructure", () => {
  test("parses real RFC headings, depths, and parents while skipping the table of contents", () => {
    const { sections } = parseRfcStructure(rfc6585);
    expect(sections.map(({ heading }) => heading)).toEqual([
      "Abstract",
      "Status of This Memo",
      "Copyright Notice",
      "1.  Introduction",
      "2.  Requirements",
      "3.  428 Precondition Required",
      "4.  429 Too Many Requests",
      "5.  431 Request Header Fields Too Large",
      "6.  511 Network Authentication Required",
      "6.1.  The 511 Status Code and Captive Portals",
      "7.  Security Considerations",
      "7.1.  428 Precondition Required",
      "7.2.  429 Too Many Requests",
      "7.3.  431 Request Header Fields Too Large",
      "7.4.  511 Network Authentication Required",
      "8.  IANA Considerations",
      "9.  References",
      "9.1.  Normative References",
      "9.2.  Informative References",
      "Appendix A.  Acknowledgements",
      "Appendix B.  Issues Raised by Captive Portals",
      "Authors' Addresses",
    ]);
    const nested = sections.find(({ number }) => number === "6.1");
    expect(nested?.depth).toBe(2);
    expect(nested?.title).toBe("The 511 Status Code and Captive Portals");
    expect(sections[nested?.parent ?? -1]?.number).toBe("6");
  });

  test("returns only exact substrings free of page furniture", () => {
    const { paragraphs } = parseRfcStructure(rfc6585);
    expect(paragraphs.length).toBeGreaterThan(20);
    for (const paragraph of paragraphs) {
      expect(rfc6585.slice(paragraph.startOffset, paragraph.endOffset)).toBe(paragraph.text);
      expect(paragraph.text).not.toContain("\f");
      expect(paragraph.text).not.toMatch(/\[Page \d+\]/);
      expect(paragraph.text).not.toMatch(/^RFC 6585 {2,}/m);
      expect(paragraph.text).toBe(paragraph.text.trim());
    }
    expect(paragraphs.some(({ text }) => text.includes("...................."))).toBe(false);
  });

  test("assigns paragraphs to their sections", () => {
    const { sections, paragraphs } = parseRfcStructure(rfc6585);
    const tooMany = sections.find(({ number }) => number === "4");
    const first = paragraphs.find(({ section }) => section === tooMany?.index);
    expect(first?.text.startsWith("The 429 status code indicates")).toBe(true);
  });

  test("splits a paragraph at a page break and keeps appendix headings", () => {
    const { sections, paragraphs } = parseRfcStructure(synthetic);
    expect(sections.map(({ number, depth }) => [number, depth])).toEqual([
      [undefined, 1],
      ["1", 1],
      ["2", 1],
      ["A", 1],
      ["A.1", 2],
    ]);
    const introduction = paragraphs.filter(({ section }) => section === 1);
    expect(introduction.map(({ text }) => text)).toEqual([
      "The first half of a paragraph that runs across",
      "a page break and ends here.",
    ]);
    expect(paragraphs.some(({ text }) => text.includes("Example Protocol"))).toBe(false);
  });

  test("splits long paragraphs at line boundaries within the character bound", () => {
    const { paragraphs } = parseRfcStructure(synthetic);
    const long = paragraphs.filter(({ section }) => section === 2);
    expect(long.length).toBeGreaterThan(1);
    for (const paragraph of long) {
      expect(paragraph.text.length).toBeLessThanOrEqual(paragraphMaximumCharacters);
      expect(paragraph.text.startsWith("Line ")).toBe(true);
      expect(paragraph.text.endsWith("long.")).toBe(true);
    }
  });

  test("round-trips paragraph offsets through UTF-8 byte offsets", () => {
    const { paragraphs } = parseRfcStructure(synthetic);
    const offsets = makeUtf8OffsetMap(synthetic);
    const bytes = new TextEncoder().encode(synthetic);
    for (const paragraph of paragraphs) {
      const start = offsets.byteOffsetAtCodeUnit(paragraph.startOffset);
      const end = offsets.byteOffsetAtCodeUnit(paragraph.endOffset);
      expect(start).toBeDefined();
      expect(end).toBeDefined();
      expect(new TextDecoder().decode(bytes.slice(start, end))).toBe(paragraph.text);
    }
  });
});

describe("sectionAtOffset", () => {
  test("names the enclosing section and null in the front matter", () => {
    expect(sectionAtOffset(rfc6585, rfc6585.indexOf("The 429 status code"))).toBe(
      "4.  429 Too Many Requests",
    );
    expect(sectionAtOffset(rfc6585, 10)).toBeNull();
  });
});
