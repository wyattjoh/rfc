/**
 * Structural parsing of RFC Editor plain text into sections and paragraphs.
 *
 * Every offset is a JavaScript string index into the exact source text, and
 * every paragraph's text is the exact slice between its offsets. Page
 * furniture (form feeds, running headers, and page footers) is never part of
 * a paragraph, so a paragraph interrupted by a page break becomes two
 * paragraphs rather than one quote with a header inside it.
 */

/**
 * One section heading and the source range it governs.
 */
export interface RfcSection {
  /**
   * Position of this section in document order.
   */
  readonly index: number;
  /**
   * Section number without its trailing period, such as `4.2` or `A.1`, or
   * undefined for an unnumbered heading such as `Abstract`.
   */
  readonly number: string | undefined;
  /**
   * Heading title without its number.
   */
  readonly title: string;
  /**
   * Heading line exactly as it appears in the source, trimmed.
   */
  readonly heading: string;
  /**
   * Nesting depth, starting at one for top-level sections.
   */
  readonly depth: number;
  /**
   * Index of the nearest enclosing section, or undefined at the top level.
   */
  readonly parent: number | undefined;
  /**
   * Start of the heading line.
   */
  readonly startOffset: number;
  /**
   * Start of the next heading, or the end of the source.
   */
  readonly endOffset: number;
}

/**
 * One paragraph: a run of consecutive non-furniture lines between blank lines.
 */
export interface RfcParagraph {
  /**
   * Position of this paragraph in document order.
   */
  readonly index: number;
  /**
   * Index of the section containing this paragraph, or undefined in the front matter.
   */
  readonly section: number | undefined;
  /**
   * Start of the first non-space character of the paragraph.
   */
  readonly startOffset: number;
  /**
   * End of the last non-space character of the paragraph.
   */
  readonly endOffset: number;
  /**
   * Exact source slice between the two offsets.
   */
  readonly text: string;
}

/**
 * The parsed structure of one RFC source.
 */
export interface RfcStructure {
  /**
   * Section headings in document order, excluding the table of contents.
   */
  readonly sections: ReadonlyArray<RfcSection>;
  /**
   * Paragraphs in document order, excluding the table of contents and page furniture.
   */
  readonly paragraphs: ReadonlyArray<RfcParagraph>;
}

/**
 * Longest paragraph kept whole; longer runs split at line boundaries.
 */
export const paragraphMaximumCharacters = 1_500;

interface LineRecord {
  readonly start: number;
  readonly contentEnd: number;
  readonly text: string;
}

const linesOf = (text: string): ReadonlyArray<LineRecord> => {
  const lines: Array<LineRecord> = [];
  let start = 0;
  while (start <= text.length) {
    const newline = text.indexOf("\n", start);
    const end = newline === -1 ? text.length : newline;
    const contentEnd = end > start && text[end - 1] === "\r" ? end - 1 : end;
    lines.push({ start, contentEnd, text: text.slice(start, contentEnd) });
    if (newline === -1) break;
    start = newline + 1;
  }
  return lines;
};

const runningHeaderPattern = /^RFC \d+\s{2,}.*\S\s{2,}[A-Z][a-z]+ \d{4}\s*$/;
const pageFooterPattern = /\[Page \d+\]\s*$/;

/**
 * Whether a line is page furniture rather than document content.
 */
const isFurniture = (line: string): boolean => {
  if (!line.includes("\f")) {
    return runningHeaderPattern.test(line) || pageFooterPattern.test(line);
  }
  const withoutPageBreak = line.replace(/\f/g, "");
  return (
    withoutPageBreak.trim().length === 0 ||
    runningHeaderPattern.test(withoutPageBreak) ||
    pageFooterPattern.test(withoutPageBreak)
  );
};

const unnumberedHeadings = new Set([
  "abstract",
  "status of this memo",
  "copyright notice",
  "table of contents",
  "acknowledgements",
  "acknowledgments",
  "contributors",
  "index",
  "authors' addresses",
  "author's address",
  "authors addresses",
]);

const numberedHeadingPattern =
  /^((?:\d+(?:\.\d+)*)|(?:[A-Z](?:\.\d+)*)|(?:Appendix\s+[A-Z](?:\.\d+)*))\.?\s+(.+?)\s*$/;

type ParsedHeading = Pick<RfcSection, "number" | "title" | "heading" | "depth">;

const parseHeading = (line: string): ParsedHeading | undefined => {
  // RFC plain text starts headings at column 0 and indents everything else, so
  // the indentation is what separates a real heading from a table-of-contents
  // entry or from body prose whose first word happens to be a bare capital.
  if (line.length === 0 || /^\s/.test(line) || isFurniture(line)) return undefined;
  const heading = line.trim();
  if (heading.length > 240) return undefined;
  if (unnumberedHeadings.has(heading.toLowerCase())) {
    return { number: undefined, title: heading, heading, depth: 1 };
  }
  const match = numberedHeadingPattern.exec(heading);
  const number = match?.[1];
  const title = match?.[2];
  if (number === undefined || title === undefined || /^[\d\W]+$/.test(title)) return undefined;
  const normalizedNumber = number.replace(/^Appendix\s+/, "");
  return {
    number: normalizedNumber,
    title,
    heading,
    depth: normalizedNumber.split(".").length,
  };
};

const isTableOfContents = (section: ParsedHeading): boolean =>
  section.number === undefined && section.title.toLowerCase() === "table of contents";

const leadingSpace = (line: string): number => line.length - line.trimStart().length;

/**
 * Parse RFC plain text into sections and exact-substring paragraphs.
 *
 * @param text Exact RFC Editor plain-text source.
 * @returns Sections and paragraphs with absolute string offsets.
 */
export const parseRfcStructure = (text: string): RfcStructure => {
  const lines = linesOf(text);
  const headings = lines.flatMap((line, lineIndex) => {
    const heading = parseHeading(line.text);
    return heading === undefined ? [] : [{ ...heading, lineIndex, start: line.start }];
  });

  const sections: Array<RfcSection> = [];
  const lineSection: Array<number | undefined | "skip"> = Array.from({ length: lines.length });
  const openAtDepth: Array<number> = [];
  for (const [position, heading] of headings.entries()) {
    const nextHeading = headings[position + 1];
    const lastLine = nextHeading?.lineIndex ?? lines.length;
    if (isTableOfContents(heading)) {
      for (let line = heading.lineIndex; line < lastLine; line += 1) lineSection[line] = "skip";
      continue;
    }
    const index = sections.length;
    openAtDepth.length = heading.depth - 1;
    const parent = openAtDepth.filter((candidate) => candidate !== undefined).at(-1);
    openAtDepth[heading.depth - 1] = index;
    sections.push({
      index,
      number: heading.number,
      title: heading.title,
      heading: heading.heading,
      depth: heading.depth,
      parent,
      startOffset: heading.start,
      endOffset: nextHeading?.start ?? text.length,
    });
    lineSection[heading.lineIndex] = "skip";
    for (let line = heading.lineIndex + 1; line < lastLine; line += 1) lineSection[line] = index;
  }

  const paragraphs: Array<RfcParagraph> = [];
  let run: Array<LineRecord> = [];
  let runSection: number | undefined;
  const flush = (): void => {
    let chunk: Array<LineRecord> = [];
    const emit = (): void => {
      const first = chunk[0];
      const last = chunk.at(-1);
      if (first === undefined || last === undefined) return;
      const startOffset = first.start + leadingSpace(first.text);
      const endOffset = last.start + last.text.trimEnd().length;
      paragraphs.push({
        index: paragraphs.length,
        section: runSection,
        startOffset,
        endOffset,
        text: text.slice(startOffset, endOffset),
      });
      chunk = [];
    };
    for (const line of run) {
      const first = chunk[0];
      const projected =
        first === undefined
          ? line.text.trim().length
          : line.start + line.text.trimEnd().length - (first.start + leadingSpace(first.text));
      if (chunk.length > 0 && projected > paragraphMaximumCharacters) emit();
      chunk.push(line);
    }
    emit();
    run = [];
  };

  for (const [lineIndex, line] of lines.entries()) {
    const section = lineSection[lineIndex];
    if (section === "skip" || line.text.trim().length === 0 || isFurniture(line.text)) {
      flush();
      continue;
    }
    if (run.length > 0 && section !== runSection) flush();
    runSection = section;
    run.push(line);
  }
  flush();

  return { sections, paragraphs };
};

/**
 * Find the heading of the section containing a source offset.
 *
 * @param text Exact RFC Editor plain-text source.
 * @param codeUnitOffset JavaScript string index into the source.
 * @returns The trimmed heading line, or null in the front matter.
 */
export const sectionAtOffset = (text: string, codeUnitOffset: number): string | null =>
  parseRfcStructure(text)
    .sections.filter(
      (section) => section.startOffset <= codeUnitOffset && codeUnitOffset < section.endOffset,
    )
    .at(-1)?.heading ?? null;
