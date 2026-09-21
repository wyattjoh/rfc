import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import {
  EvaluationObservationSchema,
  EvaluationReportSchema,
  calculateEvaluationMetrics,
  decodeEvaluationCorpus,
  evaluationAllowedOutcomeSets,
  evaluationCitationVerdicts,
  evaluationCorpus,
  evaluationCorpusDigest,
  evaluationPositiveControlCaseIds,
  evaluationPolicyDigest,
  evaluationReleaseAttestation,
  evaluationSchemaVersion,
  evaluationResearchStatuses,
  evaluateEvaluationGate,
  evaluationReportDigest,
  isAcceptedEvaluationReport,
  isAcceptedEvaluationReportForAttestation,
  isValidProbabilityDistribution,
  makeEvaluationReport,
  type EvaluationCase,
  type EvaluationObservation,
} from "../src/index";

const outcomeFor = (evaluationCase: EvaluationCase): string =>
  evaluationCase.kind === "research"
    ? (evaluationCase.expectedStatus ?? "needs_review")
    : (evaluationCase.expectedVerdict ?? "unsupported");

const makeObservation = (
  evaluationCase: EvaluationCase,
  observedOutcome: string = outcomeFor(evaluationCase),
  totalLatencyMs: number = evaluationCase.mode === "topic" ? 200 : 100,
  resolvedModel = "jev-1.13.0",
  acceptedByPolicy = observedOutcome === "answered" || observedOutcome === "verified",
): EvaluationObservation =>
  Schema.decodeUnknownSync(EvaluationObservationSchema)({
    schemaVersion: evaluationSchemaVersion,
    caseId: evaluationCase.id,
    category: evaluationCase.category,
    kind: evaluationCase.kind,
    mode: evaluationCase.mode,
    expectedOutcome: outcomeFor(evaluationCase),
    observedOutcome,
    allowedOutcomes: evaluationCase.allowedOutcomes,
    acceptedByPolicy,
    unsafeCitationAccepted:
      acceptedByPolicy &&
      (outcomeFor(evaluationCase) === "fabricated" ||
        outcomeFor(evaluationCase) === "contradicted"),
    sourceHashes: ["a".repeat(64)],
    requestedModel: "jev-latest",
    resolvedModel,
    resolvedModels: [resolvedModel],
    policyVersion: "precision-v2",
    usage: { inputTokens: 10, outputTokens: 4 },
    timings: {
      metadataMs: 1,
      documentMs: evaluationCase.mode === "topic" ? 2 : null,
      sourceMs: 3,
      lexicalMs: 4,
      selectionMs: 5,
      relationMs: 6,
      verificationMs: evaluationCase.kind === "citation" ? 7 : null,
      totalMs: totalLatencyMs,
    },
    totalLatencyMs,
    probabilities:
      evaluationCase.kind === "research" && observedOutcome === "answered"
        ? {
            accepted: 0.99,
            "selection.fixture.probability": 0.99,
            "classification.fixture.direct_answer": 0.99,
          }
        : { accepted: acceptedByPolicy ? 0.99 : 0.01 },
    confidence: acceptedByPolicy ? 0.99 : 0.5,
    errorKind: null,
  });

const corpusObservations = (): ReadonlyArray<EvaluationObservation> =>
  evaluationCorpus.cases.map((evaluationCase) => makeObservation(evaluationCase));

const liveEvaluationCorpus = {
  ...evaluationCorpus,
  cases: evaluationCorpus.cases.flatMap((evaluationCase) =>
    Array.from({ length: 3 }, (_, index) => ({
      ...evaluationCase,
      id: `${evaluationCase.id}:iteration-${index + 1}`,
    })),
  ),
};

const liveCorpusObservations = (): ReadonlyArray<EvaluationObservation> =>
  liveEvaluationCorpus.cases.map((evaluationCase) => makeObservation(evaluationCase));

const reviewedReleaseReportPath = join(
  import.meta.dir,
  "../../../.scratch/rfc-evaluation-report.json",
);

const acceptedFixtureReport = () => {
  const authoritativeSourceHashes = Object.fromEntries(
    [...new Set(liveEvaluationCorpus.cases.flatMap(({ rfc }) => (rfc === null ? [] : [rfc])))].map(
      (rfc) => [rfc, ["a".repeat(64)]],
    ),
  );
  const report = makeEvaluationReport(liveEvaluationCorpus, liveCorpusObservations(), {
    origin: "live",
    releaseBuildId: "rfc-evidence-precision-v4",
    corpusDigest: evaluationCorpusDigest,
    createdAt: "2026-01-01T00:00:00.000Z",
    expiresAt: "2026-02-01T00:00:00.000Z",
    authoritativeSourceHashes,
    policyVersion: "precision-v2",
    requestedModel: "jev-latest",
    pinnedModel: "jev-1.13.0",
    minimumSupportedClaimPrecision: undefined,
    maxKnownRfcP95LatencyMilliseconds: undefined,
    maxTopicP95LatencyMilliseconds: undefined,
  });
  return {
    report,
    attestation: {
      status: "accepted" as const,
      buildId: report.releaseBuildId,
      reportDigest: evaluationReportDigest(report),
      corpusDigest: report.corpusDigest,
      policyDigest: report.policyDigest,
      authoritativeSourceHashes: report.authoritativeSourceHashes,
      expiresAt: report.expiresAt,
    },
  };
};

describe("precision evaluation", () => {
  test("commits coverage for every required corpus category", () => {
    const categories = new Set(
      evaluationCorpus.cases.map((evaluationCase) => evaluationCase.category),
    );
    expect(evaluationCorpus.cases.length).toBeGreaterThanOrEqual(16);
    for (const category of [
      "normative_requirement",
      "definition",
      "procedure",
      "tls_protocol",
      "oauth_definition",
      "dns_definition",
      "negative_answer",
      "topic_discovery",
      "obsolete_document",
      "updated_document",
      "partial_answer",
      "compound_question",
      "duplicate_quotation",
      "supported_background_quotation",
      "supported_normative_quotation",
      "fabricated_quotation",
      "unsupported_claim",
      "contradicted_claim",
    ]) {
      expect(categories.has(category)).toBe(true);
    }
  });

  test("recertifies stable research mismatches as fail-closed outcomes", () => {
    const expectedStatuses = new Map<string, EvaluationCase["expectedStatus"]>([
      ["older-definition", "needs_review"],
      ["procedure", "needs_review"],
      ["tls-handshake", "needs_review"],
      ["oauth-grant", "needs_review"],
      ["dns-resolver", "needs_review"],
      ["negative-answer", "needs_review"],
      ["topic-discovery", "needs_review"],
      ["obsolete-document", "needs_review"],
      ["updated-document", "needs_review"],
      ["partial-answer", "needs_review"],
    ]);
    const stableMismatchRepetitionCounts = new Map([
      ["older-definition", 3],
      ["procedure", 3],
      ["tls-handshake", 3],
      ["oauth-grant", 3],
      ["dns-resolver", 3],
      ["negative-answer", 1],
      ["topic-discovery", 3],
      ["updated-document", 1],
      ["partial-answer", 3],
    ]);
    expect(
      [...stableMismatchRepetitionCounts.values()].reduce((sum, count) => sum + count, 0),
    ).toBe(23);
    for (const [caseId, expectedStatus] of expectedStatuses) {
      const evaluationCase = evaluationCorpus.cases.find((candidate) => candidate.id === caseId);
      expect(evaluationCase?.expectedStatus).toBe(expectedStatus);
      expect(evaluationCase?.expectedOutcomeRationale).toMatch(/.+/);
    }
    for (const caseId of evaluationPositiveControlCaseIds) {
      const evaluationCase = evaluationCorpus.cases.find((candidate) => candidate.id === caseId);
      expect(evaluationCase?.kind).toBe("research");
      expect(evaluationCase?.expectedStatus).toBe("answered");
      expect(evaluationCase?.expectedOutcomeRationale).toMatch(/positive control/i);
    }
  });

  test("accepts only bounded safe alternatives and keeps automatic outcomes accepted", () => {
    expect(evaluationAllowedOutcomeSets).toEqual({
      "negative-answer": ["needs_review", "unsupported"],
      "updated-document": ["needs_review", "partial"],
      "partial-answer": ["needs_review", "answered"],
      "topic-discovery": ["needs_review", "answered"],
    });

    const observations = corpusObservations().map((observation) => {
      if (observation.caseId === "negative-answer") {
        return { ...observation, observedOutcome: "unsupported" };
      }
      if (observation.caseId === "updated-document") {
        return { ...observation, observedOutcome: "partial" };
      }
      if (observation.caseId === "partial-answer") {
        return {
          ...observation,
          observedOutcome: "answered",
          acceptedByPolicy: true,
          probabilities: {
            accepted: 0.99,
            "selection.fixture.probability": 0.99,
            "classification.fixture.direct_answer": 0.99,
          },
        };
      }
      return observation;
    });
    const report = makeEvaluationReport(evaluationCorpus, observations);
    expect(report.gate.expectedOutcomePassed).toBe(true);
    expect(report.gate.passed).toBe(true);

    const unsafeAutomaticOutcome = observations.map((observation) =>
      observation.caseId === "partial-answer"
        ? { ...observation, acceptedByPolicy: false }
        : observation,
    );
    expect(
      evaluateEvaluationGate(
        calculateEvaluationMetrics(unsafeAutomaticOutcome),
        unsafeAutomaticOutcome,
      ).expectedOutcomePassed,
    ).toBe(false);

    const incompleteAutomaticEvidence = observations.map((observation) =>
      observation.caseId === "partial-answer"
        ? { ...observation, probabilities: { accepted: 0.99 } }
        : observation,
    );
    expect(
      evaluateEvaluationGate(
        calculateEvaluationMetrics(incompleteAutomaticEvidence),
        incompleteAutomaticEvidence,
      ).expectedOutcomePassed,
    ).toBe(false);

    const vacuouslyWidened = {
      ...evaluationCorpus,
      cases: evaluationCorpus.cases.map((evaluationCase) =>
        evaluationCase.id === "negative-answer"
          ? { ...evaluationCase, allowedOutcomes: ["needs_review", "unsupported", "answered"] }
          : evaluationCase,
      ),
    };
    expect(() => decodeEvaluationCorpus(vacuouslyWidened)).toThrow(
      "has an uncommitted outcome policy",
    );

    const citationOutcomeDrift = corpusObservations().map((observation) =>
      observation.caseId === "duplicate-quotation"
        ? { ...observation, observedOutcome: "unsupported" }
        : observation,
    );
    expect(
      evaluateEvaluationGate(calculateEvaluationMetrics(citationOutcomeDrift), citationOutcomeDrift)
        .expectedOutcomePassed,
    ).toBe(false);
  });

  test("requires a confident document, passage, and direct relation for topic answers", () => {
    const topicCase = evaluationCorpus.cases.find(
      (evaluationCase) => evaluationCase.id === "topic-discovery",
    );
    if (topicCase === undefined) throw new Error("Missing topic-discovery case");

    const topicAnswer = makeObservation(topicCase, "answered", 100, "jev-1.13.0", true);
    const fullySupportedTopicAnswer = {
      ...topicAnswer,
      probabilities: {
        "document.RFC4130.probability": 0.35,
        "selection.RFC4130:block-86.probability": 0.9,
        "classification.RFC4130:block-86.direct_answer": 0.73,
      },
    };
    const observations = corpusObservations().map((observation) =>
      observation.caseId === topicCase.id ? fullySupportedTopicAnswer : observation,
    );
    expect(
      evaluateEvaluationGate(calculateEvaluationMetrics(observations), observations).passed,
    ).toBe(true);

    const lowConfidenceDocument = {
      ...fullySupportedTopicAnswer,
      probabilities: {
        "document.RFC4130.probability": 0.34,
        "selection.RFC4130:block-86.probability": 0.9,
        "classification.RFC4130:block-86.direct_answer": 0.73,
      },
    };
    const lowConfidenceObservations = observations.map((observation) =>
      observation.caseId === topicCase.id ? lowConfidenceDocument : observation,
    );
    expect(
      evaluateEvaluationGate(
        calculateEvaluationMetrics(lowConfidenceObservations),
        lowConfidenceObservations,
      ).expectedOutcomePassed,
    ).toBe(false);

    const documentOnly = {
      ...fullySupportedTopicAnswer,
      probabilities: { "document.RFC4130.probability": 0.9 },
    };
    const documentOnlyObservations = observations.map((observation) =>
      observation.caseId === topicCase.id ? documentOnly : observation,
    );
    expect(
      evaluateEvaluationGate(
        calculateEvaluationMetrics(documentOnlyObservations),
        documentOnlyObservations,
      ).expectedOutcomePassed,
    ).toBe(false);
  });

  test("keeps calibrated corpus inputs atomic and preserves qualified duplicate evidence", () => {
    const partial = evaluationCorpus.cases.find(
      (evaluationCase) => evaluationCase.id === "partial-answer",
    );
    const compound = evaluationCorpus.cases.find(
      (evaluationCase) => evaluationCase.id === "compound-question",
    );
    const duplicate = evaluationCorpus.cases.find(
      (evaluationCase) => evaluationCase.id === "duplicate-quotation",
    );
    expect(partial?.question).toBe("What does RFC9110 say about server caching?");
    expect(partial?.question).not.toBe(compound?.question);
    expect(duplicate?.expectedVerdict).toBe("verified");
    expect(duplicate?.quote).toContain("containing a preferred URI reference");
    expect(duplicate?.claim).toContain("containing a preferred URI reference");
  });

  test("runs a deterministic report and round-trips it through its schema", () => {
    const observations = corpusObservations();
    const report = makeEvaluationReport(evaluationCorpus, observations);

    expect(report.gate.passed).toBe(true);
    expect(report.metrics.supportedClaimPrecision).toBe(1);
    expect(report.metrics.supportedClaimCoverage).toBe(1);
    expect(report.metrics.statusRates.needs_split).toBeGreaterThan(0);
    expect(report.metrics.verdictRates.fabricated).toBeGreaterThan(0);
    expect(
      Schema.decodeUnknownSync(EvaluationReportSchema)(JSON.parse(JSON.stringify(report))),
    ).toEqual(report);
  });

  test("requires positive-control research cases to stay answered across live repetitions", () => {
    const observations = liveCorpusObservations();
    const gate = evaluateEvaluationGate(calculateEvaluationMetrics(observations), observations);

    expect(gate.positiveControlPassed).toBe(true);
    expect(gate.passed).toBe(true);

    const demotedPositiveControls = observations.map((observation) =>
      evaluationPositiveControlCaseIds.some((caseId) => observation.caseId.startsWith(`${caseId}:`))
        ? {
            ...observation,
            expectedOutcome: "needs_review",
            observedOutcome: "needs_review",
            acceptedByPolicy: false,
          }
        : observation,
    );
    const demotedGate = evaluateEvaluationGate(
      calculateEvaluationMetrics(demotedPositiveControls),
      demotedPositiveControls,
    );
    expect(demotedGate.positiveControlPassed).toBe(false);
    expect(demotedGate.failures).toContain(
      "positive-control research cases did not remain answered",
    );
    expect(demotedGate.passed).toBe(false);

    const allResearchReviewCorpus = {
      ...evaluationCorpus,
      cases: evaluationCorpus.cases.map((evaluationCase) =>
        evaluationCase.kind === "research"
          ? {
              ...evaluationCase,
              expectedStatus: "needs_review" as const,
              allowedOutcomes:
                evaluationCase.expectedStatus === "needs_split" ||
                evaluationCase.expectedStatus === "answered"
                  ? ["needs_review"]
                  : evaluationCase.allowedOutcomes,
            }
          : evaluationCase,
      ),
    };
    const allResearchReviewReport = makeEvaluationReport(
      allResearchReviewCorpus,
      allResearchReviewCorpus.cases.map((evaluationCase) => makeObservation(evaluationCase)),
    );
    expect(allResearchReviewReport.gate.expectedOutcomePassed).toBe(true);
    expect(allResearchReviewReport.gate.positiveControlPassed).toBe(false);
    expect(allResearchReviewReport.gate.passed).toBe(false);
  });

  test("rejects observations whose expected metadata drifts from the corpus", () => {
    const observations = corpusObservations().map((observation) =>
      observation.caseId === "negative-answer"
        ? { ...observation, expectedOutcome: "answered" as const }
        : observation,
    );
    const report = makeEvaluationReport(evaluationCorpus, observations);

    expect(report.gate.corpusComplete).toBe(false);
    expect(report.gate.expectedOutcomePassed).toBe(false);
    expect(report.gate.passed).toBe(false);
  });

  test("reports status and verdict rates separately from supported precision", () => {
    const observations = corpusObservations();
    const metrics = calculateEvaluationMetrics(observations);

    expect(metrics.researchCases).toBeGreaterThan(0);
    expect(metrics.citationCases).toBeGreaterThan(0);
    expect(metrics.statusRates.answered).toBeGreaterThan(0);
    expect(metrics.statusRates.partial).toBe(0);
    expect(metrics.statusRates.unsupported).toBe(0);
    expect(metrics.statusRates.needs_review).toBeGreaterThan(0);
    expect(metrics.statusRates.needs_split).toBeGreaterThan(0);
    expect(metrics.researchAnswerRate).toBe(metrics.statusRates.answered);
    expect(metrics.researchAnswerRate).toBeGreaterThan(0);
    expect(metrics.verdictRates.verified).toBeGreaterThan(0);
    expect(metrics.verdictRates.unsupported).toBeGreaterThan(0);
    expect(metrics.verdictRates.contradicted).toBeGreaterThan(0);
    expect(metrics.verdictRates.fabricated).toBeGreaterThan(0);
  });

  test("accepts exactly the 98 percent precision boundary", () => {
    const supported = evaluationCorpus.cases.find(
      (evaluationCase) => evaluationCase.id === "duplicate-quotation",
    );
    const unsupported = evaluationCorpus.cases.find(
      (evaluationCase) => evaluationCase.id === "unsupported-claim",
    );
    if (supported === undefined || unsupported === undefined)
      throw new Error("Missing citation case");

    const observations = [
      ...Array.from({ length: 49 }, () => makeObservation(supported)),
      makeObservation(unsupported, "verified", 100, "jev-1.13.0", true),
      ...evaluationCorpus.cases
        .filter(
          (evaluationCase) =>
            evaluationCase.id !== supported.id && evaluationCase.id !== unsupported.id,
        )
        .map((evaluationCase) =>
          makeObservation(evaluationCase, undefined, 100, "jev-1.13.0", false),
        ),
    ];
    const metrics = calculateEvaluationMetrics(observations);
    const gate = evaluateEvaluationGate(metrics, observations);

    expect(metrics.supportedClaimPrecision).toBe(0.98);
    expect(gate.precisionPassed).toBe(true);
  });

  test("rejects unsafe citation acceptance and precision below the gate", () => {
    const observations = corpusObservations().map((observation) =>
      observation.caseId === "contradicted-claim"
        ? {
            ...observation,
            observedOutcome: "verified",
            acceptedByPolicy: true,
            unsafeCitationAccepted: true,
          }
        : observation,
    );
    const metrics = calculateEvaluationMetrics(observations);
    const gate = evaluateEvaluationGate(metrics, observations);

    expect(metrics.unsafeCitationAcceptances).toBe(1);
    expect(gate.citationSafetyPassed).toBe(false);
    expect(gate.passed).toBe(false);
    expect(gate.failures).toContain("a fabricated or contradicted citation was accepted");
  });

  test("rejects a model drift and p95 sample at either strict latency limit", () => {
    const observations = corpusObservations().map((observation) =>
      observation.mode === "known_rfc" && observation.kind === "research"
        ? {
            ...observation,
            totalLatencyMs: 2_000,
            timings: { ...observation.timings, totalMs: 2_000 },
          }
        : observation.mode === "topic" && observation.kind === "research"
          ? {
              ...observation,
              totalLatencyMs: 3_000,
              timings: { ...observation.timings, totalMs: 3_000 },
            }
          : observation,
    );
    const metrics = calculateEvaluationMetrics(observations);
    const gate = evaluateEvaluationGate(metrics, observations);

    expect(metrics.knownRfcP95LatencyMs).toBe(2_000);
    expect(metrics.topicP95LatencyMs).toBe(3_000);
    expect(gate.latencyPassed).toBe(false);

    const drifted = observations.map((observation) => ({
      ...observation,
      resolvedModel: "jev-next",
    }));
    const driftedGate = evaluateEvaluationGate(calculateEvaluationMetrics(drifted), drifted);
    expect(driftedGate.modelPinPassed).toBe(false);
    expect(driftedGate.passed).toBe(false);
  });

  test("rejects an observation when any provider stage resolves to a different model", () => {
    const observations = corpusObservations().map((observation) =>
      observation.kind === "research"
        ? {
            ...observation,
            resolvedModel: "mixed",
            resolvedModels: ["jev-1.13.0", "jev-next"],
          }
        : observation,
    );
    const gate = evaluateEvaluationGate(calculateEvaluationMetrics(observations), observations);

    expect(gate.modelPinPassed).toBe(false);
    expect(gate.passed).toBe(false);
  });

  test("does not require a provider pin for deterministic fabricated citations", () => {
    const observations = corpusObservations().map((observation) =>
      observation.caseId === "fabricated-quotation"
        ? {
            ...observation,
            resolvedModel: "jev-latest",
            resolvedModels: [],
            usage: { inputTokens: null, outputTokens: null },
          }
        : observation,
    );
    const gate = evaluateEvaluationGate(calculateEvaluationMetrics(observations), observations);

    expect(gate.modelPinPassed).toBe(true);
  });

  test("keeps calibration activation closed for an unattested report", () => {
    const deterministicReport = makeEvaluationReport(evaluationCorpus, corpusObservations());
    const report = makeEvaluationReport(liveEvaluationCorpus, liveCorpusObservations(), {
      origin: "live",
      releaseBuildId: "rfc-evidence-precision-v4",
      corpusDigest: "pending",
      createdAt: "2026-01-01T00:00:00.000Z",
      expiresAt: "2026-02-01T00:00:00.000Z",
      authoritativeSourceHashes: {},
      policyVersion: "precision-v2",
      requestedModel: "jev-latest",
      pinnedModel: "jev-1.13.0",
      minimumSupportedClaimPrecision: undefined,
      maxKnownRfcP95LatencyMilliseconds: undefined,
      maxTopicP95LatencyMilliseconds: undefined,
    });

    expect(isAcceptedEvaluationReport(deterministicReport)).toBe(false);
    expect(isAcceptedEvaluationReport(report)).toBe(false);
    expect(
      isAcceptedEvaluationReport({
        ...report,
        gate: { ...report.gate, passed: false },
      }),
    ).toBe(false);
    expect(
      isAcceptedEvaluationReport({
        ...report,
        policyVersion: "precision-v1",
      }),
    ).toBe(false);
    expect(
      isAcceptedEvaluationReport({
        ...report,
        observations: report.observations.slice(0, 1),
      }),
    ).toBe(false);
    expect(
      isAcceptedEvaluationReport({
        ...report,
        observations: report.observations.map((observation, index) =>
          index === 0 ? { ...observation, category: "substituted" } : observation,
        ),
      }),
    ).toBe(false);
    expect(
      isAcceptedEvaluationReport({
        ...report,
        metrics: { ...report.metrics, knownRfcP95LatencyMs: 0 },
      }),
    ).toBe(false);
  });

  test("keeps the precision-v2 release attestation pending", () => {
    expect(evaluationReleaseAttestation).toEqual({
      status: "pending_live_calibration",
      buildId: "rfc-evidence-precision-v2",
      reportDigest: null,
      corpusDigest: evaluationCorpusDigest,
      policyDigest: evaluationPolicyDigest,
      authoritativeSourceHashes: {},
      expiresAt: null,
    });
  });

  test("does not activate a pending attestation with a stable release identity", () => {
    const { report, attestation } = acceptedFixtureReport();

    expect(evaluationReleaseAttestation).toMatchObject({
      status: "pending_live_calibration",
      buildId: "rfc-evidence-precision-v2",
      reportDigest: null,
      expiresAt: null,
    });
    expect(
      isAcceptedEvaluationReportForAttestation(
        report,
        { ...attestation, status: "pending_live_calibration" as const },
        Date.parse("2026-01-15T00:00:00.000Z"),
      ),
    ).toBe(false);
  });

  test("rejects expired, tampered, mismatched, and mixed-model attested reports", () => {
    const { report, attestation } = acceptedFixtureReport();
    const now = Date.parse("2026-01-15T00:00:00.000Z");

    expect(isAcceptedEvaluationReport(report)).toBe(false);
    expect(isAcceptedEvaluationReportForAttestation(report, attestation, now)).toBe(true);
    expect(
      isAcceptedEvaluationReportForAttestation(
        report,
        { ...attestation, status: "pending_live_calibration" },
        now,
      ),
    ).toBe(false);
    expect(
      isAcceptedEvaluationReportForAttestation(
        report,
        { ...attestation, reportDigest: "0".repeat(64) },
        now,
      ),
    ).toBe(false);
    expect(
      isAcceptedEvaluationReportForAttestation(
        { ...report, releaseBuildId: "rfc-evidence-precision-v3" },
        attestation,
        now,
      ),
    ).toBe(false);
    expect(
      isAcceptedEvaluationReportForAttestation(
        { ...report, corpusDigest: "0".repeat(64) },
        attestation,
        now,
      ),
    ).toBe(false);
    expect(
      isAcceptedEvaluationReportForAttestation(
        { ...report, policyDigest: "0".repeat(64) },
        attestation,
        now,
      ),
    ).toBe(false);
    expect(
      isAcceptedEvaluationReportForAttestation(
        { ...report, expiresAt: "2026-02-02T00:00:00.000Z" },
        attestation,
        now,
      ),
    ).toBe(false);
    expect(
      isAcceptedEvaluationReportForAttestation(
        {
          ...report,
          authoritativeSourceHashes: {
            ...report.authoritativeSourceHashes,
            RFC9110: ["b".repeat(64)],
          },
        },
        attestation,
        now,
      ),
    ).toBe(false);
    expect(
      isAcceptedEvaluationReportForAttestation(
        report,
        {
          ...attestation,
          authoritativeSourceHashes: {
            ...attestation.authoritativeSourceHashes,
            RFC9110: ["b".repeat(64)],
          },
        },
        now,
      ),
    ).toBe(false);
    expect(
      isAcceptedEvaluationReportForAttestation(
        report,
        attestation,
        Date.parse("2026-02-02T00:00:00.000Z"),
      ),
    ).toBe(false);
    expect(
      isAcceptedEvaluationReportForAttestation(
        { ...report, metrics: { ...report.metrics, knownRfcP95LatencyMs: 1 } },
        attestation,
        now,
      ),
    ).toBe(false);
    expect(
      isAcceptedEvaluationReportForAttestation(
        { ...report, requestedModel: "jev-next" },
        attestation,
        now,
      ),
    ).toBe(false);
    expect(
      isAcceptedEvaluationReportForAttestation(
        { ...report, observations: report.observations.slice(0, 1) },
        attestation,
        now,
      ),
    ).toBe(false);
    const mixedModelReport = {
      ...report,
      observations: report.observations.map((observation, index) =>
        index === 0
          ? {
              ...observation,
              resolvedModel: "mixed",
              resolvedModels: ["jev-1.13.0", "jev-next"],
            }
          : observation,
      ),
    };
    expect(
      isAcceptedEvaluationReportForAttestation(
        mixedModelReport,
        { ...attestation, reportDigest: evaluationReportDigest(mixedModelReport) },
        now,
      ),
    ).toBe(false);
  });

  test("accepts only complete finite probability distributions", () => {
    expect(isValidProbabilityDistribution({ yes: 0.8, no: 0.2 }, ["yes", "no"])).toBe(true);
    expect(isValidProbabilityDistribution({ yes: 0.8, no: 0.3 }, ["yes", "no"])).toBe(false);
    expect(isValidProbabilityDistribution({ yes: 1 }, ["yes", "no"])).toBe(false);
    expect(isValidProbabilityDistribution({ yes: Number.NaN, no: 0 }, ["yes", "no"])).toBe(false);
  });

  test("keeps the public status and verdict label sets explicit", () => {
    expect(evaluationResearchStatuses).toEqual([
      "answered",
      "partial",
      "unsupported",
      "needs_review",
      "needs_split",
    ]);
    expect(evaluationCitationVerdicts).toEqual([
      "verified",
      "unsupported",
      "contradicted",
      "fabricated",
    ]);
  });

  // The coordinator report remains ignored; validate it when present in a release workspace.
  if (existsSync(reviewedReleaseReportPath)) {
    test("accepts the exact coordinator-reviewed report", async () => {
      const report = await Bun.file(reviewedReleaseReportPath).json();
      expect(isAcceptedEvaluationReport(report)).toBe(true);
      expect(evaluationReportDigest(report)).toBe(
        evaluationReleaseAttestation.reportDigest ?? "missing report digest",
      );
    });
  }
});
