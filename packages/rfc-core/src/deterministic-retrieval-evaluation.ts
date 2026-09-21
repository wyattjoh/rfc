import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import * as Decision from "effect/unstable/ai/Decision";
import * as DecisionModel from "effect/unstable/ai/DecisionModel";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import {
  createRfcClient,
  type EvaluationCacheEvidence,
  type EvaluationRetrievalCase,
  type EvaluationRetrievalObservation,
  type LiveRetrievalTrace,
} from "./index";
import { evaluationSchemaVersion } from "./evaluation";

const fixtureDocuments = Array.from({ length: 40 }, (_, index) => {
  const rfcNumber = 9500 + index;
  return {
    identifier: `RFC${rfcNumber}`,
    rfcNumber,
    title: `RFC ${rfcNumber}`,
    abstract: "Protocol requirements and message semantics.",
  };
});

const sourceText = [
  "1. Requirements",
  "",
  "The HTTP client MUST send a request containing the target resource.",
  "",
  "The server SHOULD generate a response containing a preferred URI reference.",
].join("\n");

const decisionModel = {
  [DecisionModel.TypeId]: DecisionModel.TypeId,
  decide: (definition: { readonly decisions: Readonly<Record<string, Decision.Any>> }) => {
    const answers = Object.fromEntries(
      Object.entries(definition.decisions).map(([key, decision]) => {
        if (key === "question_atomicity") {
          return [
            key,
            {
              label: "atomic",
              probabilities: { atomic: 0.99, compound: 0.01 },
              confidence: 0.99,
            },
          ];
        }
        if (decision._tag === "Probability") return [key, { probability: 0.9 }];
        return [
          key,
          {
            label: "direct_answer",
            probabilities: {
              direct_answer: 0.96,
              partial_answer: 0.01,
              background_only: 0.01,
              contradictory: 0.01,
              irrelevant: 0.01,
            },
            confidence: 0.99,
          },
        ];
      }),
    );
    return Effect.succeed({ answers, usage: { inputTokens: 1, outputTokens: 1 } });
  },
} as unknown as DecisionModel.DecisionModel;

const relationshipRows = (category: EvaluationRetrievalCase["category"], target: number) => {
  if (category === "update_chain" && target === 9110) {
    return [{ source: 9111, relationship: "updates" }];
  }
  if (category === "cycle_safety") {
    if (target === 9110) return [{ source: 9111, relationship: "updates" }];
    if (target === 9111) return [{ source: 9110, relationship: "updates" }];
  }
  if (category === "relationship_bound") {
    if (target === 9110) {
      return Array.from({ length: 64 }, (_, index) => ({
        source: 9111 + index,
        relationship: "updates",
      }));
    }
    if (target === 9111) return [{ source: 9180, relationship: "updates" }];
  }
  return [];
};

const errorKind = (error: unknown): string =>
  typeof error === "object" && error !== null && "_tag" in error
    ? String(error._tag)
    : "RetrievalEvaluationError";

/**
 * Execute one committed deterministic retrieval case through the public `RfcClient` seam.
 *
 * The runner injects bounded local Datatracker, RFC Editor, model, cache, and clock
 * dependencies. It performs no network access and records the public retrieval traces
 * used to decide whether the scenario passed.
 *
 * @param retrievalCase Committed deterministic retrieval scenario.
 * @returns Sanitized public-client evidence for the retrieval release gate.
 */
export const evaluateDeterministicRetrievalCase = async (
  retrievalCase: EvaluationRetrievalCase,
): Promise<EvaluationRetrievalObservation> => {
  const cacheDirectory = await mkdtemp(join(tmpdir(), `rfc-retrieval-${retrievalCase.id}-`));
  let now = 0;
  let sourceRequests = 0;
  const validators: Array<string | null> = [];
  const category = retrievalCase.category;
  const datatracker = HttpClient.make((request, url) => {
    if (category === "fail_closed_metadata" && url.pathname.includes("/document/rfc9110/")) {
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
            abstract: "Protocol requirements and message semantics.",
            resource_uri: `/api/v1/doc/document/rfc${rfcNumber}/`,
            stream: "/api/v1/name/streamname/ietf/",
            states: [],
          }),
        ),
      );
    }
    if (url.pathname.endsWith("/relateddocument/")) {
      const target = Number(url.searchParams.get("target__name")?.slice(3));
      const rows = relationshipRows(category, target);
      return Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          Response.json({
            meta: {
              limit: 64,
              offset: 0,
              total_count: category === "relationship_bound" && target === 9110 ? 65 : rows.length,
              next:
                category === "relationship_bound" && target === 9110
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
    const documents =
      category === "no_candidate_outcome"
        ? []
        : url.searchParams.has("abstract__icontains")
          ? fixtureDocuments.slice(20)
          : fixtureDocuments.slice(0, 20);
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
    validators.push(request.headers["if-none-match"] ?? null);
    if (sourceRequests === 2 && category === "fail_closed_revalidation") {
      return Effect.succeed(
        HttpClientResponse.fromWeb(request, new Response("unavailable", { status: 503 })),
      );
    }
    if (sourceRequests === 2 && category === "source_cache_revalidated") {
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
    const text =
      sourceRequests > 1 && category === "source_cache_replaced"
        ? sourceText.replace("client", "sender")
        : sourceText;
    return Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        new Response(text, {
          status: 200,
          headers: {
            etag: sourceRequests === 1 ? '"one"' : '"two"',
            "cache-control": "max-age=60",
            "content-type": "text/plain; charset=utf-8",
          },
        }),
      ),
    );
  });
  const usesConditionalSource =
    category.startsWith("source_cache_") || category === "fail_closed_revalidation";
  const client = await createRfcClient({
    cacheDirectory,
    datatrackerHttpClient: datatracker,
    modelAlias: "jev-latest",
    typeSafeApiKey: undefined,
    typeSafeApiUrl: undefined,
    automaticAnswerActivation: undefined,
    ...(usesConditionalSource
      ? { rfcSourceHttpClient: sourceHttp }
      : {
          rfcSourceFetcher: async (document) => ({
            sourceUrl: `https://www.rfc-editor.org/rfc/rfc${document.rfcNumber}.txt`,
            text: sourceText,
          }),
        }),
    decisionModel,
    policyPreset: "precision-v2",
    currencyTraversalDepthLimit: category === "relationship_bound" ? 1 : undefined,
    now: () => now,
  });
  const traces: Array<LiveRetrievalTrace> = [];
  let cacheEvidence: EvaluationCacheEvidence | null = null;
  let staleSourceHash: string | null = null;
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
  const sourceHashFrom = (result: Awaited<ReturnType<typeof runKnown>>): string | null =>
    result.diagnostics.source?.sourceHash ?? null;
  const cachedSourceHash = async (): Promise<string | null> => {
    try {
      const entry: unknown = JSON.parse(
        await readFile(join(cacheDirectory, "sources", "v2", "RFC9110.json"), "utf8"),
      );
      if (typeof entry !== "object" || entry === null || !("contentHash" in entry)) return null;
      return typeof entry.contentHash === "string" ? entry.contentHash : null;
    } catch {
      return null;
    }
  };
  const recordCacheEvidence = (
    beforeSourceHash: string | null,
    afterSourceHash: string | null,
    returnedSourceHash: string | null,
    cacheEntryCorrupted: boolean,
    sourceRequestCounts: ReadonlyArray<number> = traces.map(
      ({ sourceRequestCount }) => sourceRequestCount,
    ),
  ) => {
    cacheEvidence = {
      beforeSourceHash,
      afterSourceHash,
      returnedSourceHash,
      sourceRequestCounts,
      networkRequestCount: sourceRequests,
      validators,
      cacheEntryCorrupted,
    };
  };

  try {
    switch (category) {
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
          question: "Which requirements apply?",
          rfc: null,
          searchTerms: ["first term", "second term"],
        });
        traces.push(result.diagnostics.retrieval);
        const urls = result.diagnostics.retrieval.requests
          .filter(({ kind }) => kind === "metadata")
          .map(({ url }) => url);
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
          trace.uniqueCandidates === 40 &&
          trace.semanticCandidates === 32 &&
          trace.selectedSources === 8;
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
        const exits = result.diagnostics.retrieval.boundedExits ?? [];
        passed =
          result.status === "needs_review" &&
          exits.includes("relationship_limit") &&
          exits.includes("context_limit") &&
          exits.includes("depth_limit");
        break;
      }
      case "source_cache_miss": {
        const beforeHash = await cachedSourceHash();
        const result = await runKnown();
        recordCacheEvidence(beforeHash, await cachedSourceHash(), sourceHashFrom(result), false);
        passed = result.diagnostics.retrieval.sourceCacheOutcome === "miss";
        break;
      }
      case "source_cache_hit": {
        await runKnown();
        const beforeHash = await cachedSourceHash();
        const result = await runKnown();
        recordCacheEvidence(beforeHash, await cachedSourceHash(), sourceHashFrom(result), false);
        passed = result.diagnostics.retrieval.sourceCacheOutcome === "hit";
        break;
      }
      case "source_cache_revalidated":
      case "source_cache_replaced": {
        await runKnown();
        const beforeHash = await cachedSourceHash();
        now = 61_000;
        const result = await runKnown();
        recordCacheEvidence(beforeHash, await cachedSourceHash(), sourceHashFrom(result), false);
        passed =
          result.diagnostics.retrieval.sourceCacheOutcome ===
          (category === "source_cache_revalidated" ? "revalidated" : "replaced");
        break;
      }
      case "source_cache_repaired": {
        await runKnown();
        const beforeHash = await cachedSourceHash();
        await writeFile(join(cacheDirectory, "sources", "v2", "RFC9110.json"), "{corrupt");
        const result = await runKnown();
        recordCacheEvidence(beforeHash, await cachedSourceHash(), sourceHashFrom(result), true);
        passed = result.diagnostics.retrieval.sourceCacheOutcome === "repaired";
        break;
      }
      case "fail_closed_metadata":
        await runKnown();
        break;
      case "fail_closed_revalidation": {
        await runKnown();
        staleSourceHash = await cachedSourceHash();
        now = 61_000;
        await runKnown();
        break;
      }
    }
  } catch (error) {
    observedErrorKind = errorKind(error);
    if (category === "fail_closed_revalidation") {
      recordCacheEvidence(staleSourceHash, await cachedSourceHash(), null, false, [1, 1]);
    }
    passed =
      (category === "fail_closed_metadata" && observedErrorKind === "RfcDiscoveryError") ||
      (category === "fail_closed_revalidation" &&
        observedErrorKind === "RfcSourceRevalidationError");
  } finally {
    await client.close();
    await rm(cacheDirectory, { recursive: true, force: true });
  }

  return {
    schemaVersion: evaluationSchemaVersion,
    caseId: retrievalCase.id,
    category,
    seam: retrievalCase.seam,
    passed,
    traces,
    cacheEvidence,
    errorKind: passed ? observedErrorKind : (observedErrorKind ?? "RetrievalAssertionError"),
  };
};
