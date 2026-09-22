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
  id: "precision-v2-2026-09-22-rejected",
  decision: "rejected",
  reviewAuthority: "human_user",
  reviewedAt: "2026-09-22T17:34:58.000Z",
  reportDigest: "7449476b00ebc7967042a51a152a64e442a6c29f9f11f8269139e72889ac2c86",
  releaseBuildId: "rfc-evidence-precision-v2",
  reportCreatedAt: "2026-09-22T17:17:42.509Z",
  reportExpiresAt: "2026-10-22T17:17:42.509Z",
  corpusVersion: "precision-v2",
  corpusDigest: "d3258be00acdc835ce70ea9fbf443b970c028a435919b570203f5eb04b2553a7",
  policyVersion: "precision-v2",
  policyDigest: "3c54f3d96df97895ada527cd0581c5bd7d07176d892a8c2688dc74ac5fec6b9d",
  requestedModel: "jev-latest",
  resolvedModel: "jev-1.13.0",
  pinnedModel: "jev-1.13.0",
  gate: Object.freeze({
    passed: false,
    supportedClaimPrecision: 1,
    knownRfcP95LatencyMilliseconds: 1_189,
    topicP95LatencyMilliseconds: 455,
  }),
  failures: Object.freeze([
    "observed outcomes fell outside committed allowed outcome sets",
    "positive-control research cases did not remain answered",
  ]),
});
