import type {
  CitationVerificationResult,
  Passage,
  ResearchAnswer,
  ResearchHit,
  ResearchResult,
  RfcSourceCacheRemoveResult,
  RfcSourceCacheStatus,
} from "@wyattjoh/rfc-core";
import type { AuthStatus } from "./credentials";

const renderTokenCount = (value: number | null): string => value?.toString() ?? "unavailable";

/**
 * Render an estimated USD value consistently across CLI output.
 *
 * @param value Estimated cost, or null when pricing is unavailable.
 * @returns A dollar value with fixed sub-cent precision or `unavailable`.
 */
export const renderEstimatedUsd = (value: number | null): string =>
  value === null ? "unavailable" : `$${value.toFixed(9)}`;

/**
 * Who reads rendered text: a model through MCP or Pi, or a person at the CLI.
 */
export type RenderAudience = "agent" | "human";

/**
 * Options shared by the research and citation renderers.
 */
export type RenderOptions = {
  /**
   * `agent` renders the compact layout; `human` adds source URLs and a usage
   * and cost footer.
   */
  readonly audience: RenderAudience;
};

const humanAudience: RenderOptions = { audience: "human" };

/**
 * Render a section heading as `§4.2 Title`, or the bare heading when unnumbered.
 */
const renderSection = (section: string | null): string => {
  if (section === null) return "front matter";
  const heading = section.replace(/\s+/g, " ").trim();
  const match = /^(?:Appendix )?((?:\d+|[A-Z])(?:\.\d+)*)\.? (.+)$/.exec(heading);
  return match === null ? heading : `§${match[1]} ${match[2]}`;
};

const renderPassage = (hit: ResearchHit, passage: Passage): ReadonlyArray<string> => [
  [
    `${hit.rfc.identifier} ${renderSection(passage.section)}`,
    passage.verdict,
    ...(hit.relevance === null ? [] : [`rel ${hit.relevance.toFixed(2)}`]),
    ...(hit.role === "current" ? ["current successor"] : []),
  ].join(" · "),
  `Quote [${passage.provenance.startOffset}-${passage.provenance.endOffset}]: ${passage.quote}`,
];

const renderNotFound = (answer: ResearchAnswer, result: ResearchResult): string =>
  answer.searched.length > 0
    ? `not found in ${answer.searched.join(", ")}`
    : result.diagnostics.candidates.pool === 0
      ? "not found: no RFC title or abstract matched the search terms"
      : `not found: none of ${result.diagnostics.candidates.pool} candidate RFCs specifies this`;

const renderCurrency = (result: ResearchResult): ReadonlyArray<string> =>
  (result.currency ?? []).flatMap((report) =>
    report.complete && report.current.length === 1 && report.current[0] === report.requested
      ? []
      : [
          `Currency: ${report.requested} → ${
            report.current.length === 0 ? "current RFC unresolved" : report.current.join(", ")
          }${report.complete ? "" : " (incomplete: some successors were not fetched)"}`,
        ],
  );

const sourceLines = (answer: ResearchAnswer): ReadonlyArray<string> => [
  ...new Set(
    answer.hits.flatMap((hit) =>
      hit.passages.map(({ provenance }) => `Source: ${hit.rfc.identifier} ${provenance.sourceUrl}`),
    ),
  ),
];

/**
 * Render one research result: per question, one line per passage naming the
 * RFC, section, verdict, and relevance, then the exact quote with its UTF-8
 * byte range, or the RFCs that did not contain an answer.
 *
 * @param result Version-three research result.
 * @param options Target audience; defaults to the human CLI format.
 * @returns Multi-line text, plus source URLs, usage, and cost for a human reader.
 */
export const renderResearchResult = (
  result: ResearchResult,
  options: RenderOptions = humanAudience,
): string =>
  [
    ...renderCurrency(result),
    ...result.answers.flatMap((answer, index) => [
      `Q${index + 1}: ${answer.question}`,
      ...(answer.found
        ? answer.hits.flatMap((hit) =>
            hit.passages.flatMap((passage) => renderPassage(hit, passage)),
          )
        : [renderNotFound(answer, result)]),
      ...(options.audience === "human" ? sourceLines(answer) : []),
    ]),
    ...(options.audience === "human"
      ? [
          `Input tokens: ${renderTokenCount(result.diagnostics.usage.inputTokens)}`,
          `Estimated input cost (USD): ${renderEstimatedUsd(result.diagnostics.inputCost.estimatedUsd)}`,
        ]
      : []),
  ].join("\n");

/**
 * Render one citation-verification result for concise agent or human consumption.
 *
 * @param result Version-three citation verdict.
 * @param options Target audience; defaults to the human CLI format.
 * @returns Multi-line text preserving verdict and provenance, plus usage and
 * cost for a human reader.
 */
export const renderCitationVerification = (
  result: CitationVerificationResult,
  options: RenderOptions = humanAudience,
): string =>
  [
    `Verdict: ${result.verdict}`,
    `RFC: ${result.rfc.identifier}`,
    `Quote: ${result.quote}`,
    `Offsets: ${result.provenance.startOffset ?? "unknown"}-${result.provenance.endOffset ?? "unknown"}`,
    `Section: ${result.provenance.section ?? "unknown"}`,
    `Source: ${result.provenance.sourceUrl}`,
    ...(options.audience === "agent"
      ? []
      : [
          `Input tokens: ${renderTokenCount(result.diagnostics.usage.inputTokens)}`,
          `Estimated input cost (USD): ${renderEstimatedUsd(result.diagnostics.inputCost.estimatedUsd)}`,
        ]),
  ].join("\n");

/**
 * Render one local source-cache status.
 *
 * @param result Version-three source-cache status.
 * @returns Concise multi-line status text.
 */
export const renderSourceCacheStatus = (result: RfcSourceCacheStatus): string =>
  `RFC: ${result.rfc}\nCache: ${result.state}`;

/**
 * Render one local source-cache removal result.
 *
 * @param result Version-three source-cache removal result.
 * @returns Concise multi-line removal text.
 */
export const renderSourceCacheRemove = (result: RfcSourceCacheRemoveResult): string =>
  `RFC: ${result.rfc}\nCache: ${result.removed ? "removed" : "missing"}`;

/**
 * Render safe credential status metadata.
 *
 * @param result Version-two credential status.
 * @returns Concise multi-line credential status text.
 */
export const renderAuthStatus = (result: AuthStatus): string =>
  [
    `Credential: ${result.configured ? "configured" : "not configured"}`,
    `Service: ${result.service}`,
    `Name: ${result.name}`,
  ].join("\n");
