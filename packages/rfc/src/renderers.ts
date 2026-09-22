import type {
  CitationVerificationResult,
  EvidenceBundle,
  EvidencePassage,
  ReviewCandidate,
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
 * Explain why a bundle names no RFC, using the counts the bundle already carries.
 *
 * A bare "none discovered" is false whenever discovery returned candidates that
 * selection then rejected, and it is the only line the caller sees. The two
 * cases need different responses: different search terms, or a narrower
 * question.
 *
 * @param result Version-two evidence bundle with no researched RFC.
 * @returns A short reason suitable for the RFC line.
 */
const noRfcReason = (result: EvidenceBundle): string => {
  const candidates = result.diagnostics.candidates?.documentCandidates;
  if (candidates === undefined) return "none discovered";
  if (candidates === 0) return "no RFC matched the search terms";
  const best = (result.diagnostics.documentSelection ?? []).reduce<
    { readonly candidateId: string; readonly probability: number } | undefined
  >(
    (leader, candidate) =>
      leader === undefined || candidate.probability > leader.probability ? candidate : leader,
    undefined,
  );
  const bestSuffix = best === undefined ? "" : `, best ${best.candidateId} at ${best.probability}`;
  return `${candidates} candidate RFCs discovered, none accepted${bestSuffix}`;
};

/**
 * Say how to spend the follow-up when topic discovery matched nothing.
 *
 * Discovery matches literal title and abstract substrings, and RFC titles
 * often differ from a feature's common name (RFC 8297 is "Indicating Hints",
 * asked for as "Early Hints"). A bare "no RFC matched" left callers retrying
 * the same common name and then refusing.
 */
const noMatchGuidance =
  "Next step: no RFC title or abstract contains these terms. RFC titles often differ from common names, so spend your one follow-up on either rfc_research_known_rfc if you know the RFC number, or this tool with the terms you expect in the RFC's title.";

const hasNoTopicMatch = (result: EvidenceBundle): boolean =>
  !result.rfc && result.diagnostics.candidates?.documentCandidates === 0;

/**
 * Say what to do with a `needs_split` bundle rather than only naming it.
 *
 * A bare `Status: needs_split` reads as a failure, so callers retried the same
 * compound request or refused it outright while the passages they needed were
 * already in the bundle below. The caller holds the question and can parse it,
 * so the split is its work; this line says to do that work and names the
 * material it already has.
 */
const splitGuidance =
  "Next step: this request asks for more than one fact. Split it into one atomic question per requested fact and research each in its own call against the RFC named above. The passages below are review candidates, not accepted evidence; reuse them rather than researching this RFC again.";

/**
 * Warn that a section-seeking question may not have reached the defining section.
 *
 * The engine does not know which section a question asks for, and it accepts
 * nearby sections as direct answers, so the caller cannot tell from a
 * `needs_review` or `partial` bundle whether the section it was asked to cite
 * is among the passages. An agent then cited a section number it never saw.
 */
const sectionCaveat =
  "Note: none of the returned passages is confirmed to be the section that defines this; do not cite a section number that is not shown above.";

const needsSectionCaveat = (result: EvidenceBundle, passages: number): boolean =>
  passages > 0 &&
  (result.status === "needs_review" || result.status === "partial") &&
  /\bsections?\b/i.test(result.question);

/**
 * Who reads rendered text: a model through MCP or Pi, or a person at the CLI.
 */
export type RenderAudience = "agent" | "human";

/**
 * Options shared by the evidence and citation renderers.
 */
export type RenderOptions = {
  /**
   * `agent` renders compact passage headers without usage or cost lines;
   * `human` renders the labelled CLI format.
   */
  readonly audience: RenderAudience;
};

const humanAudience: RenderOptions = { audience: "human" };

type RenderedPassage = EvidencePassage | ReviewCandidate;

/**
 * Collect each document's source URLs once, in first-seen order.
 */
const sourceUrlsByDocument = (
  passages: ReadonlyArray<RenderedPassage>,
): ReadonlyMap<string, ReadonlyArray<string>> =>
  passages.reduce((sources, { provenance: { identifier, sourceUrl } }) => {
    const urls = sources.get(identifier) ?? [];
    return urls.includes(sourceUrl) ? sources : sources.set(identifier, [...urls, sourceUrl]);
  }, new Map<string, ReadonlyArray<string>>());

const agentPassageHeader = (label: string, passage: RenderedPassage): string =>
  [
    label,
    passage.provenance.identifier,
    passage.provenance.section === null ? "section unknown" : `§${passage.provenance.section}`,
    `${passage.context} context`,
    `offsets ${passage.provenance.startOffset}-${passage.provenance.endOffset} (${passage.provenance.offsetUnit})`,
  ].join(" | ");

/**
 * Render an evidence bundle for a model: one header line per passage and each
 * source URL once, with the quote bytes, offsets, and qualifications unchanged.
 */
const renderAgentEvidenceBundle = (result: EvidenceBundle): string => {
  const candidates = result.reviewCandidates ?? [];
  const sources = sourceUrlsByDocument([...result.evidence, ...candidates]);
  const contexts = result.contexts ?? [];
  const contextDocuments = new Set(contexts.map(({ document }) => document.identifier));
  return [
    `Status: ${result.status}`,
    `RFC: ${result.rfc?.identifier ?? noRfcReason(result)}`,
    ...(result.status === "needs_split" ? [splitGuidance] : []),
    ...(hasNoTopicMatch(result) ? [noMatchGuidance] : []),
    ...contexts.map(({ role, document, state }) =>
      [
        `Context: ${role} ${document.identifier} (${state})`,
        ...(sources.get(document.identifier) ?? []),
      ].join(" "),
    ),
    ...[...sources]
      .filter(([identifier]) => !contextDocuments.has(identifier))
      .map(([identifier, urls]) => `Source: ${identifier} ${urls.join(" ")}`),
    ...result.evidence.flatMap((passage) => [
      agentPassageHeader("Evidence", passage),
      `Quote: ${passage.quote}`,
    ]),
    ...candidates.flatMap((candidate) => [
      agentPassageHeader("Review candidate, not accepted evidence", candidate),
      `Quote: ${candidate.quote}`,
    ]),
    ...(needsSectionCaveat(result, result.evidence.length + candidates.length)
      ? [sectionCaveat]
      : []),
  ].join("\n");
};

/**
 * Render one evidence bundle for concise agent or human consumption.
 *
 * @param result Version-two evidence bundle.
 * @param options Target audience; defaults to the human CLI format.
 * @returns Multi-line text preserving statuses, qualifications, and provenance,
 * plus usage and cost for a human reader.
 */
export const renderEvidenceBundle = (
  result: EvidenceBundle,
  options: RenderOptions = humanAudience,
): string => {
  if (options.audience === "agent") return renderAgentEvidenceBundle(result);
  const lines = [
    `Status: ${result.status}`,
    `RFC: ${result.rfc?.identifier ?? noRfcReason(result)}`,
    ...(result.status === "needs_split" ? [splitGuidance] : []),
  ];
  for (const context of result.contexts ?? []) {
    lines.push(`Context: ${context.role} ${context.document.identifier} (${context.state})`);
  }
  for (const passage of result.evidence) {
    lines.push(
      `Evidence RFC: ${passage.provenance.identifier} (${passage.context} context)`,
      `Section: ${passage.provenance.section ?? "unknown"}`,
      `Quote: ${passage.quote}`,
      `Source: ${passage.provenance.sourceUrl}`,
      `Offsets: ${passage.provenance.startOffset}-${passage.provenance.endOffset} (${passage.provenance.offsetUnit})`,
    );
  }
  for (const candidate of result.reviewCandidates ?? []) {
    lines.push(
      "Review candidate: not accepted evidence",
      `Candidate RFC: ${candidate.provenance.identifier} (${candidate.context} context)`,
      `Section: ${candidate.provenance.section ?? "unknown"}`,
      `Quote: ${candidate.quote}`,
      `Source: ${candidate.provenance.sourceUrl}`,
      `Offsets: ${candidate.provenance.startOffset}-${candidate.provenance.endOffset} (${candidate.provenance.offsetUnit})`,
    );
  }
  lines.push(
    `Input tokens: ${renderTokenCount(result.diagnostics.usage.inputTokens)}`,
    `Estimated input cost (USD): ${renderEstimatedUsd(result.diagnostics.inputCost.estimatedUsd)}`,
  );
  return lines.join("\n");
};

/**
 * Render one citation-verification result for concise agent or human consumption.
 *
 * @param result Version-two citation verdict.
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
 * @param result Version-two source-cache status.
 * @returns Concise multi-line status text.
 */
export const renderSourceCacheStatus = (result: RfcSourceCacheStatus): string =>
  `RFC: ${result.rfc}\nCache: ${result.state}`;

/**
 * Render one local source-cache removal result.
 *
 * @param result Version-two source-cache removal result.
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
