/**
 * Durable human review decision for the exact precision-v2 live report.
 *
 * The human release owner approved recording this report as rejected. The
 * digest binds the full sanitized report, including its policy, provenance,
 * observations, timings, usage, and retrieval evidence.
 */
export const precisionV2HumanReviewDecision = Object.freeze({
  schemaVersion: 1,
  kind: "rfc_evaluation_human_review_decision",
  id: "precision-v2-2026-09-21-rejected",
  decision: "rejected",
  reviewAuthority: "human_user",
  reviewedAt: "2026-09-21T04:06:40.000Z",
  reportDigest: "3ce4d88e7ee0450562679342fc3f9e4a27b545ca5a2b0d0dbb9f8955efe400f1",
  releaseBuildId: "rfc-evidence-precision-v2",
  reportCreatedAt: "2026-09-21T03:47:47.612Z",
  reportExpiresAt: "2026-10-21T03:47:47.612Z",
  corpusVersion: "precision-v2",
  corpusDigest: "d3258be00acdc835ce70ea9fbf443b970c028a435919b570203f5eb04b2553a7",
  policyVersion: "precision-v2",
  policyDigest: "1b63732409f832170dc321985a4f958e1b29df24589fa3f32e834ba75ca9ac76",
  requestedModel: "jev-latest",
  resolvedModel: "jev-1.13.0",
  pinnedModel: "jev-1.13.0",
  gate: Object.freeze({
    passed: false,
    supportedClaimPrecision: 1,
    knownRfcP95LatencyMilliseconds: 3_534,
    topicP95LatencyMilliseconds: 719,
  }),
  failures: Object.freeze([
    "observed outcomes fell outside committed allowed outcome sets",
    "positive-control research cases did not remain answered",
    "warm-cache research p95 latency exceeded a configured gate",
  ]),
});
