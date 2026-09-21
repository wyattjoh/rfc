import { createHash } from "node:crypto";
import { Schema } from "effect";
import {
  CitationVerdictSchema,
  type CitationVerificationResult,
  type CitationVerdict,
} from "./citation";
import { LiveRetrievalTraceSchema, type LiveRetrievalTrace } from "./discovery";
import {
  precisionPolicy,
  ResearchStatusSchema,
  type EvidenceBundle,
  type ResearchStatus,
} from "./research";

/**
 * Version of the evaluation contracts and report format.
 */
export const evaluationSchemaVersion = 6 as const;

/**
 * Version of the committed precision evaluation corpus.
 */
export const evaluationCorpusVersion = "precision-v2" as const;

/**
 * Alias used when calibration begins against the TypeSafe provider.
 */
export const evaluationModelAlias = precisionPolicy.evaluationModelAlias;

/**
 * Exact Jev model version pinned after calibration.
 */
export const pinnedJevModel = precisionPolicy.pinnedModel;

/**
 * Schema for the two research modes represented by evaluation cases.
 */
export const EvaluationModeSchema = Schema.Literals(["known_rfc", "topic"]);

/**
 * Research or citation operation represented by an evaluation case.
 */
export const EvaluationKindSchema = Schema.Literals(["research", "citation"]);

/**
 * Origin of a report used for deterministic verification or release activation.
 */
export const EvaluationOriginSchema = Schema.Literals(["deterministic", "live"]);

/**
 * Origin of a versioned evaluation report.
 */
export type EvaluationOrigin = Schema.Schema.Type<typeof EvaluationOriginSchema>;

/**
 * A committed evaluation case covering one representative behavior.
 */
export const EvaluationCaseSchema = Schema.Struct({
  id: Schema.NonEmptyString,
  category: Schema.NonEmptyString,
  kind: EvaluationKindSchema,
  mode: EvaluationModeSchema,
  rfc: Schema.NullOr(Schema.NonEmptyString),
  question: Schema.NullOr(Schema.NonEmptyString),
  searchTerms: Schema.optionalKey(Schema.Array(Schema.NonEmptyString)),
  claim: Schema.NullOr(Schema.NonEmptyString),
  quote: Schema.NullOr(Schema.NonEmptyString),
  offset: Schema.NullOr(Schema.Natural),
  expectedStatus: Schema.NullOr(ResearchStatusSchema),
  expectedVerdict: Schema.NullOr(CitationVerdictSchema),
  /**
   * Outcomes that are safe for this case when the evidence is policy-accepted.
   * Exact cases contain only their canonical expected outcome; a future
   * reviewed recertification may list bounded alternatives that are equally safe.
   */
  allowedOutcomes: Schema.Array(Schema.NonEmptyString),
  /**
   * Corpus rationale for the expected status or citation verdict.
   */
  expectedOutcomeRationale: Schema.NonEmptyString,
  supportedClaim: Schema.Boolean,
  live: Schema.Boolean,
});

/**
 * The plain-data shape of one committed evaluation case.
 */
export type EvaluationCase = Schema.Schema.Type<typeof EvaluationCaseSchema>;

/**
 * Deterministic retrieval behavior represented in the version-two corpus.
 */
export const EvaluationRetrievalCategorySchema = Schema.Literals([
  "known_current_rfc",
  "update_chain",
  "cycle_safety",
  "ordered_topic_terms",
  "candidate_fan_out",
  "no_candidate_outcome",
  "relationship_bound",
  "source_cache_miss",
  "source_cache_hit",
  "source_cache_revalidated",
  "source_cache_replaced",
  "source_cache_repaired",
  "fail_closed_metadata",
  "fail_closed_revalidation",
]);

/**
 * One deterministic public-client scenario bound into the evaluation corpus.
 */
export const EvaluationRetrievalCaseSchema = Schema.Struct({
  id: Schema.NonEmptyString,
  category: EvaluationRetrievalCategorySchema,
  seam: Schema.Literal("rfc_client"),
  live: Schema.Literal(false),
  assertion: Schema.NonEmptyString,
});

/**
 * A deterministic public-client scenario in the evaluation corpus.
 */
export type EvaluationRetrievalCase = Schema.Schema.Type<typeof EvaluationRetrievalCaseSchema>;

/**
 * Cache-state evidence recorded around one deterministic source-cache scenario.
 */
export const EvaluationCacheEvidenceSchema = Schema.Struct({
  beforeSourceHash: Schema.NullOr(Schema.NonEmptyString),
  afterSourceHash: Schema.NullOr(Schema.NonEmptyString),
  returnedSourceHash: Schema.NullOr(Schema.NonEmptyString),
  sourceRequestCounts: Schema.Array(Schema.Natural),
  networkRequestCount: Schema.Natural,
  validators: Schema.Array(Schema.NullOr(Schema.NonEmptyString)),
  cacheEntryCorrupted: Schema.Boolean,
});

/**
 * Before/after cache evidence attached to a deterministic retrieval observation.
 */
export type EvaluationCacheEvidence = Schema.Schema.Type<typeof EvaluationCacheEvidenceSchema>;

/**
 * Evidence that one deterministic retrieval case executed through the public client seam.
 */
export const EvaluationRetrievalObservationSchema = Schema.Struct({
  schemaVersion: Schema.Literal(evaluationSchemaVersion),
  caseId: Schema.NonEmptyString,
  category: EvaluationRetrievalCategorySchema,
  seam: Schema.Literal("rfc_client"),
  passed: Schema.Boolean,
  traces: Schema.Array(LiveRetrievalTraceSchema),
  cacheEvidence: Schema.NullOr(EvaluationCacheEvidenceSchema),
  errorKind: Schema.NullOr(Schema.NonEmptyString),
});

/**
 * The sanitized result of executing one deterministic retrieval case.
 */
export type EvaluationRetrievalObservation = Schema.Schema.Type<
  typeof EvaluationRetrievalObservationSchema
>;

/**
 * Schema for the committed evaluation corpus.
 */
export const EvaluationCorpusSchema = Schema.Struct({
  schemaVersion: Schema.Literal(evaluationSchemaVersion),
  kind: Schema.Literal("rfc_evaluation_corpus"),
  corpusVersion: Schema.NonEmptyString,
  cases: Schema.Array(EvaluationCaseSchema),
  retrievalCases: Schema.Array(EvaluationRetrievalCaseSchema),
});

/**
 * A versioned collection of deterministic and live evaluation cases.
 */
export type EvaluationCorpus = Schema.Schema.Type<typeof EvaluationCorpusSchema>;

const corpusCases = [
  {
    id: "modern-normative-requirement",
    category: "normative_requirement",
    kind: "research",
    mode: "known_rfc",
    rfc: "RFC9110",
    question: "How does an HTTP client send a request message?",
    claim: null,
    quote: null,
    offset: null,
    expectedStatus: "answered",
    expectedVerdict: null,
    expectedOutcomeRationale:
      "Positive control: retain one measured modern normative case that produces direct evidence strong enough for answered across every live repetition.",
    supportedClaim: false,
    live: true,
  },
  {
    id: "older-definition",
    category: "definition",
    kind: "research",
    mode: "known_rfc",
    rfc: "RFC2616",
    question: "What is an entity in HTTP/1.1?",
    claim: null,
    quote: null,
    offset: null,
    expectedStatus: "needs_review",
    expectedVerdict: null,
    expectedOutcomeRationale:
      "RFC2616 is obsolete; an older definition without policy-accepted current evidence remains needs_review.",
    supportedClaim: false,
    live: true,
  },
  {
    id: "procedure",
    category: "procedure",
    kind: "research",
    mode: "known_rfc",
    rfc: "RFC7230",
    question: "How does a client send an HTTP request?",
    claim: null,
    quote: null,
    offset: null,
    expectedStatus: "needs_review",
    expectedVerdict: null,
    expectedOutcomeRationale:
      "Measured RFC7230 procedure evidence was not policy-accepted across repetitions; do not lower the relation gate to answer.",
    supportedClaim: false,
    live: true,
  },
  {
    id: "tls-handshake",
    category: "tls_protocol",
    kind: "research",
    mode: "known_rfc",
    rfc: "RFC8446",
    question: "What is the purpose of the TLS 1.3 handshake?",
    claim: null,
    quote: null,
    offset: null,
    expectedStatus: "needs_review",
    expectedVerdict: null,
    expectedOutcomeRationale:
      "Measured TLS 1.3 evidence did not provide policy-accepted direct support across repetitions; fail closed.",
    supportedClaim: false,
    live: true,
  },
  {
    id: "oauth-grant",
    category: "oauth_definition",
    kind: "research",
    mode: "known_rfc",
    rfc: "RFC6749",
    question: "What is an authorization grant in OAuth 2.0?",
    claim: null,
    quote: null,
    offset: null,
    expectedStatus: "needs_review",
    expectedVerdict: null,
    expectedOutcomeRationale:
      "Measured OAuth grant evidence did not provide policy-accepted direct support across repetitions; fail closed.",
    supportedClaim: false,
    live: true,
  },
  {
    id: "dns-resolver",
    category: "dns_definition",
    kind: "research",
    mode: "known_rfc",
    rfc: "RFC1034",
    question: "What does a DNS resolver do?",
    claim: null,
    quote: null,
    offset: null,
    expectedStatus: "needs_review",
    expectedVerdict: null,
    expectedOutcomeRationale:
      "Measured DNS resolver evidence did not provide policy-accepted direct support across repetitions; fail closed.",
    supportedClaim: false,
    live: true,
  },
  {
    id: "negative-answer",
    category: "negative_answer",
    kind: "research",
    mode: "known_rfc",
    rfc: "RFC9110",
    question: "Does RFC 9110 require a server to cache every request?",
    claim: null,
    quote: null,
    offset: null,
    expectedStatus: "needs_review",
    expectedVerdict: null,
    expectedOutcomeRationale:
      "The cache question is an ambiguous negative: unsupported is safe only when every selected passage is confidently negative, while needs_review remains safe for selection uncertainty.",
    supportedClaim: false,
    live: true,
  },
  {
    id: "topic-discovery",
    category: "topic_discovery",
    kind: "research",
    mode: "topic",
    rfc: null,
    question: "How does an HTTP client send a request message?",
    searchTerms: ["HTTP client request message"],
    claim: null,
    quote: null,
    offset: null,
    expectedStatus: "needs_review",
    expectedVerdict: null,
    expectedOutcomeRationale:
      "Topic discovery may answer only when a document clears the 0.35 threshold, a passage is selected, and a sufficiently confident direct relation is accepted; document selection alone remains needs_review.",
    supportedClaim: false,
    live: true,
  },
  {
    id: "topic-ordered-search-terms",
    category: "ordered_topic_terms",
    kind: "research",
    mode: "topic",
    rfc: null,
    question: "Which RFCs define HTTP caching and cache-control behavior?",
    searchTerms: ["HTTP caching", "cache control"],
    claim: null,
    quote: null,
    offset: null,
    expectedStatus: "needs_review",
    expectedVerdict: null,
    expectedOutcomeRationale:
      "Ordered multi-term discovery remains fail closed until precision-v2 candidate ordering is reviewed.",
    supportedClaim: false,
    live: true,
  },
  {
    id: "topic-candidate-fan-out",
    category: "candidate_fan_out",
    kind: "research",
    mode: "topic",
    rfc: null,
    question: "Which RFCs define HTTP message, caching, authentication, and routing behavior?",
    searchTerms: ["HTTP message", "HTTP caching", "HTTP authentication", "HTTP routing"],
    claim: null,
    quote: null,
    offset: null,
    expectedStatus: "needs_review",
    expectedVerdict: null,
    expectedOutcomeRationale:
      "Broad bounded discovery must not become an automatic answer before candidate fan-out is recertified.",
    supportedClaim: false,
    live: true,
  },
  {
    id: "topic-no-candidates",
    category: "no_candidate_outcome",
    kind: "research",
    mode: "topic",
    rfc: null,
    question: "Which RFC defines the intentionally absent evaluation control?",
    searchTerms: ["rfc-evidence-no-candidate-7f31"],
    claim: null,
    quote: null,
    offset: null,
    expectedStatus: "needs_review",
    expectedVerdict: null,
    expectedOutcomeRationale:
      "Successful empty discovery is a bounded miss that requires review and never proves unsupported.",
    supportedClaim: false,
    live: true,
  },
  {
    id: "obsolete-document",
    category: "obsolete_document",
    kind: "research",
    mode: "known_rfc",
    rfc: "RFC2616",
    question: "Which requirement applies after this RFC was obsoleted?",
    claim: null,
    quote: null,
    offset: null,
    expectedStatus: "needs_review",
    expectedVerdict: null,
    expectedOutcomeRationale:
      "RFC2616 currency is obsolete and its replacement applicability requires review.",
    supportedClaim: false,
    live: true,
  },
  {
    id: "updated-document",
    category: "updated_document",
    kind: "research",
    mode: "known_rfc",
    rfc: "RFC7230",
    question: "What does the updated HTTP message procedure require?",
    claim: null,
    quote: null,
    offset: null,
    expectedStatus: "needs_review",
    expectedVerdict: null,
    expectedOutcomeRationale:
      "RFC7230 has updated currency context, but measured evidence is incomplete; partial is safe only as a non-automatic result and needs_review remains the conservative alternative.",
    supportedClaim: false,
    live: true,
  },
  {
    id: "partial-answer",
    category: "partial_answer",
    kind: "research",
    mode: "known_rfc",
    rfc: "RFC9110",
    question: "What does RFC9110 say about server caching?",
    claim: null,
    quote: null,
    offset: null,
    expectedStatus: "needs_review",
    expectedVerdict: null,
    expectedOutcomeRationale:
      "The selected RFC9110 Methods and Caching passage directly states the cacheability condition and the methods covered, so an accepted direct answer is fully supported; needs_review remains safe when that direct relation is not accepted.",
    supportedClaim: false,
    live: true,
  },
  {
    id: "compound-question",
    category: "compound_question",
    kind: "research",
    mode: "known_rfc",
    rfc: "RFC9110",
    question: "What must the client send and what does the server cache?",
    claim: null,
    quote: null,
    offset: null,
    expectedStatus: "needs_split",
    expectedVerdict: null,
    expectedOutcomeRationale:
      "Compound requests require splitting before an answer can be accepted.",
    supportedClaim: false,
    live: true,
  },
  {
    id: "duplicate-quotation",
    category: "duplicate_quotation",
    kind: "citation",
    mode: "known_rfc",
    rfc: "RFC9110",
    question: null,
    claim:
      "The server SHOULD generate a Location header field in the response containing a preferred URI reference for the new permanent URI.",
    quote:
      "The server SHOULD generate a Location header field in the response\n   containing a preferred URI reference for the new permanent URI.",
    offset: 346_604,
    expectedStatus: null,
    expectedVerdict: "verified",
    expectedOutcomeRationale:
      "Exact duplicate quotation is a citation positive control and must verify by source presence and offset.",
    supportedClaim: true,
    live: true,
  },
  {
    id: "supported-background-quotation",
    category: "supported_background_quotation",
    kind: "citation",
    mode: "known_rfc",
    rfc: "RFC9110",
    question: null,
    claim:
      "The representation data associated with an HTTP message is either provided as the content of the message or referred to by the message semantics and the target URI.",
    quote:
      "The representation data associated with an HTTP message is either\n   provided as the content of the message or referred to by the message\n   semantics and the target URI.",
    offset: null,
    expectedStatus: null,
    expectedVerdict: "verified",
    expectedOutcomeRationale:
      "Source-backed background quotation is a supported citation positive control.",
    supportedClaim: true,
    live: true,
  },
  {
    id: "supported-normative-quotation",
    category: "supported_normative_quotation",
    kind: "citation",
    mode: "known_rfc",
    rfc: "RFC9110",
    question: null,
    claim:
      "A sender must not generate protocol elements that do not match the grammar defined by the corresponding ABNF rules.",
    quote:
      "A sender MUST NOT generate protocol elements that do not match the\n   grammar defined by the corresponding ABNF rules.",
    offset: null,
    expectedStatus: null,
    expectedVerdict: "verified",
    expectedOutcomeRationale:
      "Normative modality normalization is a supported citation positive control.",
    supportedClaim: true,
    live: true,
  },
  {
    id: "fabricated-quotation",
    category: "fabricated_quotation",
    kind: "citation",
    mode: "known_rfc",
    rfc: "RFC9110",
    question: null,
    claim: "The server must cache every request.",
    quote: "The server MUST cache every request.",
    offset: null,
    expectedStatus: null,
    expectedVerdict: "fabricated",
    expectedOutcomeRationale:
      "Quote absence is a deterministic fabricated-quotation safety control.",
    supportedClaim: false,
    live: true,
  },
  {
    id: "unsupported-claim",
    category: "unsupported_claim",
    kind: "citation",
    mode: "known_rfc",
    rfc: "RFC9110",
    question: null,
    claim: "The server must cache every request.",
    quote:
      "The representation data associated with an HTTP message is either\n   provided as the content of the message or referred to by the message\n   semantics and the target URI.",
    offset: null,
    expectedStatus: null,
    expectedVerdict: "unsupported",
    expectedOutcomeRationale:
      "Claim and quotation mismatch is an unsupported-claim safety control.",
    supportedClaim: false,
    live: true,
  },
  {
    id: "contradicted-claim",
    category: "contradicted_claim",
    kind: "citation",
    mode: "known_rfc",
    rfc: "RFC9110",
    question: null,
    claim: "A sender must generate protocol elements that do not match the grammar.",
    quote:
      "A sender MUST NOT generate protocol elements that do not match the\n   grammar defined by the corresponding ABNF rules.",
    offset: null,
    expectedStatus: null,
    expectedVerdict: "contradicted",
    expectedOutcomeRationale:
      "Claim reverses the normative source meaning and must remain contradicted.",
    supportedClaim: false,
    live: true,
  },
] as const;

/**
 * Reviewed bounded outcome alternatives for the current corpus.
 *
 * Precision-v2 has not been recertified, so this set is empty. It is keyed to
 * committed case ids rather than inferred from observed labels to prevent a
 * report from widening its own acceptance policy.
 */
export const evaluationAllowedOutcomeSets: Readonly<Record<string, ReadonlyArray<string>>> =
  Object.freeze({});

const baseCaseId = (caseId: string): string =>
  /^(.*):iteration-[1-9][0-9]*$/.exec(caseId)?.[1] ?? caseId;

const exactCorpusOutcome = (evaluationCase: (typeof corpusCases)[number]): string =>
  evaluationCase.kind === "research"
    ? (evaluationCase.expectedStatus ?? "needs_review")
    : (evaluationCase.expectedVerdict ?? "unsupported");

const allowedOutcomesForCaseId = (
  caseId: string,
  expectedOutcome: string,
): ReadonlyArray<string> => {
  const explicit = evaluationAllowedOutcomeSets[baseCaseId(caseId)];
  return explicit ?? [expectedOutcome];
};

const corpusCasesWithOutcomePolicy = corpusCases.map((evaluationCase) => ({
  ...evaluationCase,
  allowedOutcomes: allowedOutcomesForCaseId(evaluationCase.id, exactCorpusOutcome(evaluationCase)),
}));

const retrievalCases = [
  {
    id: "retrieval-known-current",
    category: "known_current_rfc",
    seam: "rfc_client",
    live: false,
    assertion: "Exact metadata and canonical source are retrieved for a current RFC.",
  },
  {
    id: "retrieval-update-chain",
    category: "update_chain",
    seam: "rfc_client",
    live: false,
    assertion:
      "Successor relationships preserve requested and current contexts across an update chain.",
  },
  {
    id: "retrieval-cycle",
    category: "cycle_safety",
    seam: "rfc_client",
    live: false,
    assertion: "Cyclic successor relationships terminate and force a fail-closed result.",
  },
  {
    id: "retrieval-ordered-topic-terms",
    category: "ordered_topic_terms",
    seam: "rfc_client",
    live: false,
    assertion: "Ordered caller terms produce bounded title and abstract request streams.",
  },
  {
    id: "retrieval-candidate-fan-out",
    category: "candidate_fan_out",
    seam: "rfc_client",
    live: false,
    assertion:
      "Upstream rows, merged candidates, semantic candidates, and source reads stay bounded.",
  },
  {
    id: "retrieval-no-candidates",
    category: "no_candidate_outcome",
    seam: "rfc_client",
    live: false,
    assertion:
      "A successful empty discovery returns needs_review without provider or source calls.",
  },
  {
    id: "retrieval-relationship-bound",
    category: "relationship_bound",
    seam: "rfc_client",
    live: false,
    assertion: "Relationship, context, and depth bounds are explicit and force review.",
  },
  {
    id: "retrieval-cache-miss",
    category: "source_cache_miss",
    seam: "rfc_client",
    live: false,
    assertion: "A source-cache miss reads and atomically stores one canonical RFC source.",
  },
  {
    id: "retrieval-cache-hit",
    category: "source_cache_hit",
    seam: "rfc_client",
    live: false,
    assertion: "A fresh source-cache hit performs no RFC Editor request.",
  },
  {
    id: "retrieval-cache-304",
    category: "source_cache_revalidated",
    seam: "rfc_client",
    live: false,
    assertion: "A strong conditional validator accepts 304 and preserves exact cached bytes.",
  },
  {
    id: "retrieval-cache-changed",
    category: "source_cache_replaced",
    seam: "rfc_client",
    live: false,
    assertion: "A changed 200 response atomically replaces source bytes and validators.",
  },
  {
    id: "retrieval-cache-corrupt",
    category: "source_cache_repaired",
    seam: "rfc_client",
    live: false,
    assertion: "A corrupt source-cache entry is unconditionally refetched and repaired.",
  },
  {
    id: "retrieval-metadata-failure",
    category: "fail_closed_metadata",
    seam: "rfc_client",
    live: false,
    assertion: "Required Datatracker metadata failure returns RfcDiscoveryError without fallback.",
  },
  {
    id: "retrieval-stale-source-failure",
    category: "fail_closed_revalidation",
    seam: "rfc_client",
    live: false,
    assertion:
      "Stale RFC source revalidation failure returns RfcSourceRevalidationError without serving stale text.",
  },
] as const;

/**
 * The committed corpus used by deterministic tests and opt-in calibration.
 */
export const evaluationCorpus: EvaluationCorpus = Schema.decodeUnknownSync(EvaluationCorpusSchema)({
  schemaVersion: evaluationSchemaVersion,
  kind: "rfc_evaluation_corpus",
  corpusVersion: evaluationCorpusVersion,
  cases: corpusCasesWithOutcomePolicy,
  retrievalCases,
});

/**
 * Research cases that must remain automatic-answer positive controls.
 *
 * This allowlist is intentionally independent of the expected-status fields:
 * recertifying every research case as `needs_review` cannot make the corpus
 * pass its release gate.
 */
export const evaluationPositiveControlCaseIds = ["modern-normative-requirement"] as const;

const stableJson = (value: unknown): string => {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
    .join(",")}}`;
};

const sha256 = (value: unknown): string =>
  createHash("sha256").update(stableJson(value)).digest("hex");

/**
 * Digest of the committed evaluation corpus used by release attestation.
 */
export const evaluationCorpusDigest = sha256(evaluationCorpus);

const sameStringSequence = (left: ReadonlyArray<string>, right: ReadonlyArray<string>): boolean =>
  left.length === right.length && left.every((value, index) => value === right[index]);

/**
 * Decode an evaluation corpus at an untrusted JSON boundary.
 *
 * The schema checks shape; this additional check binds every case to its
 * committed outcome policy so a corpus cannot widen a review case to accept
 * arbitrary labels.
 *
 * @param input Unknown corpus data.
 * @returns A decoded versioned evaluation corpus.
 */
export const decodeEvaluationCorpus = (input: unknown): EvaluationCorpus => {
  const corpus = Schema.decodeUnknownSync(EvaluationCorpusSchema)(input);
  for (const evaluationCase of corpus.cases) {
    const expectedOutcome =
      evaluationCase.kind === "research"
        ? evaluationCase.expectedStatus
        : evaluationCase.expectedVerdict;
    if (expectedOutcome === null) {
      throw new Error(`Evaluation case ${evaluationCase.id} is missing its expected outcome`);
    }
    const allowedOutcomes = allowedOutcomesForCaseId(evaluationCase.id, expectedOutcome);
    if (!sameStringSequence(evaluationCase.allowedOutcomes, allowedOutcomes)) {
      throw new Error(`Evaluation case ${evaluationCase.id} has an uncommitted outcome policy`);
    }
  }
  return corpus;
};

const EvaluationUsageSchema = Schema.Struct({
  inputTokens: Schema.NullOr(Schema.Finite),
  outputTokens: Schema.NullOr(Schema.Finite),
});

/**
 * Usage captured for one evaluation operation.
 */
export type EvaluationUsage = Schema.Schema.Type<typeof EvaluationUsageSchema>;

const EvaluationTimingsSchema = Schema.Struct({
  metadataMs: Schema.NullOr(Schema.Finite),
  documentMs: Schema.NullOr(Schema.Finite),
  sourceMs: Schema.NullOr(Schema.Finite),
  lexicalMs: Schema.NullOr(Schema.Finite),
  selectionMs: Schema.NullOr(Schema.Finite),
  relationMs: Schema.NullOr(Schema.Finite),
  verificationMs: Schema.NullOr(Schema.Finite),
  totalMs: Schema.Finite,
});

/**
 * Stage timings captured for one evaluation operation.
 */
export type EvaluationTimings = Schema.Schema.Type<typeof EvaluationTimingsSchema>;

/**
 * RFC source identity preserved in an evaluation observation.
 */
export const EvaluationSourceProvenanceSchema = Schema.Struct({
  identifier: Schema.NonEmptyString,
  sourceHash: Schema.NonEmptyString,
});

/**
 * An authoritative RFC identifier and exact source hash pair.
 */
export type EvaluationSourceProvenance = Schema.Schema.Type<
  typeof EvaluationSourceProvenanceSchema
>;

/**
 * Schema for one sanitized evaluation observation.
 */
export const EvaluationObservationSchema = Schema.Struct({
  schemaVersion: Schema.Literal(evaluationSchemaVersion),
  caseId: Schema.NonEmptyString,
  category: Schema.NonEmptyString,
  kind: EvaluationKindSchema,
  mode: EvaluationModeSchema,
  expectedOutcome: Schema.NonEmptyString,
  observedOutcome: Schema.NonEmptyString,
  allowedOutcomes: Schema.Array(Schema.NonEmptyString),
  acceptedByPolicy: Schema.Boolean,
  unsafeCitationAccepted: Schema.Boolean,
  sourceProvenance: Schema.Array(EvaluationSourceProvenanceSchema),
  requestedModel: Schema.NonEmptyString,
  resolvedModel: Schema.NonEmptyString,
  resolvedModels: Schema.Array(Schema.NonEmptyString),
  policyVersion: Schema.NonEmptyString,
  usage: EvaluationUsageSchema,
  timings: EvaluationTimingsSchema,
  retrieval: Schema.NullOr(LiveRetrievalTraceSchema),
  totalLatencyMs: Schema.Finite,
  probabilities: Schema.Record(Schema.String, Schema.Finite),
  confidence: Schema.NullOr(Schema.Finite),
  errorKind: Schema.NullOr(Schema.NonEmptyString),
});

/**
 * A live or deterministic result stripped of questions, prompts, and reasoning.
 */
export type EvaluationObservation = Schema.Schema.Type<typeof EvaluationObservationSchema>;

const statusRatesSchema = Schema.Struct({
  answered: Schema.Finite,
  partial: Schema.Finite,
  unsupported: Schema.Finite,
  needs_review: Schema.Finite,
  needs_split: Schema.Finite,
});

const verdictRatesSchema = Schema.Struct({
  verified: Schema.Finite,
  unsupported: Schema.Finite,
  contradicted: Schema.Finite,
  fabricated: Schema.Finite,
});

/**
 * Aggregate metrics calculated from evaluation observations.
 */
export const EvaluationMetricsSchema = Schema.Struct({
  researchCases: Schema.Natural,
  citationCases: Schema.Natural,
  knownRfcResearchCases: Schema.Natural,
  topicResearchCases: Schema.Natural,
  supportedClaims: Schema.Natural,
  acceptedSupportedClaims: Schema.Natural,
  acceptedUnsupportedClaims: Schema.Natural,
  acceptedCitationCount: Schema.Natural,
  supportedClaimPrecision: Schema.Finite,
  /** Fraction of research observations whose observed status is answered. */
  researchAnswerRate: Schema.Finite,
  /** Citation-only coverage: accepted verified citations / verified citation cases. */
  supportedClaimCoverage: Schema.Finite,
  unsafeCitationAcceptances: Schema.Natural,
  statusRates: statusRatesSchema,
  verdictRates: verdictRatesSchema,
  knownRfcP95LatencyMs: Schema.Finite,
  topicP95LatencyMs: Schema.Finite,
});

/**
 * Metrics reported by a calibration run.
 */
export type EvaluationMetrics = Schema.Schema.Type<typeof EvaluationMetricsSchema>;

const EvaluationRetrievalLimitsSchema = Schema.Struct({
  maxSearchTerms: Schema.Natural,
  maxSearchTermCharacters: Schema.Natural,
  maxTopicRequests: Schema.Natural,
  maxConcurrentDatatrackerRequests: Schema.Natural,
  maxRowsPerTopicRequest: Schema.Natural,
  maxUpstreamTopicRows: Schema.Natural,
  datatrackerMaxAttempts: Schema.Natural,
  datatrackerDeadlineMilliseconds: Schema.Natural,
  datatrackerMaximumResponseBytes: Schema.Natural,
  sourceDeadlineMilliseconds: Schema.Natural,
  sourceMaximumBytes: Schema.Natural,
  sourceCacheSchemaVersion: Schema.Natural,
});

const EvaluationCandidateLimitsSchema = Schema.Struct({
  maxMergedDocumentCandidates: Schema.Natural,
  maxSourceRetrievalCandidates: Schema.Natural,
  maxPassageCandidates: Schema.Natural,
  sourceBlockMaxCharacters: Schema.Natural,
  sourceBlockOverlapCharacters: Schema.Natural,
});

const EvaluationTraversalLimitsSchema = Schema.Struct({
  maxDepth: Schema.Natural,
  maxContexts: Schema.Natural,
  maxRelationshipsPerRfc: Schema.Natural,
});

const EvaluationProviderRetryLimitsSchema = Schema.Struct({
  maxAttempts: Schema.Natural,
  maxElapsedMilliseconds: Schema.Natural,
  defaultRetryDelayMilliseconds: Schema.Natural,
});

const EvaluationAcceptanceLimitsSchema = Schema.Struct({
  calibrationStatus: Schema.Literal("uncalibrated"),
  documentProbabilityThreshold: Schema.Finite,
  selectionProbabilityThreshold: Schema.Finite,
  unsupportedProbabilityThreshold: Schema.Finite,
  relationConfidenceThreshold: Schema.Finite,
  directAnswerProbabilityThreshold: Schema.Finite,
  partialAnswerProbabilityThreshold: Schema.Finite,
  contradictoryProbabilityThreshold: Schema.Finite,
  currencyCompatibilityOverlapThreshold: Schema.Finite,
  minimumSupportedClaimPrecision: Schema.Finite,
  maxKnownRfcP95LatencyMilliseconds: Schema.Finite,
  maxTopicP95LatencyMilliseconds: Schema.Finite,
});

/**
 * Schema for the complete policy identity bound into evaluation artifacts.
 */
export const EvaluationPolicySchema = Schema.Struct({
  schemaVersion: Schema.Literal(2),
  policyVersion: Schema.Literal("precision-v2"),
  calibrationStatus: Schema.Literal("uncalibrated"),
  retrievalLimits: EvaluationRetrievalLimitsSchema,
  candidateLimits: EvaluationCandidateLimitsSchema,
  traversalLimits: EvaluationTraversalLimitsSchema,
  providerRetryLimits: EvaluationProviderRetryLimitsSchema,
  acceptanceLimits: EvaluationAcceptanceLimitsSchema,
  requestedModel: Schema.NonEmptyString,
  pinnedModel: Schema.NonEmptyString,
  minimumSupportedClaimPrecision: Schema.Finite,
  maxKnownRfcP95LatencyMilliseconds: Schema.Finite,
  maxTopicP95LatencyMilliseconds: Schema.Finite,
});

/**
 * Complete pending policy and model settings used by the evaluation gates.
 */
export const evaluationPolicy = Schema.decodeUnknownSync(EvaluationPolicySchema)({
  schemaVersion: precisionPolicy.schemaVersion,
  policyVersion: precisionPolicy.policyVersion,
  calibrationStatus: precisionPolicy.calibrationStatus,
  retrievalLimits: precisionPolicy.retrievalLimits,
  candidateLimits: precisionPolicy.candidateLimits,
  traversalLimits: precisionPolicy.traversalLimits,
  providerRetryLimits: precisionPolicy.providerRetryLimits,
  acceptanceLimits: precisionPolicy.acceptanceLimits,
  requestedModel: evaluationModelAlias,
  pinnedModel: pinnedJevModel,
  minimumSupportedClaimPrecision: precisionPolicy.minimumSupportedClaimPrecision,
  maxKnownRfcP95LatencyMilliseconds: precisionPolicy.maxKnownRfcP95LatencyMilliseconds,
  maxTopicP95LatencyMilliseconds: precisionPolicy.maxTopicP95LatencyMilliseconds,
});

/**
 * Type of the complete evaluation policy.
 */
export type EvaluationPolicy = Schema.Schema.Type<typeof EvaluationPolicySchema>;

/**
 * Digest of the committed precision policy used by release attestation.
 */
export const evaluationPolicyDigest = sha256(evaluationPolicy);

/**
 * Release-bound calibration attestation.
 *
 * Live discovery changes the candidate distribution, so precision-v2 remains
 * pending until a new report and authoritative source manifest are reviewed.
 */
export type EvaluationReleaseAttestation = {
  readonly status: "pending_live_calibration" | "accepted";
  readonly buildId: string;
  readonly reportDigest: string | null;
  readonly corpusDigest: string;
  readonly policyDigest: string;
  readonly authoritativeSourceHashes: Readonly<Record<string, ReadonlyArray<string>>>;
  readonly expiresAt: string | null;
};

export const evaluationReleaseAttestation: EvaluationReleaseAttestation = Object.freeze({
  status: "pending_live_calibration",
  buildId: "rfc-evidence-precision-v2",
  reportDigest: null,
  corpusDigest: evaluationCorpusDigest,
  policyDigest: evaluationPolicyDigest,
  authoritativeSourceHashes: Object.freeze({}),
  expiresAt: null,
});

/**
 * Options controlling report and gate construction.
 */
export interface EvaluationReportOptions {
  /**
   * Origin recorded in the report and required for automatic-answer activation.
   */
  readonly origin: EvaluationOrigin | undefined;
  /**
   * Release/build identity recorded in the report.
   */
  readonly releaseBuildId: string | undefined;
  /**
   * Digest of the committed base corpus, even when observations are repeated.
   */
  readonly corpusDigest: string | undefined;
  /**
   * UTC report creation time.
   */
  readonly createdAt: string | undefined;
  /**
   * UTC report expiry time.
   */
  readonly expiresAt: string | undefined;
  /**
   * Authoritative RFC source hashes reviewed for release activation.
   */
  readonly authoritativeSourceHashes: Readonly<Record<string, ReadonlyArray<string>>> | undefined;
  /**
   * Policy version recorded in the report.
   */
  readonly policyVersion: string | undefined;
  /**
   * Model alias sent to the provider.
   */
  readonly requestedModel: string | undefined;
  /**
   * Exact model required for a passing pin gate.
   */
  readonly pinnedModel: string | undefined;
  /**
   * Minimum precision required for automatic support.
   */
  readonly minimumSupportedClaimPrecision: number | undefined;
  /**
   * Strict p95 limit for known-RFC research.
   */
  readonly maxKnownRfcP95LatencyMilliseconds: number | undefined;
  /**
   * Strict p95 limit for topic research.
   */
  readonly maxTopicP95LatencyMilliseconds: number | undefined;
}

type ResolvedEvaluationPolicy = EvaluationPolicy;

const resolveReportOptions = (
  options: EvaluationReportOptions | undefined,
): ResolvedEvaluationPolicy => {
  const minimumSupportedClaimPrecision =
    options?.minimumSupportedClaimPrecision ?? evaluationPolicy.minimumSupportedClaimPrecision;
  const maxKnownRfcP95LatencyMilliseconds =
    options?.maxKnownRfcP95LatencyMilliseconds ??
    evaluationPolicy.maxKnownRfcP95LatencyMilliseconds;
  const maxTopicP95LatencyMilliseconds =
    options?.maxTopicP95LatencyMilliseconds ?? evaluationPolicy.maxTopicP95LatencyMilliseconds;
  return Schema.decodeUnknownSync(EvaluationPolicySchema)({
    ...evaluationPolicy,
    policyVersion: options?.policyVersion ?? evaluationPolicy.policyVersion,
    requestedModel: options?.requestedModel ?? evaluationPolicy.requestedModel,
    pinnedModel: options?.pinnedModel ?? evaluationPolicy.pinnedModel,
    minimumSupportedClaimPrecision,
    maxKnownRfcP95LatencyMilliseconds,
    maxTopicP95LatencyMilliseconds,
    acceptanceLimits: {
      ...evaluationPolicy.acceptanceLimits,
      minimumSupportedClaimPrecision,
      maxKnownRfcP95LatencyMilliseconds,
      maxTopicP95LatencyMilliseconds,
    },
  });
};

/**
 * Schema for the individual checks that determine whether calibration passed.
 */
export const EvaluationGateSchema = Schema.Struct({
  passed: Schema.Boolean,
  corpusComplete: Schema.Boolean,
  expectedOutcomePassed: Schema.Boolean,
  positiveControlPassed: Schema.Boolean,
  precisionPassed: Schema.Boolean,
  citationSafetyPassed: Schema.Boolean,
  retrievalCasesPassed: Schema.Boolean,
  retrievalBoundsPassed: Schema.Boolean,
  latencyPassed: Schema.Boolean,
  modelPinPassed: Schema.Boolean,
  precisionThreshold: Schema.Finite,
  knownRfcP95LimitMilliseconds: Schema.Finite,
  topicP95LimitMilliseconds: Schema.Finite,
  pinnedModel: Schema.NonEmptyString,
  failures: Schema.Array(Schema.NonEmptyString),
});

/**
 * Gate results explaining why a calibration report is or is not releasable.
 */
export type EvaluationGate = Schema.Schema.Type<typeof EvaluationGateSchema>;

/**
 * Schema for the sanitized, reproducible evaluation report.
 */
export const EvaluationReportSchema = Schema.Struct({
  schemaVersion: Schema.Literal(evaluationSchemaVersion),
  kind: Schema.Literal("rfc_evaluation"),
  origin: EvaluationOriginSchema,
  releaseBuildId: Schema.NonEmptyString,
  createdAt: Schema.NonEmptyString,
  expiresAt: Schema.NonEmptyString,
  corpusDigest: Schema.NonEmptyString,
  policyDigest: Schema.NonEmptyString,
  policy: EvaluationPolicySchema,
  authoritativeSourceHashes: Schema.Record(Schema.String, Schema.Array(Schema.NonEmptyString)),
  corpusVersion: Schema.NonEmptyString,
  policyVersion: Schema.NonEmptyString,
  requestedModel: Schema.NonEmptyString,
  resolvedModel: Schema.NonEmptyString,
  pinnedModel: Schema.NonEmptyString,
  observations: Schema.Array(EvaluationObservationSchema),
  retrievalObservations: Schema.Array(EvaluationRetrievalObservationSchema),
  metrics: EvaluationMetricsSchema,
  gate: EvaluationGateSchema,
});

/**
 * A reproducible report containing no prompts, questions, or hidden reasoning.
 */
export type EvaluationReport = Schema.Schema.Type<typeof EvaluationReportSchema>;

/**
 * Decode an evaluation report at the untrusted file boundary.
 *
 * @param input Unknown report data read from the local calibration artifact.
 * @returns A schema-validated evaluation report.
 */
export const decodeEvaluationReport = (input: unknown): EvaluationReport =>
  Schema.decodeUnknownSync(EvaluationReportSchema)(input);

/**
 * Calculate the canonical digest bound into a reviewed release attestation.
 *
 * @param report Schema-validated evaluation report.
 * @returns SHA-256 digest of the canonical report representation.
 */
export const evaluationReportDigest = (report: EvaluationReport): string => sha256(report);

/**
 * A typed failure caused by malformed evaluation input or incomplete results.
 */
export class EvaluationInputError extends Schema.TaggedError<EvaluationInputError>()(
  "EvaluationInputError",
  { reason: Schema.String },
) {}

const outcomeForCase = (evaluationCase: EvaluationCase): string => {
  if (evaluationCase.kind === "research") {
    if (evaluationCase.expectedStatus === null) {
      throw new EvaluationInputError({
        reason: `Research case ${evaluationCase.id} is missing an expected status`,
      });
    }
    return evaluationCase.expectedStatus;
  }
  if (evaluationCase.expectedVerdict === null) {
    throw new EvaluationInputError({
      reason: `Citation case ${evaluationCase.id} is missing an expected verdict`,
    });
  }
  return evaluationCase.expectedVerdict;
};

const observationMatchesCase = (
  evaluationCase: EvaluationCase,
  observation: EvaluationObservation,
): boolean =>
  observation.caseId === evaluationCase.id &&
  observation.category === evaluationCase.category &&
  observation.kind === evaluationCase.kind &&
  observation.mode === evaluationCase.mode &&
  observation.expectedOutcome === outcomeForCase(evaluationCase) &&
  sameStringSequence(observation.allowedOutcomes, evaluationCase.allowedOutcomes);

const hasAcceptedDirectEvidence = (observation: EvaluationObservation): boolean => {
  if (observation.kind !== "research" || observation.observedOutcome !== "answered") return true;
  const classificationPrefix = "classification.";
  const classificationSuffix = ".direct_answer";
  return Object.entries(observation.probabilities).some(([key, probability]) => {
    if (!key.startsWith(classificationPrefix) || !key.endsWith(classificationSuffix)) {
      return false;
    }
    const candidateId = key.slice(
      classificationPrefix.length,
      key.length - classificationSuffix.length,
    );
    const selectionProbability =
      observation.probabilities[`selection.${candidateId}.probability`] ?? 0;
    const documentCandidateId = candidateId.split(":", 1)[0] ?? candidateId;
    const documentProbability =
      observation.probabilities[`document.${documentCandidateId}.probability`] ?? 0;
    const documentAccepted =
      observation.mode !== "topic" ||
      documentProbability >= precisionPolicy.documentProbabilityThreshold;
    return (
      probability >= precisionPolicy.directAnswerProbabilityThreshold &&
      selectionProbability >= precisionPolicy.selectionProbabilityThreshold &&
      documentAccepted
    );
  });
};

const observationHasSafeOutcome = (observation: EvaluationObservation): boolean => {
  const allowedOutcomes = allowedOutcomesForCaseId(observation.caseId, observation.expectedOutcome);
  const automaticOutcome =
    observation.observedOutcome === "answered" || observation.observedOutcome === "verified";
  return (
    sameStringSequence(observation.allowedOutcomes, allowedOutcomes) &&
    allowedOutcomes.includes(observation.expectedOutcome) &&
    allowedOutcomes.includes(observation.observedOutcome) &&
    (!automaticOutcome || observation.acceptedByPolicy) &&
    hasAcceptedDirectEvidence(observation)
  );
};

const unique = (values: ReadonlyArray<string>): ReadonlyArray<string> => [...new Set(values)];

const finiteValues = (values: ReadonlyArray<number | null>): ReadonlyArray<number> =>
  values.flatMap((value) => (value === null || !Number.isFinite(value) ? [] : [value]));

const maximumConfidence = (values: ReadonlyArray<number | null>): number | null => {
  const finite = finiteValues(values);
  return finite.length === 0 ? null : Math.max(...finite);
};

const probabilityEntries = (
  prefix: string,
  probabilities: Readonly<Record<string, number>>,
): ReadonlyArray<readonly [string, number]> =>
  Object.entries(probabilities).map(([label, value]) => [`${prefix}.${label}`, value] as const);

const sourceProvenanceFromBundle = (
  bundle: EvidenceBundle,
): ReadonlyArray<EvaluationSourceProvenance> => {
  const sources = bundle.diagnostics.sources;
  const provenance =
    sources === undefined
      ? bundle.diagnostics.source === null
        ? []
        : [bundle.diagnostics.source]
      : sources.map((source) => ("sourceHash" in source ? source : source.source));
  return [
    ...new Map(
      provenance.map(({ identifier, sourceHash }) => [
        `${identifier}\u0000${sourceHash}`,
        { identifier, sourceHash },
      ]),
    ).values(),
  ];
};

const probabilitiesFromBundle = (bundle: EvidenceBundle): Readonly<Record<string, number>> =>
  Object.fromEntries([
    ...(bundle.diagnostics.atomicity === null
      ? []
      : probabilityEntries("atomicity", bundle.diagnostics.atomicity.probabilities)),
    ...(bundle.diagnostics.documentSelection ?? []).flatMap((selection) =>
      probabilityEntries(`document.${selection.candidateId}`, {
        probability: selection.probability,
      }),
    ),
    ...bundle.diagnostics.selection.flatMap((selection) =>
      probabilityEntries(`selection.${selection.candidateId}`, {
        probability: selection.probability,
      }),
    ),
    ...bundle.diagnostics.classification.flatMap((classification) =>
      probabilityEntries(
        `classification.${classification.candidateId}`,
        classification.probabilities,
      ),
    ),
  ]);

const confidenceFromBundle = (bundle: EvidenceBundle): number | null =>
  maximumConfidence([
    bundle.diagnostics.atomicity?.confidence ?? null,
    ...bundle.diagnostics.classification.map((classification) => classification.confidence),
    ...bundle.evidence.map((passage) => passage.confidence),
  ]);

const timingsFromBundle = (bundle: EvidenceBundle): EvaluationTimings => ({
  metadataMs: bundle.diagnostics.timings.metadataMs,
  documentMs: bundle.diagnostics.timings.documentMs ?? null,
  sourceMs: bundle.diagnostics.timings.sourceMs,
  lexicalMs: bundle.diagnostics.timings.lexicalMs,
  selectionMs: bundle.diagnostics.timings.selectionMs,
  relationMs: bundle.diagnostics.timings.relationMs,
  verificationMs: null,
  totalMs: bundle.diagnostics.timings.totalMs,
});

const usageFromBundle = (bundle: EvidenceBundle): EvaluationUsage => bundle.diagnostics.usage;

const observation = (value: unknown): EvaluationObservation =>
  Schema.decodeUnknownSync(EvaluationObservationSchema)(value);

/**
 * Convert a public research bundle into a sanitized evaluation observation.
 *
 * @param evaluationCase Committed case that produced the bundle.
 * @param bundle Public research result.
 * @returns An observation containing metrics and provenance metadata only.
 */
export const observationFromEvidenceBundle = (
  evaluationCase: EvaluationCase,
  bundle: EvidenceBundle,
): EvaluationObservation => {
  if (evaluationCase.kind !== "research") {
    throw new EvaluationInputError({
      reason: `Case ${evaluationCase.id} cannot consume a research bundle`,
    });
  }
  const observedOutcome = bundle.status;
  const acceptedByPolicy = observedOutcome === "answered";
  return observation({
    schemaVersion: evaluationSchemaVersion,
    caseId: evaluationCase.id,
    category: evaluationCase.category,
    kind: evaluationCase.kind,
    mode: evaluationCase.mode,
    expectedOutcome: outcomeForCase(evaluationCase),
    observedOutcome,
    allowedOutcomes: evaluationCase.allowedOutcomes,
    acceptedByPolicy,
    unsafeCitationAccepted: false,
    sourceProvenance: sourceProvenanceFromBundle(bundle),
    requestedModel: bundle.diagnostics.requestedModel,
    resolvedModel: bundle.diagnostics.resolvedModel,
    resolvedModels: bundle.diagnostics.resolvedModels,
    policyVersion: bundle.diagnostics.policyVersion,
    usage: usageFromBundle(bundle),
    timings: timingsFromBundle(bundle),
    retrieval: bundle.diagnostics.retrieval,
    totalLatencyMs: bundle.diagnostics.timings.totalMs,
    probabilities: probabilitiesFromBundle(bundle),
    confidence: confidenceFromBundle(bundle),
    errorKind: null,
  });
};

const timingsFromCitation = (result: CitationVerificationResult): EvaluationTimings => ({
  metadataMs: result.diagnostics.timings.metadataMs,
  documentMs: null,
  sourceMs: result.diagnostics.timings.sourceMs,
  lexicalMs: null,
  selectionMs: null,
  relationMs: null,
  verificationMs: result.diagnostics.timings.verificationMs,
  totalMs: result.diagnostics.timings.totalMs,
});

/**
 * Convert a public citation result into a sanitized evaluation observation.
 *
 * @param evaluationCase Committed case that produced the citation result.
 * @param result Public citation verification result.
 * @returns An observation containing verdict and diagnostic metadata only.
 */
export const observationFromCitationResult = (
  evaluationCase: EvaluationCase,
  result: CitationVerificationResult,
): EvaluationObservation => {
  if (evaluationCase.kind !== "citation") {
    throw new EvaluationInputError({
      reason: `Case ${evaluationCase.id} cannot consume a citation result`,
    });
  }
  const acceptedByPolicy = result.verdict === "verified";
  const expectedOutcome = outcomeForCase(evaluationCase);
  return observation({
    schemaVersion: evaluationSchemaVersion,
    caseId: evaluationCase.id,
    category: evaluationCase.category,
    kind: evaluationCase.kind,
    mode: evaluationCase.mode,
    expectedOutcome,
    observedOutcome: result.verdict,
    allowedOutcomes: evaluationCase.allowedOutcomes,
    acceptedByPolicy,
    unsafeCitationAccepted:
      acceptedByPolicy && (expectedOutcome === "fabricated" || expectedOutcome === "contradicted"),
    sourceProvenance: [
      {
        identifier: result.provenance.identifier,
        sourceHash: result.provenance.sourceHash,
      },
    ],
    requestedModel: result.diagnostics.requestedModel,
    resolvedModel: result.diagnostics.resolvedModel,
    resolvedModels: result.diagnostics.resolvedModels,
    policyVersion: evaluationPolicy.policyVersion,
    usage: result.diagnostics.usage,
    timings: timingsFromCitation(result),
    retrieval: result.diagnostics.retrieval ?? null,
    totalLatencyMs: result.diagnostics.timings.totalMs,
    probabilities: result.probabilities,
    confidence: result.confidence,
    errorKind: null,
  });
};

/**
 * Build a sanitized observation for a case that could not complete.
 *
 * @param evaluationCase Case whose operation failed.
 * @param options Model and policy metadata to record.
 * @param errorKind Stable, non-sensitive failure category.
 * @returns A failed observation that causes the relevant evaluation gate to fail.
 */
export const failedEvaluationObservation = (
  evaluationCase: EvaluationCase,
  options: EvaluationReportOptions | undefined,
  errorKind: string,
): EvaluationObservation => {
  const resolved = resolveReportOptions(options);
  return observation({
    schemaVersion: evaluationSchemaVersion,
    caseId: evaluationCase.id,
    category: evaluationCase.category,
    kind: evaluationCase.kind,
    mode: evaluationCase.mode,
    expectedOutcome: outcomeForCase(evaluationCase),
    observedOutcome: "error",
    allowedOutcomes: evaluationCase.allowedOutcomes,
    acceptedByPolicy: false,
    unsafeCitationAccepted: false,
    sourceProvenance: [],
    requestedModel: resolved.requestedModel,
    resolvedModel: "unknown",
    resolvedModels: ["unknown"],
    policyVersion: resolved.policyVersion,
    usage: { inputTokens: null, outputTokens: null },
    timings: {
      metadataMs: null,
      documentMs: null,
      sourceMs: null,
      lexicalMs: null,
      selectionMs: null,
      relationMs: null,
      verificationMs: null,
      totalMs: 0,
    },
    retrieval: null,
    totalLatencyMs: 0,
    probabilities: {},
    confidence: null,
    errorKind,
  });
};

const percentile95 = (values: ReadonlyArray<number>): number => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1);
  return sorted[index] ?? 0;
};

/**
 * Calculate the p95 value for a finite latency sample.
 *
 * @param values Latency samples in milliseconds.
 * @returns The nearest-rank p95, or zero for an empty sample.
 */
export const p95Milliseconds = (values: ReadonlyArray<number>): number => percentile95(values);

const rate = (count: number, total: number): number => (total === 0 ? 0 : count / total);

const rateFor = (observations: ReadonlyArray<EvaluationObservation>, outcome: string): number =>
  rate(
    observations.filter((observation) => observation.observedOutcome === outcome).length,
    observations.length,
  );

/**
 * Aggregate precision, coverage, status, verdict, and latency measurements.
 *
 * @param observations Sanitized observations from one evaluation run.
 * @returns Deterministic aggregate metrics.
 */
export const calculateEvaluationMetrics = (
  observations: ReadonlyArray<EvaluationObservation>,
): EvaluationMetrics => {
  const research = observations.filter((observation) => observation.kind === "research");
  const citations = observations.filter((observation) => observation.kind === "citation");
  const supported = citations.filter((observation) => observation.expectedOutcome === "verified");
  const acceptedCitations = citations.filter((observation) => observation.acceptedByPolicy);
  const acceptedSupported = acceptedCitations.filter(
    (observation) => observation.expectedOutcome === "verified",
  );
  const acceptedUnsupported = acceptedCitations.filter(
    (observation) => observation.expectedOutcome !== "verified",
  );
  const knownRfcResearch = research.filter((observation) => observation.mode === "known_rfc");
  const topicResearch = research.filter((observation) => observation.mode === "topic");
  const precision =
    acceptedCitations.length === 0 ? 1 : acceptedSupported.length / acceptedCitations.length;
  const coverage = supported.length === 0 ? 1 : acceptedSupported.length / supported.length;

  return Schema.decodeUnknownSync(EvaluationMetricsSchema)({
    researchCases: research.length,
    citationCases: citations.length,
    knownRfcResearchCases: knownRfcResearch.length,
    topicResearchCases: topicResearch.length,
    supportedClaims: supported.length,
    acceptedSupportedClaims: acceptedSupported.length,
    acceptedUnsupportedClaims: acceptedUnsupported.length,
    acceptedCitationCount: acceptedCitations.length,
    supportedClaimPrecision: precision,
    researchAnswerRate: rateFor(research, "answered"),
    supportedClaimCoverage: coverage,
    unsafeCitationAcceptances: citations.filter(
      (observation) =>
        observation.acceptedByPolicy &&
        (observation.expectedOutcome === "fabricated" ||
          observation.expectedOutcome === "contradicted"),
    ).length,
    statusRates: {
      answered: rateFor(research, "answered"),
      partial: rateFor(research, "partial"),
      unsupported: rateFor(research, "unsupported"),
      needs_review: rateFor(research, "needs_review"),
      needs_split: rateFor(research, "needs_split"),
    },
    verdictRates: {
      verified: rateFor(citations, "verified"),
      unsupported: rateFor(citations, "unsupported"),
      contradicted: rateFor(citations, "contradicted"),
      fabricated: rateFor(citations, "fabricated"),
    },
    knownRfcP95LatencyMs: percentile95(
      knownRfcResearch.map((observation) => observation.totalLatencyMs),
    ),
    topicP95LatencyMs: percentile95(topicResearch.map((observation) => observation.totalLatencyMs)),
  });
};

/**
 * Schema for gate evaluation output.
 */
export const EvaluationGateResultSchema = EvaluationGateSchema;

/**
 * Identify fabricated citations that correctly bypassed the provider.
 *
 * These observations still record the requested alias, but have no provider
 * model to pin because quote absence is decided before semantic judgment.
 */
const isDeterministicFabricatedObservation = (observation: EvaluationObservation): boolean =>
  observation.kind === "citation" &&
  observation.observedOutcome === "fabricated" &&
  observation.usage.inputTokens === null &&
  observation.usage.outputTokens === null;

const isProviderlessObservation = (observation: EvaluationObservation): boolean =>
  isDeterministicFabricatedObservation(observation) ||
  (observation.kind === "research" &&
    observation.observedOutcome === "needs_review" &&
    observation.retrieval?.semanticCandidates === 0 &&
    observation.usage.inputTokens === null &&
    observation.usage.outputTokens === null);

const calibrationCases = evaluationCorpus.cases.filter((evaluationCase) => evaluationCase.live);

const calibrationObservationSetPassed = (
  observations: ReadonlyArray<EvaluationObservation>,
): boolean => {
  if (calibrationCases.length === 0) return false;
  const expectedById = new Map(
    calibrationCases.map((evaluationCase) => [evaluationCase.id, evaluationCase]),
  );
  const repetitions = 3;
  if (
    observations.length !== calibrationCases.length * repetitions ||
    new Set(observations.map((observation) => observation.caseId)).size !== observations.length
  ) {
    return false;
  }
  const counts = new Map<string, number>();
  for (const observation of observations) {
    const iteration = /^(.*):iteration-([1-3])$/.exec(observation.caseId);
    const baseId = iteration?.[1] ?? observation.caseId;
    const evaluationCase = expectedById.get(baseId);
    if (evaluationCase === undefined) return false;
    if (iteration === null) {
      return false;
    }
    if (
      observation.category !== evaluationCase.category ||
      observation.kind !== evaluationCase.kind ||
      observation.mode !== evaluationCase.mode ||
      observation.expectedOutcome !== outcomeForCase(evaluationCase) ||
      !sameStringSequence(observation.allowedOutcomes, evaluationCase.allowedOutcomes)
    ) {
      return false;
    }
    counts.set(baseId, (counts.get(baseId) ?? 0) + 1);
  }
  return (
    counts.size === calibrationCases.length &&
    calibrationCases.every((evaluationCase) => counts.get(evaluationCase.id) === repetitions)
  );
};

/**
 * Check a local calibration artifact against one trusted release attestation.
 *
 * @internal The public activation path always supplies the compiled attestation;
 * this parameterized form keeps the acceptance predicates directly testable.
 *
 * @param input Unknown report data read from the local calibration artifact.
 * @param attestation Trusted release attestation compiled into the build.
 * @param now Current epoch milliseconds used for freshness validation.
 * @returns Whether the artifact proves a passing calibration for this attestation.
 */
export const isAcceptedEvaluationReportForAttestation = (
  input: unknown,
  attestation: EvaluationReleaseAttestation,
  now: number = Date.now(),
): boolean => {
  try {
    const report = decodeEvaluationReport(input);
    const gate = report.gate;
    const policy = evaluationPolicy;
    const createdAt = Date.parse(report.createdAt);
    const expiresAt = Date.parse(report.expiresAt);
    const observedSourceManifest = sourceHashManifest(report.observations);
    const sourceManifestComplete =
      Object.keys(observedSourceManifest).length > 0 &&
      stableJson(report.authoritativeSourceHashes) === stableJson(observedSourceManifest);
    const observationsBoundToSources = report.observations.every((observation) =>
      observation.sourceProvenance.every(({ identifier, sourceHash }) =>
        (attestation.authoritativeSourceHashes[identifier] ?? []).includes(sourceHash),
      ),
    );
    return (
      attestation.status === "accepted" &&
      sourceManifestComplete &&
      observationsBoundToSources &&
      attestation.reportDigest !== null &&
      attestation.expiresAt !== null &&
      report.releaseBuildId === attestation.buildId &&
      report.expiresAt === attestation.expiresAt &&
      evaluationReportDigest(report) === attestation.reportDigest &&
      Number.isFinite(createdAt) &&
      Number.isFinite(expiresAt) &&
      createdAt <= now &&
      now < expiresAt &&
      report.origin === "live" &&
      report.corpusVersion === evaluationCorpusVersion &&
      report.corpusDigest === evaluationCorpusDigest &&
      report.policyVersion === policy.policyVersion &&
      report.policyDigest === evaluationPolicyDigest &&
      stableJson(report.policy) === stableJson(policy) &&
      stableJson(report.authoritativeSourceHashes) ===
        stableJson(attestation.authoritativeSourceHashes) &&
      report.requestedModel === policy.requestedModel &&
      report.pinnedModel === policy.pinnedModel &&
      gate.passed &&
      gate.corpusComplete &&
      gate.expectedOutcomePassed &&
      gate.positiveControlPassed &&
      gate.precisionPassed &&
      gate.citationSafetyPassed &&
      gate.retrievalCasesPassed &&
      gate.retrievalBoundsPassed &&
      gate.latencyPassed &&
      gate.modelPinPassed &&
      gate.precisionThreshold === policy.minimumSupportedClaimPrecision &&
      gate.knownRfcP95LimitMilliseconds === policy.maxKnownRfcP95LatencyMilliseconds &&
      gate.topicP95LimitMilliseconds === policy.maxTopicP95LatencyMilliseconds &&
      gate.failures.length === 0 &&
      calibrationObservationSetPassed(report.observations) &&
      retrievalObservationSetPassed(
        evaluationCorpus.retrievalCases,
        report.retrievalObservations,
      ) &&
      report.retrievalObservations.every((observation) =>
        retrievalObservationHasEvidence(observation, policy),
      ) &&
      report.observations.length > 0 &&
      JSON.stringify(calculateEvaluationMetrics(report.observations)) ===
        JSON.stringify(report.metrics) &&
      report.metrics.supportedClaimPrecision >= policy.minimumSupportedClaimPrecision &&
      report.metrics.knownRfcP95LatencyMs < policy.maxKnownRfcP95LatencyMilliseconds &&
      report.metrics.topicP95LatencyMs < policy.maxTopicP95LatencyMilliseconds &&
      report.metrics.unsafeCitationAcceptances === 0 &&
      report.observations.every((observation) => retrievalTraceWithinPolicy(observation, policy)) &&
      report.observations.every(
        (observation) =>
          observation.policyVersion === policy.policyVersion &&
          observation.requestedModel === policy.requestedModel &&
          observationHasSafeOutcome(observation) &&
          !observation.unsafeCitationAccepted &&
          observation.errorKind === null &&
          (isProviderlessObservation(observation)
            ? observation.resolvedModels.length === 0
            : observation.resolvedModels.length > 0 &&
              observation.resolvedModels.every((model) => model === policy.pinnedModel) &&
              observation.resolvedModel === policy.pinnedModel),
      )
    );
  } catch {
    return false;
  }
};

/**
 * Check whether a local calibration artifact is safe to activate.
 *
 * Every release gate and every observable report identity must agree with the
 * committed policy. Invalid, stale, incomplete, or mixed-model artifacts fail
 * closed rather than enabling automatic answers.
 *
 * @param input Unknown report data read from the local calibration artifact.
 * @returns Whether the artifact proves a passing calibration for this build.
 */
export const isAcceptedEvaluationReport = (input: unknown): boolean =>
  isAcceptedEvaluationReportForAttestation(input, evaluationReleaseAttestation);

const requestTraceWithinPolicy = (trace: LiveRetrievalTrace, policy: EvaluationPolicy): boolean => {
  const datatrackerRequests = trace.requests.filter(({ kind }) => kind !== "source");
  const sourceRequests = trace.requests.filter(({ kind }) => kind === "source");
  return (
    trace.requestCount === trace.requests.length &&
    trace.datatrackerRequestCount === datatrackerRequests.length &&
    trace.sourceRequestCount === sourceRequests.length &&
    trace.requests.every(
      ({ attempts, statuses }) => attempts > 0 && attempts === statuses.length,
    ) &&
    datatrackerRequests.every(
      ({ attempts }) => attempts <= policy.retrievalLimits.datatrackerMaxAttempts,
    )
  );
};

const topicTraceWithinPolicy = (trace: LiveRetrievalTrace, policy: EvaluationPolicy): boolean =>
  requestTraceWithinPolicy(trace, policy) &&
  trace.datatrackerRequestCount <= policy.retrievalLimits.maxTopicRequests &&
  trace.upstreamRows !== undefined &&
  trace.upstreamRows <= policy.retrievalLimits.maxUpstreamTopicRows &&
  trace.uniqueCandidates !== undefined &&
  trace.mergeLimit === policy.candidateLimits.maxMergedDocumentCandidates &&
  trace.semanticCandidates !== undefined &&
  trace.semanticCandidates <= policy.candidateLimits.maxMergedDocumentCandidates &&
  trace.selectedSources !== undefined &&
  trace.selectedSources <= policy.candidateLimits.maxSourceRetrievalCandidates;

const knownRfcTraceWithinPolicy = (
  trace: LiveRetrievalTrace,
  policy: EvaluationPolicy,
): boolean => {
  if (
    !requestTraceWithinPolicy(trace, policy) ||
    trace.traversalComplete === undefined ||
    trace.traversalContexts === undefined ||
    trace.traversalDepth === undefined ||
    trace.successorRows === undefined ||
    trace.boundedExits === undefined ||
    trace.contextLimit === undefined ||
    trace.depthLimit === undefined ||
    trace.relationshipLimit === undefined
  ) {
    return false;
  }

  const datatrackerRequests = trace.requests.filter(({ kind }) => kind !== "source");
  const traversalRequestsMatch =
    datatrackerRequests.filter(({ kind }) => kind === "metadata").length ===
      trace.traversalContexts &&
    datatrackerRequests.filter(({ kind }) => kind === "relationships").length ===
      trace.traversalContexts;
  const boundedExitStateMatches = trace.traversalComplete
    ? trace.boundedExits.length === 0
    : trace.boundedExits.length > 0;
  const boundedExitDetailsMatch =
    (!trace.boundedExits.includes("context_limit") ||
      trace.traversalContexts === trace.contextLimit) &&
    (!trace.boundedExits.includes("depth_limit") || trace.traversalDepth === trace.depthLimit) &&
    (!trace.boundedExits.includes("relationship_limit") ||
      trace.successorRows >= trace.relationshipLimit);
  return (
    trace.contextLimit === policy.traversalLimits.maxContexts &&
    trace.depthLimit <= policy.traversalLimits.maxDepth &&
    trace.relationshipLimit === policy.traversalLimits.maxRelationshipsPerRfc &&
    trace.traversalContexts > 0 &&
    trace.traversalContexts <= trace.contextLimit &&
    trace.traversalDepth <= trace.depthLimit &&
    trace.successorRows <= trace.relationshipLimit * trace.traversalContexts &&
    traversalRequestsMatch &&
    boundedExitStateMatches &&
    boundedExitDetailsMatch &&
    trace.sourceRequestCount <= policy.candidateLimits.maxSourceRetrievalCandidates
  );
};

const retrievalTraceWithinPolicy = (
  observation: EvaluationObservation,
  policy: EvaluationPolicy,
): boolean => {
  const trace = observation.retrieval;
  if (trace === null) return false;
  if (observation.kind === "citation") {
    return (
      requestTraceWithinPolicy(trace, policy) &&
      trace.datatrackerRequestCount === 1 &&
      trace.sourceRequestCount <= 1
    );
  }
  return observation.mode === "topic"
    ? topicTraceWithinPolicy(trace, policy)
    : knownRfcTraceWithinPolicy(trace, policy) &&
        trace.depthLimit === policy.traversalLimits.maxDepth;
};

const sameNumbers = (left: ReadonlyArray<number>, right: ReadonlyArray<number>): boolean =>
  left.length === right.length && left.every((value, index) => value === right[index]);

const isStrongValidator = (value: string | null | undefined): boolean =>
  value !== null && value !== undefined && /^"[^"\r\n]*"$/.test(value);

const cacheEvidenceMatches = (
  observation: EvaluationRetrievalObservation,
  expectedOutcome: LiveRetrievalTrace["sourceCacheOutcome"],
): boolean => {
  const evidence = observation.cacheEvidence;
  if (evidence === null) return false;
  const traceCounts = observation.traces.map(({ sourceRequestCount }) => sourceRequestCount);
  const validators = evidence.validators;
  const base =
    observation.traces.some(({ sourceCacheOutcome }) => sourceCacheOutcome === expectedOutcome) &&
    sameNumbers(evidence.sourceRequestCounts, traceCounts) &&
    evidence.networkRequestCount ===
      evidence.sourceRequestCounts.reduce((sum, count) => sum + count, 0) &&
    validators.length === evidence.networkRequestCount &&
    evidence.returnedSourceHash !== null &&
    evidence.returnedSourceHash === evidence.afterSourceHash;
  if (!base) return false;
  switch (observation.category) {
    case "source_cache_miss":
      return (
        evidence.beforeSourceHash === null &&
        evidence.afterSourceHash !== null &&
        sameNumbers(evidence.sourceRequestCounts, [1]) &&
        validators[0] === null &&
        !evidence.cacheEntryCorrupted
      );
    case "source_cache_hit":
      return (
        evidence.beforeSourceHash !== null &&
        evidence.beforeSourceHash === evidence.afterSourceHash &&
        sameNumbers(evidence.sourceRequestCounts, [1, 0]) &&
        validators[0] === null &&
        !evidence.cacheEntryCorrupted
      );
    case "source_cache_revalidated":
      return (
        evidence.beforeSourceHash !== null &&
        evidence.beforeSourceHash === evidence.afterSourceHash &&
        sameNumbers(evidence.sourceRequestCounts, [1, 1]) &&
        validators[0] === null &&
        isStrongValidator(validators[1]) &&
        !evidence.cacheEntryCorrupted
      );
    case "source_cache_replaced":
      return (
        evidence.beforeSourceHash !== null &&
        evidence.afterSourceHash !== null &&
        evidence.beforeSourceHash !== evidence.afterSourceHash &&
        sameNumbers(evidence.sourceRequestCounts, [1, 1]) &&
        validators[0] === null &&
        isStrongValidator(validators[1]) &&
        !evidence.cacheEntryCorrupted
      );
    case "source_cache_repaired":
      return (
        evidence.beforeSourceHash !== null &&
        evidence.beforeSourceHash === evidence.afterSourceHash &&
        sameNumbers(evidence.sourceRequestCounts, [1, 1]) &&
        validators.every((validator) => validator === null) &&
        evidence.cacheEntryCorrupted
      );
    default:
      return false;
  }
};

const retrievalObservationHasEvidence = (
  observation: EvaluationRetrievalObservation,
  policy: EvaluationPolicy,
): boolean => {
  if (!observation.passed) return false;
  if (observation.category === "fail_closed_metadata") {
    return (
      observation.errorKind === "RfcDiscoveryError" &&
      observation.traces.length === 0 &&
      observation.cacheEvidence === null
    );
  }
  if (observation.category === "fail_closed_revalidation") {
    const evidence = observation.cacheEvidence;
    return (
      observation.errorKind === "RfcSourceRevalidationError" &&
      observation.traces.length === 1 &&
      observation.traces.every((trace) => knownRfcTraceWithinPolicy(trace, policy)) &&
      evidence !== null &&
      evidence.beforeSourceHash !== null &&
      evidence.beforeSourceHash === evidence.afterSourceHash &&
      evidence.returnedSourceHash === null &&
      sameNumbers(evidence.sourceRequestCounts, [1, 1]) &&
      evidence.networkRequestCount === 2 &&
      evidence.validators.length === 2 &&
      evidence.validators[0] === null &&
      isStrongValidator(evidence.validators[1]) &&
      !evidence.cacheEntryCorrupted
    );
  }
  if (
    observation.errorKind !== null ||
    observation.traces.length === 0 ||
    (observation.category.startsWith("source_cache_")
      ? observation.cacheEvidence === null
      : observation.cacheEvidence !== null)
  ) {
    return false;
  }
  const finalTrace = observation.traces[observation.traces.length - 1];
  if (finalTrace === undefined) return false;
  switch (observation.category) {
    case "known_current_rfc":
      return (
        observation.traces.every((trace) => knownRfcTraceWithinPolicy(trace, policy)) &&
        finalTrace.traversalComplete === true &&
        finalTrace.traversalContexts === 1 &&
        finalTrace.traversalDepth === 0
      );
    case "update_chain":
      return (
        observation.traces.every((trace) => knownRfcTraceWithinPolicy(trace, policy)) &&
        (finalTrace.traversalContexts ?? 0) >= 2 &&
        (finalTrace.traversalDepth ?? 0) >= 1
      );
    case "cycle_safety":
      return (
        observation.traces.every((trace) => knownRfcTraceWithinPolicy(trace, policy)) &&
        (finalTrace.traversalContexts ?? 0) >= 2 &&
        (finalTrace.successorRows ?? 0) >= 2
      );
    case "ordered_topic_terms":
      return (
        observation.traces.every((trace) => topicTraceWithinPolicy(trace, policy)) &&
        finalTrace.requests.filter(({ kind }) => kind === "metadata").length >= 4
      );
    case "candidate_fan_out":
      return (
        observation.traces.every((trace) => topicTraceWithinPolicy(trace, policy)) &&
        finalTrace.datatrackerRequestCount === policy.retrievalLimits.maxTopicRequests &&
        (finalTrace.uniqueCandidates ?? 0) > policy.candidateLimits.maxMergedDocumentCandidates &&
        finalTrace.semanticCandidates === policy.candidateLimits.maxMergedDocumentCandidates &&
        finalTrace.selectedSources === policy.candidateLimits.maxSourceRetrievalCandidates
      );
    case "no_candidate_outcome":
      return (
        observation.traces.every((trace) => topicTraceWithinPolicy(trace, policy)) &&
        finalTrace.semanticCandidates === 0 &&
        finalTrace.selectedSources === 0 &&
        finalTrace.sourceCacheOutcome === "not_requested"
      );
    case "relationship_bound": {
      const exits = finalTrace.boundedExits ?? [];
      return (
        observation.traces.every((trace) => knownRfcTraceWithinPolicy(trace, policy)) &&
        exits.includes("relationship_limit") &&
        exits.includes("context_limit") &&
        exits.includes("depth_limit")
      );
    }
    case "source_cache_miss":
    case "source_cache_hit":
    case "source_cache_revalidated":
    case "source_cache_replaced":
    case "source_cache_repaired": {
      const expectedCacheOutcomes = {
        source_cache_miss: "miss",
        source_cache_hit: "hit",
        source_cache_revalidated: "revalidated",
        source_cache_replaced: "replaced",
        source_cache_repaired: "repaired",
      } as const;
      const expectedCacheOutcome = expectedCacheOutcomes[observation.category];
      return (
        observation.traces.every((trace) => knownRfcTraceWithinPolicy(trace, policy)) &&
        cacheEvidenceMatches(observation, expectedCacheOutcome)
      );
    }
  }
};

/**
 * Evaluate expected outcomes, precision, citation safety, retrieval bounds,
 * latency, completeness, and model pinning.
 *
 * p95 gates are strict: a sample at the configured limit does not pass.
 *
 * @param metrics Aggregate evaluation metrics.
 * @param observations Sanitized semantic observations used to check the model pin.
 * @param retrievalObservations Deterministic public-client retrieval results.
 * @param corpusComplete Whether every committed semantic and retrieval case produced an observation.
 * @param options Optional provisional gate overrides.
 * @returns Individual gate results and a final release decision.
 */
export const evaluateEvaluationGate = (
  metrics: EvaluationMetrics,
  observations: ReadonlyArray<EvaluationObservation>,
  retrievalObservations: ReadonlyArray<EvaluationRetrievalObservation>,
  corpusComplete: boolean | undefined = true,
  options: EvaluationReportOptions | undefined = undefined,
): EvaluationGate => {
  const policy = resolveReportOptions(options);
  const expectedOutcomePassed =
    observations.length > 0 && observations.every(observationHasSafeOutcome);
  const positiveControlPassed = positiveControlObservationSetPassed(observations);
  const precisionPassed =
    metrics.supportedClaims > 0 &&
    metrics.supportedClaimPrecision >= policy.minimumSupportedClaimPrecision;
  const citationSafetyPassed = metrics.unsafeCitationAcceptances === 0;
  const retrievalCasesPassed =
    retrievalObservations.length > 0 &&
    retrievalObservations.every((observation) =>
      retrievalObservationHasEvidence(observation, policy),
    );
  const retrievalBoundsPassed =
    observations.length > 0 &&
    observations.every((observation) => retrievalTraceWithinPolicy(observation, policy));
  const latencyPassed =
    metrics.knownRfcResearchCases > 0 &&
    metrics.topicResearchCases > 0 &&
    metrics.knownRfcP95LatencyMs < policy.maxKnownRfcP95LatencyMilliseconds &&
    metrics.topicP95LatencyMs < policy.maxTopicP95LatencyMilliseconds;
  const modelPinPassed =
    observations.length > 0 &&
    observations.every(
      (observation) =>
        observation.requestedModel === policy.requestedModel &&
        (isProviderlessObservation(observation)
          ? observation.resolvedModels.length === 0
          : observation.resolvedModels.length > 0 &&
            observation.resolvedModels.every((model) => model === policy.pinnedModel) &&
            observation.resolvedModel === policy.pinnedModel),
    );
  const failures: Array<string> = [];
  if (!corpusComplete) failures.push("evaluation corpus is incomplete");
  if (!expectedOutcomePassed) {
    failures.push("observed outcomes fell outside committed allowed outcome sets");
  }
  if (!positiveControlPassed) {
    failures.push("positive-control research cases did not remain answered");
  }
  if (!precisionPassed) {
    failures.push(
      `supported-claim precision ${metrics.supportedClaimPrecision.toFixed(4)} is below ${policy.minimumSupportedClaimPrecision.toFixed(4)}`,
    );
  }
  if (!citationSafetyPassed) failures.push("a fabricated or contradicted citation was accepted");
  if (!retrievalCasesPassed) {
    failures.push("one or more deterministic retrieval cases did not pass");
  }
  if (!retrievalBoundsPassed) {
    failures.push("a retrieval trace exceeded the precision-v2 hard limits");
  }
  if (!latencyPassed) failures.push("warm-cache research p95 latency exceeded a configured gate");
  if (!modelPinPassed) failures.push(`resolved model is not pinned to ${policy.pinnedModel}`);

  return Schema.decodeUnknownSync(EvaluationGateSchema)({
    passed:
      corpusComplete &&
      expectedOutcomePassed &&
      positiveControlPassed &&
      precisionPassed &&
      citationSafetyPassed &&
      retrievalCasesPassed &&
      retrievalBoundsPassed &&
      latencyPassed &&
      modelPinPassed,
    corpusComplete,
    expectedOutcomePassed,
    positiveControlPassed,
    precisionPassed,
    citationSafetyPassed,
    retrievalCasesPassed,
    retrievalBoundsPassed,
    latencyPassed,
    modelPinPassed,
    precisionThreshold: policy.minimumSupportedClaimPrecision,
    knownRfcP95LimitMilliseconds: policy.maxKnownRfcP95LatencyMilliseconds,
    topicP95LimitMilliseconds: policy.maxTopicP95LatencyMilliseconds,
    pinnedModel: policy.pinnedModel,
    failures,
  });
};

const observationIdsMatchCorpus = (
  corpus: EvaluationCorpus,
  observations: ReadonlyArray<EvaluationObservation>,
): boolean => {
  const casesById = new Map(
    corpus.cases.map((evaluationCase) => [evaluationCase.id, evaluationCase]),
  );
  const actualIds = observations.map((observation) => observation.caseId);
  return (
    casesById.size === observations.length &&
    new Set(actualIds).size === actualIds.length &&
    corpus.cases.every((evaluationCase) => {
      const observation = observations.find((candidate) => candidate.caseId === evaluationCase.id);
      return observation !== undefined && observationMatchesCase(evaluationCase, observation);
    })
  );
};

const retrievalObservationsMatchCorpus = (
  retrievalCases: ReadonlyArray<EvaluationRetrievalCase>,
  observations: ReadonlyArray<EvaluationRetrievalObservation>,
): boolean =>
  retrievalCases.length === observations.length &&
  new Set(observations.map(({ caseId }) => caseId)).size === observations.length &&
  retrievalCases.every((retrievalCase) => {
    const observation = observations.find(({ caseId }) => caseId === retrievalCase.id);
    return (
      observation !== undefined &&
      observation.category === retrievalCase.category &&
      observation.seam === retrievalCase.seam
    );
  });

const retrievalObservationSetPassed = (
  retrievalCases: ReadonlyArray<EvaluationRetrievalCase>,
  observations: ReadonlyArray<EvaluationRetrievalObservation>,
): boolean =>
  retrievalObservationsMatchCorpus(retrievalCases, observations) &&
  observations.every(({ passed }) => passed);

const baseEvaluationCaseId = (caseId: string): string =>
  /^(.*):iteration-[1-9][0-9]*$/.exec(caseId)?.[1] ?? caseId;

const positiveControlObservationSetPassed = (
  observations: ReadonlyArray<EvaluationObservation>,
): boolean => {
  const positiveControlIds = new Set<string>(evaluationPositiveControlCaseIds);
  const controls = observations.filter((observation) =>
    positiveControlIds.has(baseEvaluationCaseId(observation.caseId)),
  );
  if (controls.length === 0) return false;

  const repeated = controls.some(
    (observation) => observation.caseId !== baseEvaluationCaseId(observation.caseId),
  );
  return evaluationPositiveControlCaseIds.every((caseId) => {
    const expectedCaseIds = repeated
      ? [1, 2, 3].map((iteration) => `${caseId}:iteration-${iteration}`)
      : [caseId];
    const repetitions = controls.filter(
      (observation) => baseEvaluationCaseId(observation.caseId) === caseId,
    );
    return (
      repetitions.length === expectedCaseIds.length &&
      expectedCaseIds.every((expectedCaseId) => {
        const observation = repetitions.find((candidate) => candidate.caseId === expectedCaseId);
        return (
          observation !== undefined &&
          observation.kind === "research" &&
          observation.expectedOutcome === "answered" &&
          observation.observedOutcome === "answered" &&
          observation.acceptedByPolicy
        );
      })
    );
  });
};

const sourceHashManifest = (
  observations: ReadonlyArray<EvaluationObservation>,
): Readonly<Record<string, ReadonlyArray<string>>> => {
  const hashes = new Map<string, Set<string>>();
  for (const observation of observations) {
    for (const { identifier, sourceHash } of observation.sourceProvenance) {
      const values = hashes.get(identifier) ?? new Set<string>();
      values.add(sourceHash);
      hashes.set(identifier, values);
    }
  }
  return Object.fromEntries(
    [...hashes.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([identifier, values]) => [identifier, [...values].sort()]),
  );
};

/**
 * Build a reproducible report from one committed corpus and its observations.
 *
 * @param corpus Versioned committed corpus.
 * @param observations One sanitized observation per semantic corpus case.
 * @param retrievalObservations One public-client result per retrieval corpus case.
 * @param options Model, policy, and gate settings.
 * @returns A schema-validated evaluation report.
 */
export const makeEvaluationReport = (
  corpus: EvaluationCorpus,
  observations: ReadonlyArray<EvaluationObservation>,
  retrievalObservations: ReadonlyArray<EvaluationRetrievalObservation>,
  options: EvaluationReportOptions | undefined = undefined,
): EvaluationReport => {
  const decodedCorpus = decodeEvaluationCorpus(corpus);
  const decodedObservations = observations.map((observation) =>
    Schema.decodeUnknownSync(EvaluationObservationSchema)(observation),
  );
  const decodedRetrievalObservations = retrievalObservations.map((observation) =>
    Schema.decodeUnknownSync(EvaluationRetrievalObservationSchema)(observation),
  );
  const corpusComplete =
    observationIdsMatchCorpus(decodedCorpus, decodedObservations) &&
    retrievalObservationsMatchCorpus(decodedCorpus.retrievalCases, decodedRetrievalObservations);
  const policy = resolveReportOptions(options);
  const authoritativeSourceHashes = sourceHashManifest(decodedObservations);
  if (
    options?.authoritativeSourceHashes !== undefined &&
    stableJson(options.authoritativeSourceHashes) !== stableJson(authoritativeSourceHashes)
  ) {
    throw new EvaluationInputError({
      reason: "Authoritative source manifest does not match observed RFC source provenance",
    });
  }
  const metrics = calculateEvaluationMetrics(decodedObservations);
  const gate = evaluateEvaluationGate(
    metrics,
    decodedObservations,
    decodedRetrievalObservations,
    corpusComplete,
    {
      ...policy,
      origin: undefined,
      releaseBuildId: undefined,
      corpusDigest: undefined,
      createdAt: undefined,
      expiresAt: undefined,
      authoritativeSourceHashes: undefined,
    },
  );
  const resolvedModels = unique(
    decodedObservations.map((observation) => observation.resolvedModel),
  );
  return Schema.decodeUnknownSync(EvaluationReportSchema)({
    schemaVersion: evaluationSchemaVersion,
    kind: "rfc_evaluation",
    origin: options?.origin ?? "deterministic",
    releaseBuildId: options?.releaseBuildId ?? "unattested",
    createdAt: options?.createdAt ?? "unattested",
    expiresAt: options?.expiresAt ?? "unattested",
    corpusDigest: options?.corpusDigest ?? sha256(decodedCorpus),
    policyDigest: sha256(policy),
    policy,
    authoritativeSourceHashes,
    corpusVersion: decodedCorpus.corpusVersion,
    policyVersion: policy.policyVersion,
    requestedModel: policy.requestedModel,
    resolvedModel: resolvedModels.length === 1 ? resolvedModels[0] : "mixed",
    pinnedModel: policy.pinnedModel,
    observations: decodedObservations,
    retrievalObservations: decodedRetrievalObservations,
    metrics,
    gate,
  });
};

/**
 * Run one evaluator for each case and calculate a sanitized report.
 *
 * Cases run sequentially so provider usage and latency observations remain
 * reproducible and the live evaluator does not create an unbounded burst.
 *
 * @param corpus Versioned evaluation corpus.
 * @param runner Operation that evaluates one semantic case with fake or live services.
 * @param retrievalRunner Operation that executes one deterministic retrieval case through the public client.
 * @param options Model, policy, and gate settings.
 * @returns A report containing no user prompts or provider reasoning.
 */
export const runEvaluation = async (
  corpus: EvaluationCorpus,
  runner: (evaluationCase: EvaluationCase) => Promise<EvaluationObservation>,
  retrievalRunner: (
    retrievalCase: EvaluationRetrievalCase,
  ) => Promise<EvaluationRetrievalObservation>,
  options: EvaluationReportOptions | undefined = undefined,
): Promise<EvaluationReport> => {
  const observations: Array<EvaluationObservation> = [];
  for (const evaluationCase of corpus.cases) {
    const result = await runner(evaluationCase);
    if (!observationMatchesCase(evaluationCase, result)) {
      throw new EvaluationInputError({
        reason: `Evaluation runner returned metadata for ${evaluationCase.id} that does not match the committed case`,
      });
    }
    observations.push(result);
  }
  const retrievalObservations: Array<EvaluationRetrievalObservation> = [];
  for (const retrievalCase of corpus.retrievalCases) {
    const result = Schema.decodeUnknownSync(EvaluationRetrievalObservationSchema)(
      await retrievalRunner(retrievalCase),
    );
    if (
      result.caseId !== retrievalCase.id ||
      result.category !== retrievalCase.category ||
      result.seam !== retrievalCase.seam
    ) {
      throw new EvaluationInputError({
        reason: `Retrieval runner returned metadata for ${retrievalCase.id} that does not match the committed case`,
      });
    }
    retrievalObservations.push(result);
  }
  return makeEvaluationReport(corpus, observations, retrievalObservations, options);
};

/**
 * Check whether a named finite probability map is a valid distribution.
 *
 * @param probabilities Candidate probability values.
 * @param labels Exact labels required in the distribution.
 * @returns True only when labels, bounds, and the unit sum are valid.
 */
export const isValidProbabilityDistribution = (
  probabilities: Readonly<Record<string, number>>,
  labels: ReadonlyArray<string>,
): boolean => {
  const keys = Object.keys(probabilities);
  if (keys.length !== labels.length || !labels.every((label) => keys.includes(label))) return false;
  const values = labels.map((label) => probabilities[label]);
  if (
    values.some((value) => value === undefined || !Number.isFinite(value) || value < 0 || value > 1)
  ) {
    return false;
  }
  return Math.abs(values.reduce((sum, value) => sum + (value ?? 0), 0) - 1) <= 1e-6;
};

/**
 * The research statuses expected in status-rate reports.
 */
export const evaluationResearchStatuses: ReadonlyArray<ResearchStatus> = [
  "answered",
  "partial",
  "unsupported",
  "needs_review",
  "needs_split",
];

/**
 * The citation verdicts expected in verdict-rate reports.
 */
export const evaluationCitationVerdicts: ReadonlyArray<CitationVerdict> = [
  "verified",
  "unsupported",
  "contradicted",
  "fabricated",
];
