import type {
  CitationVerificationResult,
  EvidenceBundle,
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
 * Render one evidence bundle for concise agent or human consumption.
 *
 * @param result Version-two evidence bundle.
 * @returns Multi-line text preserving statuses, qualifications, provenance, and cost.
 */
export const renderEvidenceBundle = (result: EvidenceBundle): string => {
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
 * @returns Multi-line text preserving verdict, provenance, and cost.
 */
export const renderCitationVerification = (result: CitationVerificationResult): string =>
  [
    `Verdict: ${result.verdict}`,
    `RFC: ${result.rfc.identifier}`,
    `Quote: ${result.quote}`,
    `Offsets: ${result.provenance.startOffset ?? "unknown"}-${result.provenance.endOffset ?? "unknown"}`,
    `Section: ${result.provenance.section ?? "unknown"}`,
    `Source: ${result.provenance.sourceUrl}`,
    `Input tokens: ${renderTokenCount(result.diagnostics.usage.inputTokens)}`,
    `Estimated input cost (USD): ${renderEstimatedUsd(result.diagnostics.inputCost.estimatedUsd)}`,
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
