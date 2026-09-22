/**
 * Durable human review decision for the exact precision-v2 live report.
 *
 * The human release owner approved recording this report as accepted. The
 * digest binds the full sanitized report, including its policy, provenance,
 * observations, timings, usage, and retrieval evidence. Acceptance only
 * permits activation; automatic answers still require the explicit opt-in and
 * the exact local report artifact.
 */
export const precisionV2HumanReviewDecision = Object.freeze({
  schemaVersion: 1,
  kind: "rfc_evaluation_human_review_decision",
  id: "precision-v2-2026-09-22-accepted",
  decision: "accepted",
  reviewAuthority: "human_user",
  reviewedAt: "2026-09-22T18:23:53.000Z",
  reportDigest: "92f85fc57d77031daadbcc0a413da350d419b671fbe078d16889b646670217dc",
  releaseBuildId: "rfc-evidence-precision-v2",
  reportCreatedAt: "2026-09-22T17:51:35.804Z",
  reportExpiresAt: "2026-10-22T17:51:35.804Z",
  corpusVersion: "precision-v2",
  corpusDigest: "eab520e98b1fff1b4f53cf3648519b0e94d6f1d7b62fad7f276a7036815bff25",
  policyVersion: "precision-v2",
  policyDigest: "b710adaed23d01860f57ad2b1fb122234d5537556b691b9cf35e5ef45668a686",
  requestedModel: "jev-latest",
  resolvedModel: "jev-1.13.0",
  pinnedModel: "jev-1.13.0",
  gate: Object.freeze({
    passed: true,
    supportedClaimPrecision: 1,
    knownRfcP95LatencyMilliseconds: 1_339,
    topicP95LatencyMilliseconds: 975,
  }),
  failures: Object.freeze([]),
});
