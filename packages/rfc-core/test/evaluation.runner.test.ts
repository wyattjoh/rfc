import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { Effect, Ref } from "effect";
import * as Decision from "effect/unstable/ai/Decision";
import * as DecisionModel from "effect/unstable/ai/DecisionModel";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import {
  createRfcClient,
  evaluationCorpus,
  evaluationSchemaVersion,
  observationFromCitationResult,
  observationFromEvidenceBundle,
  runEvaluation,
  type EvaluationCase,
  type EvaluationObservation,
  type EvaluationRetrievalCase,
  type EvaluationRetrievalObservation,
  type LiveRetrievalTrace,
  type RfcSourceFetcher,
} from "../src/index";
import {
  createRfcCalibrationClient,
  evaluateDeterministicRetrievalCase,
} from "../src/internal-calibration";
import { ResolvedModelName, ResolvedModelNames } from "../src/research";

const fixtureDocuments = [
  {
    identifier: "RFC9110",
    rfcNumber: 9110,
    title: "HTTP Semantics",
    abstract: "HTTP client requests, server caching, and HTTP message semantics.",
  },
  {
    identifier: "RFC2616",
    rfcNumber: 2616,
    title: "HTTP/1.1 Entity Definitions",
    abstract: "Older HTTP/1.1 definitions including the entity representation.",
  },
  {
    identifier: "RFC7230",
    rfcNumber: 7230,
    title: "HTTP/1.1 Message Syntax and Routing",
    abstract: "HTTP client request message procedures and routing.",
  },
  {
    identifier: "RFC8446",
    rfcNumber: 8446,
    title: "The TLS Protocol Version 1.3",
    abstract: "TLS 1.3 handshake purpose and protocol procedure.",
  },
  {
    identifier: "RFC6749",
    rfcNumber: 6749,
    title: "The OAuth 2.0 Authorization Framework",
    abstract: "OAuth 2.0 authorization grant definitions and procedures.",
  },
  {
    identifier: "RFC1034",
    rfcNumber: 1034,
    title: "Domain Names - Concepts and Facilities",
    abstract: "DNS resolver concepts and name service behavior.",
  },
].map((document) => ({
  ...document,
  status: "published" as const,
  stream: "ietf" as const,
  canonicalUrl: `https://datatracker.ietf.org/doc/rfc${document.rfcNumber}/`,
  updates: [],
  updatedBy: [],
  obsoletes: [],
  obsoletedBy: [],
}));

const fixtureSources: Readonly<Record<string, string>> = {
  RFC9110: [
    "1. Requirements",
    "",
    "The HTTP client MUST send a request containing the target resource.",
    "",
    "The server SHOULD generate a Location header field in the response",
    "   containing a preferred URI reference for the new permanent URI.",
    "",
    "The server SHOULD generate a Location header field in the response",
    "   containing a preferred URI reference for the new permanent URI.",
    "",
    "The representation data associated with an HTTP message is either",
    "   provided as the content of the message or referred to by the message",
    "   semantics and the target URI.",
    "",
    "A sender MUST NOT generate protocol elements that do not match the",
    "   grammar defined by the corresponding ABNF rules.",
    "",
    "The server does not have to cache every request.",
  ].join("\n"),
  RFC2616: [
    "1. Definitions",
    "",
    "An entity is the representation or representation metadata enclosed in the request or response.",
    "",
    "An HTTP/1.1 client sends a request message to a server.",
  ].join("\n"),
  RFC7230: [
    "1. Message Syntax",
    "",
    "An HTTP client sends a request message through the message syntax and routing procedure.",
  ].join("\n"),
  RFC8446: [
    "4. Handshake Protocol",
    "",
    "The TLS 1.3 handshake establishes shared secrets and authenticates the communicating peers.",
  ].join("\n"),
  RFC6749: [
    "1.3. Authorization Grant",
    "",
    "An authorization grant is a credential representing the resource owner's authorization.",
  ].join("\n"),
  RFC1034: [
    "2. DNS Data",
    "",
    "A DNS resolver finds and returns information for a domain name on behalf of a client.",
  ].join("\n"),
};

type FixtureInput = {
  readonly question?: string;
  readonly claim?: string;
  readonly quote?: string;
  readonly documents?: Readonly<Record<string, unknown>>;
  readonly passages?: Readonly<Record<string, unknown>>;
};

type RecordedAnswer =
  | {
      readonly label: string;
      readonly probabilities: Readonly<Record<string, number>>;
      readonly confidence: number;
    }
  | { readonly probability: number };

const classify = (
  label: string,
  probabilities: Readonly<Record<string, number>>,
  confidence = 0.95,
): RecordedAnswer => ({ label, probabilities, confidence });

const relationForQuestion = (question: string): [string, number] => {
  // These recorded answers mirror the round-8 corpus recertification: the
  // provider evidence is deliberately below the relation-confidence floor,
  // so the deterministic runner proves the expected needs_review outcome
  // without weakening the production policy.
  if (
    question === "What is an entity in HTTP/1.1?" ||
    question === "Which requirement applies after this RFC was obsoleted?"
  ) {
    return ["background_only", 0.5];
  }
  if (
    question === "How does a client send an HTTP request?" ||
    question === "What is the purpose of the TLS 1.3 handshake?" ||
    question === "What is an authorization grant in OAuth 2.0?" ||
    question === "What does a DNS resolver do?"
  ) {
    return ["direct_answer", 0.5];
  }
  if (
    question === "What does the updated HTTP message procedure require?" ||
    question === "What does RFC9110 say about server caching?"
  ) {
    return ["partial_answer", 0.5];
  }
  if (question === "Does RFC 9110 require a server to cache every request?") {
    return ["irrelevant", 0.5];
  }
  return ["direct_answer", 0.95];
};

const citationVerdictForClaim = (claim: string): string => {
  if (claim === "The server must cache every request.") return "unsupported";
  if (claim === "A sender must generate protocol elements that do not match the grammar.") {
    return "contradicted";
  }
  return "verified";
};

const makeRecordedDecisionModel = (): DecisionModel.DecisionModel => {
  const model = {
    [DecisionModel.TypeId]: DecisionModel.TypeId,
    decide: (
      definition: { readonly decisions: Readonly<Record<string, Decision.Any>> },
      options: { readonly input: FixtureInput },
    ) => {
      const input = options.input;
      const answers: Record<string, RecordedAnswer> = {};
      const [relation, confidence] = relationForQuestion(input.question ?? "");
      for (const [key, decision] of Object.entries(definition.decisions)) {
        if (key === "question_atomicity") {
          const compound =
            input.question === "What must the client send and what does the server cache?";
          answers[key] = classify(
            compound ? "compound" : "atomic",
            compound ? { atomic: 0.05, compound: 0.95 } : { atomic: 0.95, compound: 0.05 },
          );
        } else if (decision._tag === "Probability") {
          const lowConfidenceTopicSelection = input.documents !== undefined;
          answers[key] = { probability: lowConfidenceTopicSelection ? 0.34 : 0.95 };
        } else if (key === "citation_verdict") {
          const verdict = citationVerdictForClaim(input.claim ?? "");
          answers[key] = classify(
            verdict,
            verdict === "verified"
              ? { verified: 0.95, unsupported: 0.025, contradicted: 0.025 }
              : verdict === "unsupported"
                ? { verified: 0.025, unsupported: 0.95, contradicted: 0.025 }
                : { verified: 0.025, unsupported: 0.025, contradicted: 0.95 },
          );
        } else {
          answers[key] = classify(
            relation,
            relation === "direct_answer"
              ? {
                  direct_answer: 0.95,
                  partial_answer: 0.0125,
                  background_only: 0.0125,
                  contradictory: 0.0125,
                  irrelevant: 0.0125,
                }
              : relation === "partial_answer"
                ? {
                    direct_answer: 0.0125,
                    partial_answer: 0.95,
                    background_only: 0.0125,
                    contradictory: 0.0125,
                    irrelevant: 0.0125,
                  }
                : relation === "irrelevant"
                  ? {
                      direct_answer: 0.025,
                      partial_answer: 0.025,
                      background_only: 0.0,
                      contradictory: 0.0,
                      irrelevant: 0.95,
                    }
                  : {
                      direct_answer: 0.025,
                      partial_answer: 0.025,
                      background_only: 0.95,
                      contradictory: 0.0,
                      irrelevant: 0.0,
                    },
            confidence,
          );
        }
      }
      return Effect.gen(function* () {
        const resolvedModel = yield* ResolvedModelName;
        const resolvedModels = yield* ResolvedModelNames;
        yield* Ref.set(resolvedModel, "jev-1.13.0");
        yield* Ref.update(resolvedModels, (models) => [...models, "jev-1.13.0"]);
        return {
          answers,
          usage: { inputTokens: 12, outputTokens: 8 },
        };
      });
    },
  } as unknown as DecisionModel.DecisionModel;
  return model;
};

const sourceFetcher: RfcSourceFetcher = async (document) => {
  const text = fixtureSources[document.identifier];
  if (text === undefined) throw new Error(`Missing fixture source for ${document.identifier}`);
  return {
    sourceUrl: `https://www.rfc-editor.org/rfc/rfc${document.rfcNumber}.txt`,
    text,
  };
};

const researchRequestForCase = (evaluationCase: EvaluationCase) => {
  if (evaluationCase.question === null)
    throw new Error(`Missing question for ${evaluationCase.id}`);
  return evaluationCase.rfc === null
    ? {
        schemaVersion: 2 as const,
        question: evaluationCase.question,
        rfc: null,
        searchTerms: evaluationCase.searchTerms ?? ["HTTP client request message"],
      }
    : {
        schemaVersion: 2 as const,
        question: evaluationCase.question,
        rfc: evaluationCase.rfc,
        searchTerms: undefined,
      };
};

const citationRequestForCase = (evaluationCase: EvaluationCase, source: string) => {
  if (
    evaluationCase.rfc === null ||
    evaluationCase.claim === null ||
    evaluationCase.quote === null
  ) {
    throw new Error(`Incomplete citation case ${evaluationCase.id}`);
  }
  const characterOffset = source.indexOf(evaluationCase.quote);
  if (evaluationCase.category !== "fabricated_quotation" && characterOffset < 0) {
    throw new Error(`Missing quote for ${evaluationCase.id}`);
  }
  const offset =
    evaluationCase.category === "duplicate_quotation" && characterOffset >= 0
      ? new TextEncoder().encode(source.slice(0, characterOffset)).byteLength
      : null;
  return {
    schemaVersion: 2 as const,
    rfc: evaluationCase.rfc,
    claim: evaluationCase.claim,
    quote: evaluationCase.quote,
    offset,
  };
};

const datatrackerClient = HttpClient.make((request, url) => {
  const exactName = url.pathname.match(/\/document\/(rfc\d+)\/$/)?.[1];
  if (exactName !== undefined) {
    const document = fixtureDocuments.find(
      (candidate) => candidate.identifier.toLowerCase() === exactName,
    );
    return Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        document === undefined
          ? new Response("not found", { status: 404 })
          : Response.json({
              name: exactName,
              rfc_number: document.rfcNumber,
              title: document.title,
              abstract: document.abstract,
              resource_uri: `/api/v1/doc/document/${exactName}/`,
              stream: "/api/v1/name/streamname/ietf/",
              states: [],
            }),
      ),
    );
  }
  if (url.pathname.endsWith("/relateddocument/")) {
    return Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        Response.json({
          meta: { limit: 64, offset: 0, total_count: 0, next: null },
          objects: [],
        }),
      ),
    );
  }
  const noCandidateControl = [...url.searchParams.values()].some((value) =>
    value.includes("rfc-evidence-no-candidate-7f31"),
  );
  const documents = noCandidateControl ? [] : fixtureDocuments;
  return Effect.succeed(
    HttpClientResponse.fromWeb(
      request,
      Response.json({
        meta: { limit: 20, offset: 0, total_count: documents.length, next: null },
        objects: documents.map((document) => ({
          name: document.identifier.toLowerCase(),
          rfc_number: document.rfcNumber,
          title: document.title,
          abstract: document.abstract,
          resource_uri: `/api/v1/doc/document/${document.identifier.toLowerCase()}/`,
          stream: "/api/v1/name/streamname/ietf/",
          states: [],
        })),
      }),
    ),
  );
});

const clientOptions = (cacheDirectory: string, decisionModel: DecisionModel.DecisionModel) => ({
  cacheDirectory,
  datatrackerHttpClient: datatrackerClient,
  modelAlias: "jev-latest",
  typeSafeApiKey: undefined,
  typeSafeApiUrl: undefined,
  rfcSourceFetcher: sourceFetcher,
  decisionModel,
  policyPreset: "precision-v2",
  now: () => Date.parse("2026-01-01T00:00:00.000Z"),
});

const retrievalObservation = async (
  retrievalCase: EvaluationRetrievalCase,
): Promise<EvaluationRetrievalObservation> => {
  const cacheDirectory = await mkdtemp(join(tmpdir(), `rfc-retrieval-${retrievalCase.id}-`));
  let now = 0;
  let sourceRequests = 0;
  const relationshipRows = (target: number) => {
    if (retrievalCase.category === "update_chain" && target === 9110) {
      return [{ source: 9111, relationship: "updates" }];
    }
    if (retrievalCase.category === "cycle_safety") {
      if (target === 9110) return [{ source: 9111, relationship: "updates" }];
      if (target === 9111) return [{ source: 9110, relationship: "updates" }];
    }
    if (retrievalCase.category === "relationship_bound" && target === 9110) {
      return Array.from({ length: 64 }, () => ({ source: 9111, relationship: "updates" }));
    }
    return [];
  };
  const datatracker = HttpClient.make((request, url) => {
    if (
      retrievalCase.category === "fail_closed_upstream" &&
      url.pathname.includes("/document/rfc9110/")
    ) {
      return Effect.succeed(
        HttpClientResponse.fromWeb(request, new Response("unavailable", { status: 503 })),
      );
    }
    const exactNumber = url.pathname.match(/\/document\/rfc(\d+)\/$/)?.[1];
    if (exactNumber !== undefined) {
      const rfcNumber = Number(exactNumber);
      return Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          Response.json({
            name: `rfc${rfcNumber}`,
            rfc_number: rfcNumber,
            title: `RFC ${rfcNumber}`,
            abstract: "HTTP client requests and message semantics.",
            resource_uri: `/api/v1/doc/document/rfc${rfcNumber}/`,
            stream: "/api/v1/name/streamname/ietf/",
            states: [],
          }),
        ),
      );
    }
    if (url.pathname.endsWith("/relateddocument/")) {
      const target = Number(url.searchParams.get("target__name")?.slice(3));
      const rows = relationshipRows(target);
      return Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          Response.json({
            meta: {
              limit: 64,
              offset: 0,
              total_count: retrievalCase.category === "relationship_bound" ? 65 : rows.length,
              next:
                retrievalCase.category === "relationship_bound"
                  ? "/api/v1/doc/relateddocument/?offset=64"
                  : null,
            },
            objects: rows.map(({ source, relationship }) => ({
              source: `/api/v1/doc/document/rfc${source}/`,
              target: `/api/v1/doc/document/rfc${target}/`,
              relationship: `/api/v1/name/docrelationshipname/${relationship}/`,
            })),
          }),
        ),
      );
    }
    const documents = retrievalCase.category === "no_candidate_outcome" ? [] : fixtureDocuments;
    return Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        Response.json({
          meta: { limit: 20, offset: 0, total_count: documents.length, next: null },
          objects: documents.map((document) => ({
            name: document.identifier.toLowerCase(),
            rfc_number: document.rfcNumber,
            title: document.title,
            abstract: document.abstract,
            resource_uri: `/api/v1/doc/document/${document.identifier.toLowerCase()}/`,
            stream: "/api/v1/name/streamname/ietf/",
            states: [],
          })),
        }),
      ),
    );
  });
  const sourceHttp = HttpClient.make((request) => {
    sourceRequests += 1;
    if (sourceRequests === 2 && retrievalCase.category === "source_cache_revalidated") {
      return Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          new Response(null, {
            status: 304,
            headers: { etag: '"one"', "cache-control": "max-age=60" },
          }),
        ),
      );
    }
    const changed = sourceRequests > 1 && retrievalCase.category === "source_cache_replaced";
    return Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        new Response(
          changed ? fixtureSources.RFC9110?.replace("client", "sender") : fixtureSources.RFC9110,
          {
            status: 200,
            headers: {
              etag: sourceRequests === 1 ? '"one"' : '"two"',
              "cache-control": "max-age=60",
              "content-type": "text/plain; charset=utf-8",
            },
          },
        ),
      ),
    );
  });
  const usesConditionalSource =
    retrievalCase.category === "source_cache_revalidated" ||
    retrievalCase.category === "source_cache_replaced";
  const client = await createRfcClient({
    cacheDirectory,
    datatrackerHttpClient: datatracker,
    modelAlias: "jev-latest",
    typeSafeApiKey: undefined,
    typeSafeApiUrl: undefined,
    automaticAnswerActivation: undefined,
    ...(usesConditionalSource
      ? { rfcSourceHttpClient: sourceHttp }
      : { rfcSourceFetcher: sourceFetcher }),
    decisionModel: makeRecordedDecisionModel(),
    policyPreset: "precision-v2" as const,
    now: () => now,
  });
  const traces: Array<LiveRetrievalTrace> = [];
  let passed = false;
  let observedErrorKind: string | null = null;
  const knownRequest = {
    schemaVersion: 2 as const,
    question: "How does an HTTP client send a request message?",
    rfc: "RFC9110",
    searchTerms: undefined,
  };
  const runKnown = async () => {
    const result = await client.research(knownRequest);
    traces.push(result.diagnostics.retrieval);
    return result;
  };

  try {
    switch (retrievalCase.category) {
      case "known_current_rfc": {
        const result = await runKnown();
        passed = result.diagnostics.retrieval.traversalContexts === 1;
        break;
      }
      case "update_chain": {
        const result = await runKnown();
        passed =
          result.diagnostics.retrieval.traversalContexts === 2 &&
          result.diagnostics.retrieval.traversalDepth === 1;
        break;
      }
      case "cycle_safety": {
        const result = await runKnown();
        passed = result.status === "needs_review" && result.currency?.complete === false;
        break;
      }
      case "ordered_topic_terms": {
        const result = await client.research({
          schemaVersion: 2,
          question: "Which RFCs describe HTTP messages?",
          rfc: null,
          searchTerms: ["first term", "second term"],
        });
        traces.push(result.diagnostics.retrieval);
        const urls = result.diagnostics.retrieval.requests.map(({ url }) => url);
        passed =
          urls.length === 4 &&
          urls.slice(0, 2).every((url) => url.includes("first+term")) &&
          urls.slice(2).every((url) => url.includes("second+term"));
        break;
      }
      case "candidate_fan_out": {
        const result = await client.research({
          schemaVersion: 2,
          question: "Which requirements apply?",
          rfc: null,
          searchTerms: ["one", "two", "three", "four"],
        });
        const trace = result.diagnostics.retrieval;
        traces.push(trace);
        passed =
          trace.datatrackerRequestCount === 8 &&
          (trace.semanticCandidates ?? 33) <= 32 &&
          (trace.selectedSources ?? 9) <= 8;
        break;
      }
      case "no_candidate_outcome": {
        const result = await client.research({
          schemaVersion: 2,
          question: "Which requirements apply?",
          rfc: null,
          searchTerms: ["none"],
        });
        traces.push(result.diagnostics.retrieval);
        passed =
          result.status === "needs_review" && result.diagnostics.retrieval.semanticCandidates === 0;
        break;
      }
      case "relationship_bound": {
        const result = await runKnown();
        passed =
          result.status === "needs_review" &&
          result.diagnostics.retrieval.boundedExits?.includes("relationship_limit") === true;
        break;
      }
      case "source_cache_miss": {
        const result = await runKnown();
        passed = result.diagnostics.retrieval.sourceCacheOutcome === "miss";
        break;
      }
      case "source_cache_hit": {
        await runKnown();
        const result = await runKnown();
        passed = result.diagnostics.retrieval.sourceCacheOutcome === "hit";
        break;
      }
      case "source_cache_revalidated":
      case "source_cache_replaced": {
        await runKnown();
        now = 61_000;
        const result = await runKnown();
        passed =
          result.diagnostics.retrieval.sourceCacheOutcome ===
          (retrievalCase.category === "source_cache_revalidated" ? "revalidated" : "replaced");
        break;
      }
      case "source_cache_repaired": {
        await runKnown();
        await writeFile(join(cacheDirectory, "sources", "v2", "RFC9110.json"), "{corrupt");
        const result = await runKnown();
        passed = result.diagnostics.retrieval.sourceCacheOutcome === "repaired";
        break;
      }
      case "fail_closed_upstream": {
        try {
          await runKnown();
        } catch (error) {
          observedErrorKind =
            typeof error === "object" && error !== null && "_tag" in error
              ? String(error._tag)
              : "UnknownError";
          passed = observedErrorKind === "RfcDiscoveryError";
        }
        break;
      }
    }
  } finally {
    await client.close();
    await rm(cacheDirectory, { recursive: true, force: true });
  }

  return {
    schemaVersion: evaluationSchemaVersion,
    caseId: retrievalCase.id,
    category: retrievalCase.category,
    seam: retrievalCase.seam,
    passed,
    traces,
    errorKind: passed ? observedErrorKind : (observedErrorKind ?? "RetrievalAssertionError"),
  };
};

describe("committed evaluation runner", () => {
  test("executes the shipped deterministic retrieval runner through the public client", async () => {
    const observations: Array<EvaluationRetrievalObservation> = [];
    for (const retrievalCase of evaluationCorpus.retrievalCases) {
      const observation = await evaluateDeterministicRetrievalCase(retrievalCase);
      const independentControl = await retrievalObservation(retrievalCase);
      expect(independentControl.passed).toBe(true);
      expect(independentControl.category).toBe(observation.category);
      observations.push(observation);
    }

    expect(observations.map(({ caseId }) => caseId)).toEqual(
      evaluationCorpus.retrievalCases.map(({ id }) => id),
    );
    expect(observations.every(({ passed }) => passed)).toBe(true);
    expect(
      observations.find(({ category }) => category === "relationship_bound")?.traces[0]
        ?.boundedExits,
    ).toEqual(["depth_limit", "context_limit", "relationship_limit"]);
  });

  test("executes every committed case through public research and citation results", async () => {
    const cacheDirectory = await mkdtemp(join(tmpdir(), "rfc-core-evaluation-runner-test-"));
    const client = await createRfcCalibrationClient(
      clientOptions(cacheDirectory, makeRecordedDecisionModel()),
    );
    const evaluatedCaseIds: Array<string> = [];
    const evaluatedRetrievalCaseIds: Array<string> = [];

    try {
      const report = await runEvaluation(
        evaluationCorpus,
        async (evaluationCase): Promise<EvaluationObservation> => {
          evaluatedCaseIds.push(evaluationCase.id);
          const source =
            evaluationCase.rfc === null ? "" : (fixtureSources[evaluationCase.rfc] ?? "");
          if (evaluationCase.kind === "research") {
            const result = await client.research(researchRequestForCase(evaluationCase));
            return observationFromEvidenceBundle(evaluationCase, result);
          }
          const result = await client.verifyCitation(
            citationRequestForCase(evaluationCase, source),
          );
          return observationFromCitationResult(evaluationCase, result);
        },
        async (retrievalCase) => {
          evaluatedRetrievalCaseIds.push(retrievalCase.id);
          return evaluateDeterministicRetrievalCase(retrievalCase);
        },
      );

      expect(evaluatedCaseIds).toEqual(evaluationCorpus.cases.map(({ id }) => id));
      expect(evaluatedRetrievalCaseIds).toEqual(
        evaluationCorpus.retrievalCases.map(({ id }) => id),
      );
      expect(report.observations).toHaveLength(evaluationCorpus.cases.length);
      expect(report.retrievalObservations).toHaveLength(evaluationCorpus.retrievalCases.length);
      expect(report.retrievalObservations.every(({ passed }) => passed)).toBe(true);
      expect(report.observations.every(({ retrieval }) => retrieval !== null)).toBe(true);
      expect(
        report.observations
          .find(({ caseId }) => caseId === "topic-ordered-search-terms")
          ?.retrieval?.requests.filter(({ kind }) => kind === "metadata")
          .map(({ url }) => new URL(url).searchParams.values().next().value),
      ).toHaveLength(4);
      expect(
        report.observations.find(({ caseId }) => caseId === "topic-no-candidates")?.retrieval,
      ).toMatchObject({
        sourceCacheOutcome: "not_requested",
        semanticCandidates: 0,
        selectedSources: 0,
      });
      expect(report.gate.failures).toEqual([]);
      expect(report.gate.passed).toBe(true);
      expect(report.gate.expectedOutcomePassed).toBe(true);
      expect(report.metrics.supportedClaimPrecision).toBe(1);
      expect(report.metrics.unsafeCitationAcceptances).toBe(0);
    } finally {
      await client.close();
      await rm(cacheDirectory, { recursive: true, force: true });
    }
  });
});
