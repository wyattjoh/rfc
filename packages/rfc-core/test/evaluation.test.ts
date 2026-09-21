import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import { precisionV2HumanReviewDecision } from "../src/precision-v2-release-decision";
import {
  EvaluationObservationSchema,
  EvaluationReportSchema,
  calculateEvaluationMetrics,
  decodeEvaluationCorpus,
  evaluationAllowedOutcomeSets,
  evaluationCitationVerdicts,
  evaluationCorpus,
  evaluationCorpusDigest,
  evaluationCorpusVersion,
  evaluationPolicy,
  evaluationPositiveControlCaseIds,
  evaluationPolicyDigest,
  evaluationReleaseAttestation,
  evaluationSchemaVersion,
  evaluationResearchStatuses,
  evaluateEvaluationGate as evaluateGateWithRetrieval,
  evaluationReportDigest,
  isAcceptedEvaluationReport,
  isAcceptedEvaluationReportForAttestation,
  isValidProbabilityDistribution,
  makeEvaluationReport,
  observationFromEvidenceBundle,
  type EvaluationCase,
  type EvaluationObservation,
  type EvaluationRetrievalCase,
  type EvaluationRetrievalObservation,
  type EvidenceBundle,
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
    sourceProvenance: [{ identifier: evaluationCase.rfc ?? "RFC9110", sourceHash: "a".repeat(64) }],
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
    retrieval: {
      schemaVersion: 2,
      requestCount:
        evaluationCase.kind === "research" && evaluationCase.mode === "known_rfc" ? 3 : 2,
      datatrackerRequestCount:
        evaluationCase.kind === "research" && evaluationCase.mode === "known_rfc" ? 2 : 1,
      sourceRequestCount: 1,
      metadataMs: 1,
      sourceMs: 3,
      sourceCacheOutcome: "miss",
      ...(evaluationCase.mode === "topic"
        ? {
            upstreamRows: 2,
            uniqueCandidates: 2,
            mergeLimit: 32,
            semanticCandidates: 2,
            selectedSources: 1,
            topicTruncated: false,
          }
        : {}),
      ...(evaluationCase.kind === "research" && evaluationCase.mode === "known_rfc"
        ? {
            traversalComplete: true,
            traversalContexts: 1,
            traversalDepth: 0,
            successorRows: 0,
            boundedExits: [],
            contextLimit: 8,
            depthLimit: 16,
            relationshipLimit: 64,
          }
        : {}),
      requests: [
        {
          kind: "metadata",
          url: "https://datatracker.ietf.org/api/v1/doc/document/rfc9110/",
          attempts: 1,
          status: 200,
          statuses: [200],
          durationMs: 1,
        },
        ...(evaluationCase.kind === "research" && evaluationCase.mode === "known_rfc"
          ? [
              {
                kind: "relationships" as const,
                url: "https://datatracker.ietf.org/api/v1/doc/relateddocument/?target=rfc9110",
                attempts: 1,
                status: 200,
                statuses: [200],
                durationMs: 1,
              },
            ]
          : []),
        {
          kind: "source",
          url: "https://www.rfc-editor.org/rfc/rfc9110.txt",
          attempts: 1,
          status: 200,
          statuses: [200],
          durationMs: 3,
        },
      ],
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

const makeRetrievalObservation = (
  retrievalCase: EvaluationRetrievalCase,
  passed = true,
): EvaluationRetrievalObservation => {
  const topicCase = evaluationCorpus.cases.find(({ mode }) => mode === "topic");
  const knownCase = evaluationCorpus.cases.find(
    ({ kind, mode }) => kind === "research" && mode === "known_rfc",
  );
  const sourceCase =
    retrievalCase.category === "ordered_topic_terms" ||
    retrievalCase.category === "candidate_fan_out" ||
    retrievalCase.category === "no_candidate_outcome"
      ? topicCase
      : knownCase;
  const trace = sourceCase === undefined ? null : makeObservation(sourceCase).retrieval;
  const cacheOutcomes: Partial<
    Record<
      EvaluationRetrievalCase["category"],
      "miss" | "hit" | "revalidated" | "replaced" | "repaired"
    >
  > = {
    source_cache_miss: "miss",
    source_cache_hit: "hit",
    source_cache_revalidated: "revalidated",
    source_cache_replaced: "replaced",
    source_cache_repaired: "repaired",
  };
  const cacheOutcome = cacheOutcomes[retrievalCase.category];
  const metadataFailure = retrievalCase.category === "fail_closed_metadata";
  const revalidationFailure = retrievalCase.category === "fail_closed_revalidation";
  const requestCopies = (kind: "metadata" | "relationships" | "source", count: number) => {
    const request = trace?.requests.find((candidate) => candidate.kind === kind);
    if (request === undefined) return [];
    return Array.from({ length: count }, (_, index) => ({
      ...request,
      url: `${request.url}${request.url.includes("?") ? "&" : "?"}fixture=${index}`,
    }));
  };
  const scenarioTrace = (() => {
    if (trace === null) return null;
    if (retrievalCase.category === "update_chain" || retrievalCase.category === "cycle_safety") {
      const requests = [
        ...requestCopies("metadata", 2),
        ...requestCopies("relationships", 2),
        ...requestCopies("source", 1),
      ];
      return {
        ...trace,
        requestCount: requests.length,
        datatrackerRequestCount: 4,
        sourceRequestCount: 1,
        traversalContexts: 2,
        traversalDepth: 1,
        successorRows: retrievalCase.category === "cycle_safety" ? 2 : 1,
        requests,
      };
    }
    if (
      retrievalCase.category === "ordered_topic_terms" ||
      retrievalCase.category === "candidate_fan_out"
    ) {
      const datatrackerRequestCount = retrievalCase.category === "candidate_fan_out" ? 8 : 4;
      const sourceRequestCount = retrievalCase.category === "candidate_fan_out" ? 8 : 1;
      const requests = [
        ...requestCopies("metadata", datatrackerRequestCount),
        ...requestCopies("source", sourceRequestCount),
      ];
      return {
        ...trace,
        requestCount: requests.length,
        datatrackerRequestCount,
        sourceRequestCount,
        ...(retrievalCase.category === "candidate_fan_out"
          ? { uniqueCandidates: 40, semanticCandidates: 32, selectedSources: 8 }
          : {}),
        requests,
      };
    }
    if (retrievalCase.category === "no_candidate_outcome") {
      const requests = requestCopies("metadata", 2);
      return {
        ...trace,
        requestCount: requests.length,
        datatrackerRequestCount: 2,
        sourceRequestCount: 0,
        semanticCandidates: 0,
        selectedSources: 0,
        sourceCacheOutcome: "not_requested" as const,
        requests,
      };
    }
    if (retrievalCase.category === "relationship_bound") {
      const requests = [
        ...requestCopies("metadata", 8),
        ...requestCopies("relationships", 8),
        ...requestCopies("source", 1),
      ];
      return {
        ...trace,
        requestCount: requests.length,
        datatrackerRequestCount: 16,
        sourceRequestCount: 1,
        traversalComplete: false,
        traversalContexts: 8,
        traversalDepth: 1,
        depthLimit: 1,
        successorRows: 64,
        boundedExits: [
          "relationship_limit" as const,
          "context_limit" as const,
          "depth_limit" as const,
        ],
        requests,
      };
    }
    return { ...trace, sourceCacheOutcome: cacheOutcome ?? trace.sourceCacheOutcome };
  })();
  const cacheScenario = (() => {
    if (cacheOutcome === undefined || trace === null) return null;
    const before = { ...trace, sourceCacheOutcome: "miss" as const };
    const after =
      retrievalCase.category === "source_cache_hit"
        ? {
            ...trace,
            requestCount: trace.requestCount - 1,
            sourceRequestCount: 0,
            sourceCacheOutcome: "hit" as const,
            requests: trace.requests.filter(({ kind }) => kind !== "source"),
          }
        : { ...trace, sourceCacheOutcome: cacheOutcome };
    const traces = retrievalCase.category === "source_cache_miss" ? [before] : [before, after];
    const replaced = retrievalCase.category === "source_cache_replaced";
    return {
      traces,
      evidence: {
        beforeSourceHash: retrievalCase.category === "source_cache_miss" ? null : "a".repeat(64),
        afterSourceHash: replaced ? "b".repeat(64) : "a".repeat(64),
        returnedSourceHash: replaced ? "b".repeat(64) : "a".repeat(64),
        sourceRequestCounts: traces.map(({ sourceRequestCount }) => sourceRequestCount),
        networkRequestCount: traces.reduce(
          (total, { sourceRequestCount }) => total + sourceRequestCount,
          0,
        ),
        validators:
          retrievalCase.category === "source_cache_revalidated" || replaced
            ? [null, '"one"']
            : retrievalCase.category === "source_cache_repaired"
              ? [null, null]
              : [null],
        cacheEntryCorrupted: retrievalCase.category === "source_cache_repaired",
      },
    };
  })();
  const failureCacheEvidence = revalidationFailure
    ? {
        beforeSourceHash: "a".repeat(64),
        afterSourceHash: "a".repeat(64),
        returnedSourceHash: null,
        sourceRequestCounts: [1, 1],
        networkRequestCount: 2,
        validators: [null, '"one"'],
        cacheEntryCorrupted: false,
      }
    : null;
  return {
    schemaVersion: evaluationSchemaVersion,
    caseId: retrievalCase.id,
    category: retrievalCase.category,
    seam: retrievalCase.seam,
    passed,
    traces: metadataFailure
      ? []
      : revalidationFailure
        ? scenarioTrace === null
          ? []
          : [scenarioTrace]
        : (cacheScenario?.traces ?? (scenarioTrace === null ? [] : [scenarioTrace])),
    cacheEvidence: cacheScenario?.evidence ?? failureCacheEvidence,
    errorKind: passed
      ? metadataFailure
        ? "RfcDiscoveryError"
        : revalidationFailure
          ? "RfcSourceRevalidationError"
          : null
      : "RetrievalAssertionError",
  };
};

const corpusRetrievalObservations = (): ReadonlyArray<EvaluationRetrievalObservation> =>
  evaluationCorpus.retrievalCases.map((retrievalCase) => makeRetrievalObservation(retrievalCase));

const evaluateEvaluationGate = (
  metrics: Parameters<typeof evaluateGateWithRetrieval>[0],
  observations: ReadonlyArray<EvaluationObservation>,
  // These helpers build observations for the whole committed corpus, so
  // completeness is asserted here rather than left to the parameter default.
) => evaluateGateWithRetrieval(metrics, observations, corpusRetrievalObservations(), true);

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
  const report = makeEvaluationReport(
    liveEvaluationCorpus,
    liveCorpusObservations(),
    corpusRetrievalObservations(),
    {
      origin: "live",
      releaseBuildId: "rfc-evidence-precision-v2",
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
    },
  );
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
      reviewDecisionId: "fixture-accepted-review",
      reviewedAt: "2026-01-02T00:00:00.000Z",
      reviewFailures: [],
    },
  };
};

describe("precision evaluation", () => {
  test("records every schema-v2 limit under an explicitly uncalibrated policy", () => {
    expect(evaluationCorpusVersion).toBe("precision-v2");
    expect(evaluationPolicy).toMatchObject({
      schemaVersion: 2,
      policyVersion: "precision-v2",
      calibrationStatus: "uncalibrated",
      retrievalLimits: {
        maxSearchTerms: 4,
        maxTopicRequests: 8,
        maxConcurrentDatatrackerRequests: 4,
        maxRowsPerTopicRequest: 20,
        maxUpstreamTopicRows: 160,
        datatrackerMaxAttempts: 3,
        datatrackerDeadlineMilliseconds: 10_000,
        sourceDeadlineMilliseconds: 10_000,
        sourceMaximumBytes: 8 * 1024 * 1024,
      },
      candidateLimits: {
        maxMergedDocumentCandidates: 32,
        maxSourceRetrievalCandidates: 8,
        maxPassageCandidates: 8,
      },
      traversalLimits: {
        maxDepth: 16,
        maxContexts: 8,
        maxRelationshipsPerRfc: 64,
      },
      providerRetryLimits: {
        maxAttempts: 3,
        maxElapsedMilliseconds: 10_000,
      },
      acceptanceLimits: {
        calibrationStatus: "uncalibrated",
        documentProbabilityThreshold: 0.35,
        selectionProbabilityThreshold: 0.45,
        directAnswerProbabilityThreshold: 0.65,
        minimumSupportedClaimPrecision: 0.98,
      },
    });
  });

  test("commits deterministic retrieval coverage for every required version-two scenario", () => {
    expect(new Set(evaluationCorpus.retrievalCases.map(({ category }) => category))).toEqual(
      new Set([
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
      ]),
    );
    expect(evaluationCorpus.retrievalCases.every(({ live }) => live === false)).toBe(true);
  });

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

  test("records conservative research expectations before recertification", () => {
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

  test("keeps unreviewed outcomes exact and automatic outcomes evidence-backed", () => {
    expect(evaluationAllowedOutcomeSets).toEqual({});

    const observations = corpusObservations();
    const report = makeEvaluationReport(
      evaluationCorpus,
      observations,
      corpusRetrievalObservations(),
    );
    expect(report.gate.expectedOutcomePassed).toBe(true);
    expect(report.gate.passed).toBe(true);

    const unsafeAutomaticOutcome = observations.map((observation) =>
      observation.caseId === "modern-normative-requirement"
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
      observation.caseId === "modern-normative-requirement"
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
          ? { ...evaluationCase, allowedOutcomes: ["needs_review", "answered"] }
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

  test("keeps topic answers outside the uncalibrated corpus outcome policy", () => {
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
      evaluateEvaluationGate(calculateEvaluationMetrics(observations), observations)
        .expectedOutcomePassed,
    ).toBe(false);

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

  test("keeps corpus inputs atomic and preserves qualified duplicate evidence", () => {
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
    const report = makeEvaluationReport(
      evaluationCorpus,
      observations,
      corpusRetrievalObservations(),
    );

    expect(report.gate.passed).toBe(true);
    expect(report.policy).toEqual(evaluationPolicy);
    expect(report.observations[0]?.retrieval?.sourceCacheOutcome).toBe("miss");
    expect(report.metrics.supportedClaimPrecision).toBe(1);
    expect(report.metrics.supportedClaimCoverage).toBe(1);
    expect(report.metrics.statusRates.needs_split).toBeGreaterThan(0);
    expect(report.metrics.verdictRates.fabricated).toBeGreaterThan(0);
    expect(
      Schema.decodeUnknownSync(EvaluationReportSchema)(JSON.parse(JSON.stringify(report))),
    ).toEqual(report);
  });

  test("reports the exact provider model without mixing providerless controls", () => {
    const observations = corpusObservations().map((observation) =>
      observation.observedOutcome === "fabricated"
        ? {
            ...observation,
            resolvedModel: "not_requested",
            resolvedModels: [],
            usage: { inputTokens: null, outputTokens: null },
          }
        : observation,
    );
    const report = makeEvaluationReport(
      evaluationCorpus,
      observations,
      corpusRetrievalObservations(),
    );

    expect(report.resolvedModel).toBe("jev-1.13.0");
    expect(report.gate.modelPinPassed).toBe(true);
  });

  test("preserves requested and successor RFC identities in bundle provenance", () => {
    const evaluationCase = evaluationCorpus.cases.find(({ id }) => id === "older-definition");
    if (evaluationCase === undefined) throw new Error("Missing older-definition case");
    const baseline = makeObservation(evaluationCase);
    const source = (identifier: string, sourceHash: string) => ({
      identifier,
      rfcNumber: Number(identifier.slice(3)),
      sourceUrl: `https://www.rfc-editor.org/rfc/${identifier.toLowerCase()}.txt`,
      sourceHash,
      fetchedAt: "2026-01-01T00:00:00.000Z",
    });
    const bundle = {
      status: "needs_review",
      evidence: [],
      diagnostics: {
        sources: [
          { context: "requested", source: source("RFC2616", "a".repeat(64)) },
          { context: "current", source: source("RFC9110", "b".repeat(64)) },
        ],
        source: source("RFC2616", "a".repeat(64)),
        retrieval: baseline.retrieval,
        requestedModel: baseline.requestedModel,
        resolvedModel: baseline.resolvedModel,
        resolvedModels: baseline.resolvedModels,
        policyVersion: baseline.policyVersion,
        usage: baseline.usage,
        timings: baseline.timings,
        atomicity: null,
        documentSelection: [],
        selection: [],
        classification: [],
      },
    } as unknown as EvidenceBundle;

    expect(observationFromEvidenceBundle(evaluationCase, bundle).sourceProvenance).toEqual([
      { identifier: "RFC2616", sourceHash: "a".repeat(64) },
      { identifier: "RFC9110", sourceHash: "b".repeat(64) },
    ]);
  });

  test("preserves RFC identifiers with source hashes in the report manifest", () => {
    const observations = corpusObservations().map((observation) =>
      observation.caseId === "modern-normative-requirement"
        ? {
            ...observation,
            sourceProvenance: [
              { identifier: "RFC9110", sourceHash: "a".repeat(64) },
              { identifier: "RFC9110", sourceHash: "c".repeat(64) },
              { identifier: "RFC9111", sourceHash: "b".repeat(64) },
            ],
          }
        : observation,
    );
    const report = makeEvaluationReport(
      evaluationCorpus,
      observations,
      corpusRetrievalObservations(),
    );

    expect(report.authoritativeSourceHashes.RFC9110).toEqual(["a".repeat(64), "c".repeat(64)]);
    expect(report.authoritativeSourceHashes.RFC9111).toEqual(["b".repeat(64)]);
  });

  test("requires complete successful retrieval-case observations", () => {
    const observations = corpusObservations();
    const incomplete = makeEvaluationReport(
      evaluationCorpus,
      observations,
      corpusRetrievalObservations().slice(1),
    );
    const failedRetrievals = corpusRetrievalObservations().map((observation, index) =>
      index === 0 ? { ...observation, passed: false, errorKind: "AssertionError" } : observation,
    );
    const failed = makeEvaluationReport(evaluationCorpus, observations, failedRetrievals);

    expect(incomplete.gate.corpusComplete).toBe(false);
    expect(incomplete.gate.passed).toBe(false);
    expect(failed.gate.retrievalCasesPassed).toBe(false);
    expect(failed.gate.failures).toContain(
      "one or more deterministic retrieval cases did not pass",
    );
  });

  test("rejects unsaturated fan-out, incomplete cache evidence, and wrong typed failures", () => {
    const observations = corpusObservations();
    const retrievalObservations = corpusRetrievalObservations();
    const unsaturatedFanOut = retrievalObservations.map((observation) =>
      observation.category === "candidate_fan_out"
        ? {
            ...observation,
            traces: observation.traces.map((trace) => ({
              ...trace,
              semanticCandidates: 31,
              selectedSources: 7,
            })),
          }
        : observation,
    );
    const networkedHit = retrievalObservations.map((observation) =>
      observation.category === "source_cache_hit" && observation.cacheEvidence !== null
        ? {
            ...observation,
            cacheEvidence: { ...observation.cacheEvidence, networkRequestCount: 2 },
          }
        : observation,
    );
    const wrongFailure = retrievalObservations.map((observation) =>
      observation.category === "fail_closed_revalidation"
        ? { ...observation, errorKind: "RfcSourceFetchError" }
        : observation,
    );

    expect(
      evaluateGateWithRetrieval(
        calculateEvaluationMetrics(observations),
        observations,
        unsaturatedFanOut,
      ).retrievalCasesPassed,
    ).toBe(false);
    expect(
      evaluateGateWithRetrieval(
        calculateEvaluationMetrics(observations),
        observations,
        networkedHit,
      ).retrievalCasesPassed,
    ).toBe(false);
    expect(
      evaluateGateWithRetrieval(
        calculateEvaluationMetrics(observations),
        observations,
        wrongFailure,
      ).retrievalCasesPassed,
    ).toBe(false);
  });

  test("requires bounded traversal fields for research but not citation traces", () => {
    const observations = corpusObservations();
    const missingTraversal = observations.map((observation) =>
      observation.caseId === "modern-normative-requirement" && observation.retrieval !== null
        ? {
            ...observation,
            retrieval: { ...observation.retrieval, traversalDepth: undefined },
          }
        : observation,
    );
    const excessRelationships = observations.map((observation) =>
      observation.caseId === "modern-normative-requirement" && observation.retrieval !== null
        ? {
            ...observation,
            retrieval: { ...observation.retrieval, successorRows: 65 },
          }
        : observation,
    );

    expect(
      evaluateEvaluationGate(calculateEvaluationMetrics(missingTraversal), missingTraversal)
        .retrievalBoundsPassed,
    ).toBe(false);
    expect(
      evaluateEvaluationGate(calculateEvaluationMetrics(excessRelationships), excessRelationships)
        .retrievalBoundsPassed,
    ).toBe(false);
    expect(
      evaluateEvaluationGate(calculateEvaluationMetrics(observations), observations)
        .retrievalBoundsPassed,
    ).toBe(true);
  });

  test("counts logical Datatracker requests independently from bounded retries", () => {
    const observations = corpusObservations().map((observation) => {
      if (observation.mode !== "topic" || observation.retrieval === null) return observation;
      const [first, ...rest] = observation.retrieval.requests;
      if (first === undefined) return observation;
      return {
        ...observation,
        retrieval: {
          ...observation.retrieval,
          requests: [{ ...first, attempts: 3, statuses: [503, 503, 200], status: 200 }, ...rest],
        },
      };
    });
    const gate = evaluateEvaluationGate(calculateEvaluationMetrics(observations), observations);

    expect(gate.retrievalBoundsPassed).toBe(true);
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
      corpusRetrievalObservations(),
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
    const report = makeEvaluationReport(
      evaluationCorpus,
      observations,
      corpusRetrievalObservations(),
    );

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

  test("accepts the 98 percent precision boundary but still fails on the acceptance", () => {
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
    // Precision alone is sample-size dependent, so a single accepted
    // `unsupported-claim` can hide behind 49 correct acceptances. Citation
    // safety is the metric that must still catch it.
    expect(metrics.unsafeCitationAcceptances).toBe(1);
    expect(gate.citationSafetyPassed).toBe(false);
    expect(gate.passed).toBe(false);
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
    expect(gate.failures).toContain("a citation was accepted against its committed expectation");
  });

  test("rejects retrieval traces that exceed precision-v2 hard limits", () => {
    const observations = corpusObservations().map((observation) =>
      observation.mode === "topic" && observation.retrieval !== null
        ? {
            ...observation,
            retrieval: {
              ...observation.retrieval,
              semanticCandidates: 33,
              selectedSources: 9,
            },
          }
        : observation,
    );
    const gate = evaluateEvaluationGate(calculateEvaluationMetrics(observations), observations);

    expect(gate.retrievalBoundsPassed).toBe(false);
    expect(gate.passed).toBe(false);
    expect(gate.failures).toContain("a retrieval trace exceeded the precision-v2 hard limits");
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
    const deterministicReport = makeEvaluationReport(
      evaluationCorpus,
      corpusObservations(),
      corpusRetrievalObservations(),
    );
    const report = makeEvaluationReport(
      liveEvaluationCorpus,
      liveCorpusObservations(),
      corpusRetrievalObservations(),
      {
        origin: "live",
        releaseBuildId: "rfc-evidence-precision-v2",
        corpusDigest: "pending",
        createdAt: "2026-01-01T00:00:00.000Z",
        expiresAt: "2026-02-01T00:00:00.000Z",
        authoritativeSourceHashes: undefined,
        policyVersion: "precision-v2",
        requestedModel: "jev-latest",
        pinnedModel: "jev-1.13.0",
        minimumSupportedClaimPrecision: undefined,
        maxKnownRfcP95LatencyMilliseconds: undefined,
        maxTopicP95LatencyMilliseconds: undefined,
      },
    );

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

  test("records the reviewed precision-v2 rejection without enabling activation", () => {
    expect(evaluationReleaseAttestation).toMatchObject({
      status: "rejected",
      buildId: "rfc-evidence-precision-v2",
      corpusDigest: evaluationCorpusDigest,
      policyDigest: evaluationPolicyDigest,
      reviewFailures: [
        "observed outcomes fell outside committed allowed outcome sets",
        "positive-control research cases did not remain answered",
        "warm-cache research p95 latency exceeded a configured gate",
      ],
    });
    expect(evaluationReleaseAttestation.reviewDecisionId).toBe(precisionV2HumanReviewDecision.id);
    expect(evaluationReleaseAttestation.status).toBe(precisionV2HumanReviewDecision.decision);
    expect(evaluationReleaseAttestation.buildId).toBe(
      precisionV2HumanReviewDecision.releaseBuildId,
    );
    expect(evaluationReleaseAttestation.reportDigest).toBe(
      precisionV2HumanReviewDecision.reportDigest,
    );
    expect(evaluationReleaseAttestation.corpusDigest).toBe(
      precisionV2HumanReviewDecision.corpusDigest,
    );
    expect(evaluationReleaseAttestation.policyDigest).toBe(
      precisionV2HumanReviewDecision.policyDigest,
    );
    expect(evaluationReleaseAttestation.expiresAt).toBe(
      precisionV2HumanReviewDecision.reportExpiresAt,
    );
    expect(evaluationReleaseAttestation.reviewedAt).toBe(precisionV2HumanReviewDecision.reviewedAt);
    expect(evaluationReleaseAttestation.reviewFailures).toEqual(
      precisionV2HumanReviewDecision.failures,
    );
    expect(precisionV2HumanReviewDecision.reviewAuthority).toBe("human_user");
    expect(evaluationReleaseAttestation.reportDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(evaluationReleaseAttestation.reviewedAt).not.toBeNull();
    expect(
      Object.keys(evaluationReleaseAttestation.authoritativeSourceHashes).length,
    ).toBeGreaterThan(0);
  });

  test("does not activate a rejected attestation with a stable release identity", () => {
    const { report, attestation } = acceptedFixtureReport();

    expect(evaluationReleaseAttestation).toMatchObject({
      status: "rejected",
      buildId: "rfc-evidence-precision-v2",
    });
    expect(
      isAcceptedEvaluationReportForAttestation(
        report,
        {
          ...attestation,
          status: "rejected" as const,
          reviewFailures: ["positive-control research cases did not remain answered"],
        },
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
        { ...attestation, reviewDecisionId: null },
        now,
      ),
    ).toBe(false);
    expect(
      isAcceptedEvaluationReportForAttestation(report, { ...attestation, reviewedAt: null }, now),
    ).toBe(false);
    expect(
      isAcceptedEvaluationReportForAttestation(
        report,
        { ...attestation, reviewFailures: ["review rejected the report"] },
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
        {
          ...report,
          policy: {
            ...report.policy,
            candidateLimits: { ...report.policy.candidateLimits, maxMergedDocumentCandidates: 31 },
          },
        },
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
    const mismatchedSourceReport = {
      ...report,
      authoritativeSourceHashes: {
        ...report.authoritativeSourceHashes,
        RFC9110: ["b".repeat(64)],
      },
    };
    expect(
      isAcceptedEvaluationReportForAttestation(
        mismatchedSourceReport,
        {
          ...attestation,
          reportDigest: evaluationReportDigest(mismatchedSourceReport),
          authoritativeSourceHashes: mismatchedSourceReport.authoritativeSourceHashes,
        },
        now,
      ),
    ).toBe(false);
    const missingRetrievalEvidenceReport = {
      ...report,
      retrievalObservations: report.retrievalObservations.map((observation, index) =>
        index === 0 ? { ...observation, traces: [] } : observation,
      ),
    };
    expect(
      isAcceptedEvaluationReportForAttestation(
        missingRetrievalEvidenceReport,
        {
          ...attestation,
          reportDigest: evaluationReportDigest(missingRetrievalEvidenceReport),
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

  // The reviewed report remains ignored; validate it when present in a release workspace.
  if (existsSync(reviewedReleaseReportPath)) {
    test("binds the exact rejected report without enabling activation", async () => {
      const report = await Bun.file(reviewedReleaseReportPath).json();
      expect(report.gate.passed).toBe(false);
      expect(report.gate.failures).toEqual(evaluationReleaseAttestation.reviewFailures);
      expect(report.expiresAt).toBe(evaluationReleaseAttestation.expiresAt);
      expect(report.authoritativeSourceHashes).toEqual(
        evaluationReleaseAttestation.authoritativeSourceHashes,
      );
      expect(isAcceptedEvaluationReport(report)).toBe(false);
      expect(evaluationReportDigest(report)).toBe(
        evaluationReleaseAttestation.reportDigest ?? "missing report digest",
      );
    });
  }
});
