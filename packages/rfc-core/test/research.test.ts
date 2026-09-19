import { readdir, readFile, writeFile } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { Duration, Effect, Schema } from "effect";
import * as AiError from "effect/unstable/ai/AiError";
import * as DecisionModel from "effect/unstable/ai/DecisionModel";
import { TestClock } from "effect/testing";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import {
  EvidenceBundleSchema,
  RfcSourceCacheError,
  RfcSourceFetchError,
  RfcSourceServiceTag,
  createRfcClient as createCoreRfcClient,
  DecisionModelError,
  hashRfcSource,
  makeRfcSourceHttpLayer,
  parseSourceBlocks,
  type EvidenceBundle,
  type RfcClientOptions,
  type RfcSourceFetcher,
} from "../src/index";
import type * as Decision from "effect/unstable/ai/Decision";
import {
  createRfcCalibrationClient as createCalibrationRfcClient,
  type RfcCalibrationClientOptions,
} from "../src/internal-calibration";

const clients: Array<{ readonly close: () => Promise<void> }> = [];
type TestClientOptions = RfcCalibrationClientOptions;
const createRfcClient = (options: TestClientOptions) => createCalibrationRfcClient(options);

type ResearchResult = EvidenceBundle;
type CurrencyReport = NonNullable<ResearchResult["currency"]>;
type ContextDiagnostics = NonNullable<ResearchResult["diagnostics"]["contexts"]>;
type ContextSource = Extract<
  NonNullable<ResearchResult["diagnostics"]["sources"]>[number],
  { readonly context: string }
>;

const requireCurrency = (result: ResearchResult): CurrencyReport => {
  if (result.currency === undefined) throw new Error("Expected currency report");
  return result.currency;
};

const requireContextDiagnostics = (result: ResearchResult): ContextDiagnostics => {
  if (result.diagnostics.contexts === undefined) {
    throw new Error("Expected context diagnostics");
  }
  return result.diagnostics.contexts;
};

const requireContextSources = (result: ResearchResult): ReadonlyArray<ContextSource> => {
  const sources = result.diagnostics.sources;
  if (sources === undefined || !sources.every((source) => "context" in source)) {
    throw new Error("Expected context source diagnostics");
  }
  return sources as ReadonlyArray<ContextSource>;
};

const makeCacheDirectory = async () => mkdtemp(join(tmpdir(), "rfc-core-research-test-"));

const catalogDocument = {
  identifier: "RFC9110",
  rfcNumber: 9110,
  title: "HTTP Semantics",
  abstract: "HTTP semantics.",
  status: "published",
  stream: "ietf",
  canonicalUrl: "https://datatracker.ietf.org/doc/rfc9110/",
  updates: [],
  updatedBy: [],
  obsoletes: [],
  obsoletedBy: [],
};

const sourceText = [
  "Network Working Group",
  "Request for Comments: 9110",
  "",
  "1. Requirements",
  "",
  "The client MUST send a request containing the target resource.",
  "",
  "2. Background",
  "",
  "This section gives background context.",
  "",
].join("\n");

type TopicDecisionCall = {
  readonly definition: {
    readonly decisions: Readonly<Record<string, Decision.Any>>;
  };
  readonly input: {
    readonly question: string;
    readonly documents?: Readonly<
      Record<
        string,
        { readonly identifier: string; readonly title: string; readonly abstract: string }
      >
    >;
    readonly passages?: Readonly<
      Record<
        string,
        { readonly id: string; readonly section: string | null; readonly text: string }
      >
    >;
  };
};

type InspectableDecision = {
  readonly instructions: string;
  readonly criteria: Readonly<Record<string, string>>;
};

const makeCatalogDocument = (
  number: number,
  relationships: Readonly<Record<string, ReadonlyArray<string> | undefined>> = {},
) => ({
  ...catalogDocument,
  identifier: `RFC${number}`,
  rfcNumber: number,
  canonicalUrl: `https://datatracker.ietf.org/doc/rfc${number}/`,
  updates: relationships.updates ?? [],
  updatedBy: relationships.updatedBy ?? [],
  obsoletes: relationships.obsoletes ?? [],
  obsoletedBy: relationships.obsoletedBy ?? [],
});

const makeSourceMapFetcher =
  (sources: Readonly<Record<string, string>>, fetched: Array<string>): RfcSourceFetcher =>
  async (document) => {
    fetched.push(document.identifier);
    const text = sources[document.identifier];
    if (text === undefined) throw new Error(`Missing source for ${document.identifier}`);
    return {
      sourceUrl: `https://www.rfc-editor.org/rfc/rfc${document.rfcNumber}.txt`,
      text,
    };
  };

const makeDecisionModel = (
  calls: Array<unknown>,
  atomicity: "atomic" | "compound" = "atomic",
  relation:
    | "direct_answer"
    | "partial_answer"
    | "background_only"
    | "contradictory"
    | "irrelevant" = "direct_answer",
  relationProbability = 0.9,
  relationConfidence = 0.95,
  selectionProbability = 0.95,
  relationForCall:
    | ((
        call: number,
      ) => "direct_answer" | "partial_answer" | "background_only" | "contradictory" | "irrelevant")
    | undefined = undefined,
): DecisionModel.DecisionModel => {
  const model = {
    [DecisionModel.TypeId]: DecisionModel.TypeId,
    decide: (definition: { readonly decisions: Readonly<Record<string, Decision.Any>> }) => {
      calls.push(definition);
      const currentRelation = relationForCall?.(calls.length) ?? relation;
      const answers = Object.fromEntries(
        Object.entries(definition.decisions).map(([key, decision]) =>
          decision._tag === "Probability"
            ? [key, { probability: selectionProbability }]
            : "atomic" in decision.criteria
              ? [
                  key,
                  {
                    label: atomicity,
                    probabilities:
                      atomicity === "atomic"
                        ? { atomic: 0.95, compound: 0.05 }
                        : { atomic: 0.05, compound: 0.95 },
                    confidence: 0.95,
                  },
                ]
              : [
                  key,
                  {
                    label: currentRelation,
                    probabilities: {
                      direct_answer:
                        currentRelation === "direct_answer"
                          ? relationProbability
                          : (1 - relationProbability) / 4,
                      partial_answer:
                        currentRelation === "partial_answer"
                          ? relationProbability
                          : (1 - relationProbability) / 4,
                      background_only:
                        currentRelation === "background_only"
                          ? relationProbability
                          : (1 - relationProbability) / 4,
                      contradictory:
                        currentRelation === "contradictory"
                          ? relationProbability
                          : (1 - relationProbability) / 4,
                      irrelevant:
                        currentRelation === "irrelevant"
                          ? relationProbability
                          : (1 - relationProbability) / 4,
                    },
                    confidence: relationConfidence,
                  },
                ],
        ),
      );
      return Effect.succeed({
        answers,
        usage: { inputTokens: 12, outputTokens: 8 },
      });
    },
  } as unknown as DecisionModel.DecisionModel;
  return model;
};

const makeMixedRelationDecisionModel = (): DecisionModel.DecisionModel => {
  const model = {
    [DecisionModel.TypeId]: DecisionModel.TypeId,
    decide: (definition: { readonly decisions: Readonly<Record<string, Decision.Any>> }) => {
      const answers = Object.fromEntries(
        Object.entries(definition.decisions).map(([key, decision], index) => {
          if (decision._tag === "Probability") return [key, { probability: 0.95 }];
          if ("atomic" in decision.criteria) {
            return [
              key,
              {
                label: "atomic",
                probabilities: { atomic: 0.95, compound: 0.05 },
                confidence: 0.95,
              },
            ];
          }
          if (index === 0) {
            return [
              key,
              {
                label: "direct_answer",
                probabilities: {
                  direct_answer: 0.9,
                  partial_answer: 0.05,
                  background_only: 0.03,
                  contradictory: 0.01,
                  irrelevant: 0.01,
                },
                confidence: 0.95,
              },
            ];
          }
          return [
            key,
            {
              label: "partial_answer",
              probabilities: {
                direct_answer: 0.2,
                partial_answer: 0.4,
                background_only: 0.2,
                contradictory: 0.1,
                irrelevant: 0.1,
              },
              confidence: 0.4,
            },
          ];
        }),
      );
      return Effect.succeed({
        answers,
        usage: { inputTokens: 12, outputTokens: 8 },
      });
    },
  } as unknown as DecisionModel.DecisionModel;
  return model;
};

const makeUncertainRequestedDecisionModel = (): DecisionModel.DecisionModel => {
  let relationRequests = 0;
  const model = {
    [DecisionModel.TypeId]: DecisionModel.TypeId,
    decide: (definition: { readonly decisions: Readonly<Record<string, Decision.Any>> }) => {
      const hasAtomicity = Object.values(definition.decisions).some(
        (decision) => decision._tag !== "Probability" && "atomic" in decision.criteria,
      );
      if (!hasAtomicity) relationRequests += 1;
      const uncertain = relationRequests === 1;
      const answers = Object.fromEntries(
        Object.entries(definition.decisions).map(([key, decision]) => {
          if (decision._tag === "Probability") return [key, { probability: 0.95 }];
          if ("atomic" in decision.criteria) {
            return [
              key,
              {
                label: "atomic",
                probabilities: { atomic: 0.95, compound: 0.05 },
                confidence: 0.95,
              },
            ];
          }
          return [
            key,
            {
              label: "direct_answer",
              probabilities: uncertain
                ? {
                    direct_answer: 0.6,
                    partial_answer: 0.2,
                    background_only: 0.1,
                    contradictory: 0.05,
                    irrelevant: 0.05,
                  }
                : {
                    direct_answer: 0.9,
                    partial_answer: 0.05,
                    background_only: 0.03,
                    contradictory: 0.01,
                    irrelevant: 0.01,
                  },
              confidence: uncertain ? 0.6 : 0.95,
            },
          ];
        }),
      );
      return Effect.succeed({
        answers,
        usage: { inputTokens: 12, outputTokens: 8 },
      });
    },
  } as unknown as DecisionModel.DecisionModel;
  return model;
};

const makeSourceFetcher =
  (text: string): RfcSourceFetcher =>
  async () => ({
    sourceUrl: "https://www.rfc-editor.org/rfc/rfc9110.txt",
    text,
  });

const makeCurrentRfcDatatrackerClient = (): HttpClient.HttpClient =>
  HttpClient.make((request, url) =>
    Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        url.pathname.endsWith("/relateddocument/")
          ? Response.json({
              meta: { limit: 64, offset: 0, total_count: 0, next: null },
              objects: [],
            })
          : Response.json({
              name: "rfc9110",
              rfc_number: 9110,
              title: "HTTP Semantics",
              abstract: "HTTP semantics.",
              resource_uri: "/api/v1/doc/document/rfc9110/",
              stream: "/api/v1/name/streamname/ietf/",
              states: [],
            }),
      ),
    ),
  );

const makeTypeSafeHttpClient = (models: ReadonlyArray<string> = ["jev-1.13.0"]) => {
  let calls = 0;
  const client = HttpClient.make((request) => {
    calls += 1;
    const answers = Object.fromEntries([
      [
        "question_atomicity",
        {
          type: "choice",
          choice: "atomic",
          probabilities: { atomic: 0.99, compound: 0.01 },
          confidence: 0.99,
        },
      ],
      ...Array.from({ length: 8 }, (_, index) => [
        `passage_${index}`,
        (calls - 1) % 2 === 0
          ? { type: "noul", noul: 0.99 }
          : {
              type: "choice",
              choice: "direct_answer",
              probabilities: {
                direct_answer: 0.99,
                partial_answer: 0.005,
                background_only: 0.001,
                contradictory: 0.001,
                irrelevant: 0.003,
              },
              confidence: 0.99,
            },
      ]),
    ]);
    return Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        new Response(
          JSON.stringify({
            model: models[Math.min(Math.floor((calls - 1) / 2), models.length - 1)] ?? "jev-1.13.0",
            answers,
            usage: { input_tokens: 10, output_tokens: 6 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      ),
    );
  });
  return { client, calls: () => calls };
};

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
});

describe("known RFC research", () => {
  test("requires explicit activation before returning answered", async () => {
    const cacheDirectory = await makeCacheDirectory();
    // This deliberately uses the ordinary public constructor, not the private
    // calibration-only constructor used by the fixture helper below.
    const client = await createCoreRfcClient({
      cacheDirectory,
      modelAlias: "jev-test",
      policyPreset: "precision-v1",
      automaticAnswerActivation: undefined,
      typeSafeApiKey: undefined,
      typeSafeApiUrl: undefined,
      datatrackerHttpClient: makeCurrentRfcDatatrackerClient(),
      rfcSourceFetcher: makeSourceFetcher(sourceText),
      decisionModel: makeDecisionModel([]),
      now: () => Date.parse("2026-01-01T00:00:00.000Z"),
    });
    clients.push(client);

    const result = await client.research({
      schemaVersion: 2,
      question: "What must the client send?",
      rfc: "RFC9110",
      searchTerms: undefined,
    });

    expect(result.status).toBe("needs_review");
  });

  test("rejects a forged activation object even when its shape resembles the capability", async () => {
    const cacheDirectory = await makeCacheDirectory();
    const client = await createCoreRfcClient({
      cacheDirectory,
      modelAlias: "jev-test",
      policyPreset: "precision-v1",
      automaticAnswerActivation: {} as RfcClientOptions["automaticAnswerActivation"],
      typeSafeApiKey: undefined,
      typeSafeApiUrl: undefined,
      datatrackerHttpClient: makeCurrentRfcDatatrackerClient(),
      rfcSourceFetcher: makeSourceFetcher(sourceText),
      decisionModel: makeDecisionModel([]),
      now: () => Date.parse("2026-01-01T00:00:00.000Z"),
    });
    clients.push(client);

    const result = await client.research({
      schemaVersion: 2,
      question: "What must the client send?",
      rfc: "RFC9110",
      searchTerms: undefined,
    });

    expect(result.status).toBe("needs_review");
  });

  test("refreshes a missing catalog, caches source text, and runs two semantic stages", async () => {
    const cacheDirectory = await makeCacheDirectory();
    const calls: Array<unknown> = [];
    let sourceFetches = 0;
    const client = await createRfcClient({
      cacheDirectory,
      catalogPath: undefined,
      modelAlias: "jev-test",
      typeSafeApiKey: undefined,
      typeSafeApiUrl: undefined,
      catalogSource: async () => [catalogDocument],
      rfcSourceFetcher: async (document) => {
        sourceFetches += 1;
        expect(document.identifier).toBe("RFC9110");
        return makeSourceFetcher(sourceText)(document);
      },
      decisionModel: makeDecisionModel(calls),
      policyPreset: "precision-v1",
      now: () => Date.parse("2026-01-01T00:00:00.000Z"),
    });
    clients.push(client);

    const result = await client.research({
      schemaVersion: 1,
      question: "What must the client send?",
      rfc: "RFC9110",
    });

    expect(result.status).toBe("answered");
    expect(result.rfc?.identifier).toBe("RFC9110");
    expect(requireCurrency(result)).toEqual({
      requested: "RFC9110",
      current: ["RFC9110"],
      paths: [{ identifier: "RFC9110", path: [] }],
      complete: true,
      issues: [],
      unresolved: [],
      compatibility: [],
    });
    expect(result.contexts).toMatchObject([
      {
        role: "requested",
        document: { identifier: "RFC9110" },
        relationshipPath: [],
        isCurrent: true,
        state: "researched",
      },
    ]);
    expect(result.evidence).toHaveLength(1);
    const evidence = result.evidence[0];
    expect(evidence).toBeDefined();
    if (evidence === undefined) throw new Error("Expected evidence");
    expect(sourceText.slice(evidence.provenance.startOffset, evidence.provenance.endOffset)).toBe(
      evidence.quote,
    );
    expect(evidence.provenance.sourceHash).toBe(hashRfcSource(sourceText));
    expect(evidence.context).toBe("requested");
    expect(evidence.provenance.context).toBe("requested");
    expect(evidence.provenance.relationshipPath).toEqual([]);
    expect(evidence.provenance.section).toBe("1. Requirements");
    expect(result.diagnostics).toMatchObject({
      schemaVersion: 1,
      policyVersion: "precision-v1",
      requestedModel: "jev-test",
      resolvedModel: "jev-test",
      usage: { inputTokens: 24, outputTokens: 16 },
      atomicity: { label: "atomic", confidence: 0.95 },
      candidates: { selectedPassages: 1 },
    });
    expect(calls).toHaveLength(2);
    expect(sourceFetches).toBe(1);
    expect(Schema.decodeUnknownSync(EvidenceBundleSchema)(result)).toEqual(result);

    await client.research({
      schemaVersion: 1,
      question: "What must the client send?",
      rfc: "9110",
    });
    expect(sourceFetches).toBe(1);
    expect(calls).toHaveLength(4);
  });

  test("does not let an uncertain distractor suppress an activated direct answer", async () => {
    const cacheDirectory = await makeCacheDirectory();
    const source = [
      "1. Direct answer",
      "",
      "The client MUST send a request containing the target resource.",
      "",
      "2. Additional context",
      "",
      "The client sends the request to the server after selecting a target resource.",
    ].join("\n");
    const client = await createRfcClient({
      cacheDirectory,
      catalogPath: undefined,
      modelAlias: "jev-test",
      typeSafeApiKey: undefined,
      typeSafeApiUrl: undefined,
      catalogSource: async () => [catalogDocument],
      rfcSourceFetcher: makeSourceFetcher(source),
      decisionModel: makeMixedRelationDecisionModel(),
      now: () => Date.parse("2026-01-01T00:00:00.000Z"),
    });
    clients.push(client);

    const result = await client.research({
      schemaVersion: 1,
      question: "What must the client send?",
      rfc: "RFC9110",
    });

    expect(result.status).toBe("answered");
    expect(result.evidence).toHaveLength(1);
    expect(result.evidence[0]?.relation).toBe("direct_answer");
  });

  test("composes uncertain requested evidence with accepted current evidence as partial", async () => {
    const cacheDirectory = await makeCacheDirectory();
    const requested = makeCatalogDocument(9110, { updatedBy: ["RFC9111"] });
    const current = makeCatalogDocument(9111, { updates: ["RFC9110"] });
    const client = await createRfcClient({
      cacheDirectory,
      catalogPath: undefined,
      modelAlias: "jev-test",
      typeSafeApiKey: undefined,
      typeSafeApiUrl: undefined,
      catalogSource: async () => [requested, current],
      rfcSourceFetcher: makeSourceMapFetcher({ RFC9110: sourceText, RFC9111: sourceText }, []),
      decisionModel: makeUncertainRequestedDecisionModel(),
      now: () => Date.parse("2026-01-01T00:00:00.000Z"),
    });
    clients.push(client);

    const result = await client.research({
      schemaVersion: 1,
      question: "What must the client send?",
      rfc: "RFC9110",
    });

    expect(result.status).toBe("partial");
    expect(result.currency?.current).toEqual(["RFC9111"]);
  });

  test("researches the requested RFC and terminal current context across an update chain", async () => {
    const cacheDirectory = await makeCacheDirectory();
    const fetched: Array<string> = [];
    const requested = makeCatalogDocument(9110, { updatedBy: ["RFC9111"] });
    const intermediate = makeCatalogDocument(9111, {
      updates: ["RFC9110"],
      updatedBy: ["RFC9112"],
    });
    const current = makeCatalogDocument(9112, { updates: ["RFC9111"] });
    const client = await createRfcClient({
      cacheDirectory,
      catalogPath: undefined,
      modelAlias: "jev-test",
      typeSafeApiKey: undefined,
      typeSafeApiUrl: undefined,
      catalogSource: async () => [requested, intermediate, current],
      rfcSourceFetcher: makeSourceMapFetcher(
        {
          RFC9110: sourceText,
          RFC9112: sourceText.replaceAll("9110", "9112"),
        },
        fetched,
      ),
      decisionModel: makeDecisionModel([]),
      now: () => Date.parse("2026-01-01T00:00:00.000Z"),
    });
    clients.push(client);

    const result = await client.research({
      schemaVersion: 1,
      question: "What must the client send?",
      rfc: "RFC9110",
    });

    expect(result.status).toBe("answered");
    expect(fetched).toEqual(["RFC9110", "RFC9112"]);
    expect(requireCurrency(result)).toEqual({
      requested: "RFC9110",
      current: ["RFC9112"],
      paths: [
        { identifier: "RFC9110", path: [] },
        {
          identifier: "RFC9112",
          path: [
            { from: "RFC9110", to: "RFC9111", relationship: "updates" },
            { from: "RFC9111", to: "RFC9112", relationship: "updates" },
          ],
        },
      ],
      complete: true,
      issues: [],
      unresolved: [],
      compatibility: [{ requested: "RFC9110", current: "RFC9112", outcome: "compatible" }],
    });
    expect(result.evidence.map((passage) => passage.context)).toEqual(["requested", "current"]);
    expect(requireContextSources(result).map(({ context }) => context)).toEqual([
      "requested",
      "current",
    ]);
    expect(
      requireContextDiagnostics(result).map(({ identifier, state }) => ({ identifier, state })),
    ).toEqual([
      { identifier: "RFC9110", state: "researched" },
      { identifier: "RFC9112", state: "researched" },
    ]);
  });

  test("follows branching update relationships deterministically", async () => {
    const cacheDirectory = await makeCacheDirectory();
    const fetched: Array<string> = [];
    const requested = makeCatalogDocument(9110, { updatedBy: ["RFC9112", "RFC9111"] });
    const firstCurrent = makeCatalogDocument(9111, { updates: ["RFC9110"] });
    const secondCurrent = makeCatalogDocument(9112, { updates: ["RFC9110"] });
    const client = await createRfcClient({
      cacheDirectory,
      catalogPath: undefined,
      modelAlias: "jev-test",
      typeSafeApiKey: undefined,
      typeSafeApiUrl: undefined,
      catalogSource: async () => [secondCurrent, requested, firstCurrent],
      rfcSourceFetcher: makeSourceMapFetcher(
        {
          RFC9110: sourceText,
          RFC9111: sourceText.replaceAll("9110", "9111"),
          RFC9112: sourceText.replaceAll("9110", "9112"),
        },
        fetched,
      ),
      decisionModel: makeDecisionModel([]),
      now: () => Date.parse("2026-01-01T00:00:00.000Z"),
    });
    clients.push(client);

    const result = await client.research({
      schemaVersion: 1,
      question: "What must the client send?",
      rfc: "RFC9110",
    });

    expect(result.status).toBe("answered");
    expect(fetched).toEqual(["RFC9110", "RFC9111", "RFC9112"]);
    const currency = requireCurrency(result);
    expect(currency.current).toEqual(["RFC9111", "RFC9112"]);
    expect(currency.paths.slice(1)).toEqual([
      {
        identifier: "RFC9111",
        path: [{ from: "RFC9110", to: "RFC9111", relationship: "updates" }],
      },
      {
        identifier: "RFC9112",
        path: [{ from: "RFC9110", to: "RFC9112", relationship: "updates" }],
      },
    ]);
  });

  test("follows obsoletion branches without replacing the requested evidence", async () => {
    const cacheDirectory = await makeCacheDirectory();
    const fetched: Array<string> = [];
    const requested = makeCatalogDocument(9110, { obsoletedBy: ["RFC9111", "RFC9112"] });
    const firstCurrent = makeCatalogDocument(9111, { obsoletes: ["RFC9110"] });
    const secondCurrent = makeCatalogDocument(9112, { obsoletes: ["RFC9110"] });
    const client = await createRfcClient({
      cacheDirectory,
      catalogPath: undefined,
      modelAlias: "jev-test",
      typeSafeApiKey: undefined,
      typeSafeApiUrl: undefined,
      catalogSource: async () => [secondCurrent, requested, firstCurrent],
      rfcSourceFetcher: makeSourceMapFetcher(
        {
          RFC9110: sourceText,
          RFC9111: sourceText.replaceAll("9110", "9111"),
          RFC9112: sourceText.replaceAll("9110", "9112"),
        },
        fetched,
      ),
      decisionModel: makeDecisionModel([]),
      now: () => Date.parse("2026-01-01T00:00:00.000Z"),
    });
    clients.push(client);

    const result = await client.research({
      schemaVersion: 1,
      question: "What must the client send?",
      rfc: "RFC9110",
    });

    expect(result.status).toBe("answered");
    expect(fetched).toEqual(["RFC9110", "RFC9111", "RFC9112"]);
    const currency = requireCurrency(result);
    expect(currency.current).toEqual(["RFC9111", "RFC9112"]);
    expect(currency.paths).toEqual([
      { identifier: "RFC9110", path: [] },
      {
        identifier: "RFC9111",
        path: [{ from: "RFC9110", to: "RFC9111", relationship: "obsoletes" }],
      },
      {
        identifier: "RFC9112",
        path: [{ from: "RFC9110", to: "RFC9112", relationship: "obsoletes" }],
      },
    ]);
    expect(currency.compatibility).toEqual([
      { requested: "RFC9110", current: "RFC9111", outcome: "compatible" },
      { requested: "RFC9110", current: "RFC9112", outcome: "compatible" },
    ]);
    expect(result.evidence.map((passage) => passage.provenance.identifier)).toEqual([
      "RFC9110",
      "RFC9111",
      "RFC9112",
    ]);
  });

  test("returns partial when a known current successor cannot be fetched", async () => {
    const cacheDirectory = await makeCacheDirectory();
    const fetched: Array<string> = [];
    const requested = makeCatalogDocument(9110, { updatedBy: ["RFC9111"] });
    const current = makeCatalogDocument(9111, { updates: ["RFC9110"] });
    const client = await createRfcClient({
      cacheDirectory,
      catalogPath: undefined,
      modelAlias: "jev-test",
      typeSafeApiKey: undefined,
      typeSafeApiUrl: undefined,
      catalogSource: async () => [requested, current],
      rfcSourceFetcher: async (document) => {
        fetched.push(document.identifier);
        if (document.identifier === "RFC9111") throw new Error("successor unavailable");
        return {
          sourceUrl: "https://www.rfc-editor.org/rfc/rfc9110.txt",
          text: sourceText,
        };
      },
      decisionModel: makeDecisionModel([]),
      now: () => Date.parse("2026-01-01T00:00:00.000Z"),
    });
    clients.push(client);

    const result = await client.research({
      schemaVersion: 1,
      question: "What must the client send?",
      rfc: "RFC9110",
    });

    expect(result.status).toBe("partial");
    expect(fetched).toEqual(["RFC9110", "RFC9111"]);
    expect(requireCurrency(result)).toMatchObject({
      requested: "RFC9110",
      current: ["RFC9111"],
      complete: false,
      issues: ["missing_current_source"],
    });
    expect(result.contexts).toMatchObject([
      { role: "requested", state: "researched" },
      { role: "current", document: { identifier: "RFC9111" }, state: "unavailable" },
    ]);
    expect(result.evidence.every((passage) => passage.context === "requested")).toBe(true);
    expect(requireContextDiagnostics(result)[1]).toMatchObject({
      identifier: "RFC9111",
      state: "unavailable",
      status: null,
      source: null,
    });
  });

  test("fails closed and terminates on cyclic currency relationships", async () => {
    const cacheDirectory = await makeCacheDirectory();
    const fetched: Array<string> = [];
    const requested = makeCatalogDocument(9110, { updatedBy: ["RFC9111"] });
    const successor = makeCatalogDocument(9111, {
      updates: ["RFC9110"],
      updatedBy: ["RFC9110"],
    });
    const client = await createRfcClient({
      cacheDirectory,
      catalogPath: undefined,
      modelAlias: "jev-test",
      typeSafeApiKey: undefined,
      typeSafeApiUrl: undefined,
      catalogSource: async () => [requested, successor],
      rfcSourceFetcher: makeSourceMapFetcher(
        { RFC9110: sourceText, RFC9111: sourceText.replaceAll("9110", "9111") },
        fetched,
      ),
      decisionModel: makeDecisionModel([]),
      now: () => Date.parse("2026-01-01T00:00:00.000Z"),
    });
    clients.push(client);

    const result = await client.research({
      schemaVersion: 1,
      question: "What must the client send?",
      rfc: "RFC9110",
    });

    expect(result.status).toBe("needs_review");
    expect(fetched).toEqual(["RFC9110"]);
    const currency = requireCurrency(result);
    expect(currency.current).toEqual([]);
    expect(currency.complete).toBe(false);
    expect(currency.issues).toEqual(["cycle_detected", "missing_current_context"]);
  });

  test("detects cycles that cross a previously explored branch", async () => {
    const cacheDirectory = await makeCacheDirectory();
    const fetched: Array<string> = [];
    const requested = makeCatalogDocument(9110, { updatedBy: ["RFC9111", "RFC9112"] });
    const firstBranch = makeCatalogDocument(9111, {
      updates: ["RFC9110"],
      updatedBy: ["RFC9113"],
    });
    const secondBranch = makeCatalogDocument(9112, {
      updates: ["RFC9110", "RFC9113"],
      updatedBy: ["RFC9113"],
    });
    const crossBranch = makeCatalogDocument(9113, {
      updates: ["RFC9112"],
      updatedBy: ["RFC9112"],
    });
    const client = await createRfcClient({
      cacheDirectory,
      catalogPath: undefined,
      modelAlias: "jev-test",
      typeSafeApiKey: undefined,
      typeSafeApiUrl: undefined,
      catalogSource: async () => [crossBranch, secondBranch, requested, firstBranch],
      rfcSourceFetcher: makeSourceMapFetcher({ RFC9110: sourceText }, fetched),
      decisionModel: makeDecisionModel([]),
      now: () => Date.parse("2026-01-01T00:00:00.000Z"),
    });
    clients.push(client);

    const result = await client.research({
      schemaVersion: 1,
      question: "What must the client send?",
      rfc: "RFC9110",
    });

    expect(result.status).toBe("needs_review");
    expect(fetched).toEqual(["RFC9110"]);
    const currency = requireCurrency(result);
    expect(currency.current).toEqual([]);
    expect(currency.issues).toContain("cycle_detected");
    expect(currency.issues).toContain("missing_current_context");
  });

  test("fails closed when a current direct requirement changes the requested wording", async () => {
    const cacheDirectory = await makeCacheDirectory();
    const requested = makeCatalogDocument(9110, { updatedBy: ["RFC9111"] });
    const current = makeCatalogDocument(9111, { updates: ["RFC9110"] });
    const changedText = sourceText.replace(
      "The client MUST send a request containing the target resource.",
      "The client MUST NOT send a request containing the target resource.",
    );
    const client = await createRfcClient({
      cacheDirectory,
      catalogPath: undefined,
      modelAlias: "jev-test",
      typeSafeApiKey: undefined,
      typeSafeApiUrl: undefined,
      catalogSource: async () => [requested, current],
      rfcSourceFetcher: makeSourceMapFetcher({ RFC9110: sourceText, RFC9111: changedText }, []),
      decisionModel: makeDecisionModel([]),
      now: () => Date.parse("2026-01-01T00:00:00.000Z"),
    });
    clients.push(client);

    const result = await client.research({
      schemaVersion: 1,
      question: "What must the client send?",
      rfc: "RFC9110",
    });

    expect(result.status).toBe("needs_review");
    expect(requireCurrency(result).compatibility).toEqual([
      { requested: "RFC9110", current: "RFC9111", outcome: "conflicting" },
    ]);
  });

  test("reports a bounded traversal when the successor chain exceeds policy limits", async () => {
    const cacheDirectory = await makeCacheDirectory();
    const numbers = Array.from({ length: 10 }, (_, index) => 9000 + index);
    const documents = numbers.map((number, index) =>
      makeCatalogDocument(number, {
        updatedBy: index === numbers.length - 1 ? [] : [`RFC${number + 1}`],
        updates: index === 0 ? [] : [`RFC${number - 1}`],
      }),
    );
    const client = await createRfcClient({
      cacheDirectory,
      catalogPath: undefined,
      modelAlias: "jev-test",
      typeSafeApiKey: undefined,
      typeSafeApiUrl: undefined,
      catalogSource: async () => documents,
      rfcSourceFetcher: makeSourceMapFetcher({ RFC9000: sourceText }, []),
      decisionModel: makeDecisionModel([]),
      now: () => Date.parse("2026-01-01T00:00:00.000Z"),
    });
    clients.push(client);

    const result = await client.research({
      schemaVersion: 1,
      question: "What must the client send?",
      rfc: "RFC9000",
    });

    expect(result.status).toBe("needs_review");
    const currency = requireCurrency(result);
    expect(currency.current).toEqual([]);
    expect(currency.issues).toContain("traversal_limit");
  });

  test("fails closed when a current requirement weakens its normative modality", async () => {
    const cacheDirectory = await makeCacheDirectory();
    const requested = makeCatalogDocument(9110, { updatedBy: ["RFC9111"] });
    const current = makeCatalogDocument(9111, { updates: ["RFC9110"] });
    const weakenedText = sourceText.replace("The client MUST send", "The client MAY send");
    const client = await createRfcClient({
      cacheDirectory,
      catalogPath: undefined,
      modelAlias: "jev-test",
      typeSafeApiKey: undefined,
      typeSafeApiUrl: undefined,
      catalogSource: async () => [requested, current],
      rfcSourceFetcher: makeSourceMapFetcher({ RFC9110: sourceText, RFC9111: weakenedText }, []),
      decisionModel: makeDecisionModel([]),
      now: () => Date.parse("2026-01-01T00:00:00.000Z"),
    });
    clients.push(client);

    const result = await client.research({
      schemaVersion: 1,
      question: "What must the client send?",
      rfc: "RFC9110",
    });

    expect(result.status).toBe("needs_review");
    expect(requireCurrency(result).compatibility).toEqual([
      { requested: "RFC9110", current: "RFC9111", outcome: "conflicting" },
    ]);
  });

  test("fails closed when a current requirement changes a substantive parameter", async () => {
    const cacheDirectory = await makeCacheDirectory();
    const requested = makeCatalogDocument(9110, { updatedBy: ["RFC9111"] });
    const current = makeCatalogDocument(9111, { updates: ["RFC9110"] });
    const requestedText = sourceText.replace("a request containing the target resource", "X-Foo");
    const changedText = requestedText.replace("X-Foo", "X-Bar");
    const client = await createRfcClient({
      cacheDirectory,
      catalogPath: undefined,
      modelAlias: "jev-test",
      typeSafeApiKey: undefined,
      typeSafeApiUrl: undefined,
      catalogSource: async () => [requested, current],
      rfcSourceFetcher: makeSourceMapFetcher({ RFC9110: requestedText, RFC9111: changedText }, []),
      decisionModel: makeDecisionModel([]),
      now: () => Date.parse("2026-01-01T00:00:00.000Z"),
    });
    clients.push(client);

    const result = await client.research({
      schemaVersion: 1,
      question: "What must the client send?",
      rfc: "RFC9110",
    });

    expect(result.status).toBe("needs_review");
    expect(requireCurrency(result).compatibility).toEqual([
      { requested: "RFC9110", current: "RFC9111", outcome: "uncertain" },
    ]);
  });

  test("fails closed when a current requirement swaps subject and object roles", async () => {
    const cacheDirectory = await makeCacheDirectory();
    const requested = makeCatalogDocument(9110, { updatedBy: ["RFC9111"] });
    const current = makeCatalogDocument(9111, { updates: ["RFC9110"] });
    const requestedText = sourceText.replace(
      "a request containing the target resource",
      "X-Foo to the server",
    );
    const swappedText = requestedText
      .replace("The client MUST send", "The server MUST send")
      .replace("to the server", "to the client");
    const client = await createRfcClient({
      cacheDirectory,
      catalogPath: undefined,
      modelAlias: "jev-test",
      typeSafeApiKey: undefined,
      typeSafeApiUrl: undefined,
      catalogSource: async () => [requested, current],
      rfcSourceFetcher: makeSourceMapFetcher({ RFC9110: requestedText, RFC9111: swappedText }, []),
      decisionModel: makeDecisionModel([]),
      now: () => Date.parse("2026-01-01T00:00:00.000Z"),
    });
    clients.push(client);

    const result = await client.research({
      schemaVersion: 1,
      question: "What must the client send?",
      rfc: "RFC9110",
    });

    expect(result.status).toBe("needs_review");
    expect(requireCurrency(result).compatibility).toEqual([
      { requested: "RFC9110", current: "RFC9111", outcome: "uncertain" },
    ]);
  });

  test("returns needs_review when requested and current contexts conflict", async () => {
    const cacheDirectory = await makeCacheDirectory();
    const requested = makeCatalogDocument(9110, { updatedBy: ["RFC9111"] });
    const current = makeCatalogDocument(9111, { updates: ["RFC9110"] });
    const client = await createRfcClient({
      cacheDirectory,
      catalogPath: undefined,
      modelAlias: "jev-test",
      typeSafeApiKey: undefined,
      typeSafeApiUrl: undefined,
      catalogSource: async () => [requested, current],
      rfcSourceFetcher: makeSourceMapFetcher(
        { RFC9110: sourceText, RFC9111: sourceText.replaceAll("9110", "9111") },
        [],
      ),
      decisionModel: makeDecisionModel([], "atomic", "direct_answer", 0.9, 0.95, 0.95, (call) =>
        call === 4 ? "contradictory" : "direct_answer",
      ),
      now: () => Date.parse("2026-01-01T00:00:00.000Z"),
    });
    clients.push(client);

    const result = await client.research({
      schemaVersion: 1,
      question: "What must the client send?",
      rfc: "RFC9110",
    });

    expect(result.status).toBe("needs_review");
    expect(requireCurrency(result).complete).toBe(true);
    expect(result.evidence.map((passage) => [passage.context, passage.relation])).toEqual([
      ["requested", "direct_answer"],
      ["current", "contradictory"],
    ]);
  });

  test("does not claim current coverage for missing or malformed successors", async () => {
    const missingCacheDirectory = await makeCacheDirectory();
    const missingClient = await createRfcClient({
      cacheDirectory: missingCacheDirectory,
      catalogPath: undefined,
      modelAlias: "jev-test",
      typeSafeApiKey: undefined,
      typeSafeApiUrl: undefined,
      catalogSource: async () => [makeCatalogDocument(9110, { updatedBy: ["RFC9999"] })],
      rfcSourceFetcher: makeSourceMapFetcher({ RFC9110: sourceText }, []),
      decisionModel: makeDecisionModel([]),
      now: () => Date.parse("2026-01-01T00:00:00.000Z"),
    });
    clients.push(missingClient);

    const missing = await missingClient.research({
      schemaVersion: 1,
      question: "What must the client send?",
      rfc: "RFC9110",
    });

    expect(missing.status).toBe("partial");
    expect(missing.currency).toMatchObject({
      current: [],
      complete: false,
      issues: ["missing_successor", "missing_current_context"],
      unresolved: ["RFC9999"],
    });

    const malformedCacheDirectory = await makeCacheDirectory();
    const malformedClient = await createRfcClient({
      cacheDirectory: malformedCacheDirectory,
      catalogPath: undefined,
      modelAlias: "jev-test",
      typeSafeApiKey: undefined,
      typeSafeApiUrl: undefined,
      catalogSource: async () => [makeCatalogDocument(9110, { updatedBy: ["not-an-rfc"] })],
      rfcSourceFetcher: makeSourceMapFetcher({ RFC9110: sourceText }, []),
      decisionModel: makeDecisionModel([]),
      now: () => Date.parse("2026-01-01T00:00:00.000Z"),
    });
    clients.push(malformedClient);

    const malformed = await malformedClient.research({
      schemaVersion: 1,
      question: "What must the client send?",
      rfc: "RFC9110",
    });

    expect(malformed.status).toBe("needs_review");
    expect(malformed.currency).toMatchObject({
      current: [],
      complete: false,
      issues: ["malformed_relationship", "missing_current_context"],
    });
  });

  test("does not persist semantic inputs, judgments, or provider responses", async () => {
    const cacheDirectory = await makeCacheDirectory();
    const question = "PRIVACY_SENTINEL_question_must_not_be_cached";
    const model = makeDecisionModel([]);
    const providerResponseModel = {
      [DecisionModel.TypeId]: DecisionModel.TypeId,
      decide: (...args: Parameters<typeof model.decide>) =>
        model.decide(...args).pipe(
          Effect.map((response) => ({
            ...response,
            providerSecret: "PRIVACY_SENTINEL_provider_response_must_not_be_cached",
          })),
        ),
    } as unknown as DecisionModel.DecisionModel;
    const client = await createRfcClient({
      cacheDirectory,
      catalogPath: undefined,
      modelAlias: "jev-test",
      typeSafeApiKey: undefined,
      typeSafeApiUrl: undefined,
      catalogSource: async () => [catalogDocument],
      rfcSourceFetcher: makeSourceFetcher(sourceText),
      decisionModel: providerResponseModel,
      now: () => Date.parse("2026-01-01T00:00:00.000Z"),
    });
    clients.push(client);

    await client.research({ schemaVersion: 1, question, rfc: "RFC9110" });

    const sourceFiles = await readdir(join(cacheDirectory, "sources"));
    const persisted = await Promise.all([
      readFile(join(cacheDirectory, "catalog.json"), "utf8"),
      ...sourceFiles.map((file) => readFile(join(cacheDirectory, "sources", file), "utf8")),
    ]);
    const cacheContents = persisted.join("\\n");
    expect(cacheContents).not.toContain(question);
    expect(cacheContents).not.toContain("PRIVACY_SENTINEL_provider_response_must_not_be_cached");
    expect(cacheContents).not.toContain("direct_answer");
    expect(cacheContents).not.toContain("evidence_bundle");
  });

  test("records the provider-resolved model identifier", async () => {
    const cacheDirectory = await makeCacheDirectory();
    const typeSafe = makeTypeSafeHttpClient();
    const client = await createRfcClient({
      cacheDirectory,
      catalogPath: undefined,
      modelAlias: "jev-latest",
      typeSafeApiKey: undefined,
      typeSafeApiUrl: undefined,
      typeSafeHttpClient: typeSafe.client,
      catalogSource: async () => [catalogDocument],
      rfcSourceFetcher: makeSourceFetcher(sourceText),
      now: () => Date.parse("2026-01-01T00:00:00.000Z"),
    });
    clients.push(client);

    const result = await client.research({
      schemaVersion: 1,
      question: "What must the client send?",
      rfc: "9110",
    });

    expect(result.diagnostics.requestedModel).toBe("jev-latest");
    expect(result.diagnostics.resolvedModel).toBe("jev-1.13.0");
    expect(result.diagnostics.resolvedModels).toEqual(["jev-1.13.0", "jev-1.13.0"]);
    expect(typeSafe.calls()).toBe(2);
  });

  test("keeps resolved model diagnostics local to each research operation", async () => {
    const cacheDirectory = await makeCacheDirectory();
    const typeSafe = makeTypeSafeHttpClient(["jev-first", "jev-second"]);
    const client = await createRfcClient({
      cacheDirectory,
      catalogPath: undefined,
      modelAlias: "jev-latest",
      typeSafeApiKey: undefined,
      typeSafeApiUrl: undefined,
      typeSafeHttpClient: typeSafe.client,
      catalogSource: async () => [catalogDocument],
      rfcSourceFetcher: makeSourceFetcher(sourceText),
      now: () => Date.parse("2026-01-01T00:00:00.000Z"),
    });
    clients.push(client);

    const first = await client.research({
      schemaVersion: 1,
      question: "What must the client send?",
      rfc: "9110",
    });
    const second = await client.research({
      schemaVersion: 1,
      question: "What must the client send?",
      rfc: "9110",
    });

    expect(first.diagnostics.resolvedModels).toEqual(["jev-first", "jev-first"]);
    expect(second.diagnostics.resolvedModels).toEqual(["jev-second", "jev-second"]);
    expect(first.diagnostics.resolvedModel).toBe("jev-first");
    expect(second.diagnostics.resolvedModel).toBe("jev-second");
    expect(typeSafe.calls()).toBe(4);
  });

  test("returns needs_split for a confidently compound request", async () => {
    const cacheDirectory = await makeCacheDirectory();
    const calls: Array<unknown> = [];
    const client = await createRfcClient({
      cacheDirectory,
      catalogPath: undefined,
      modelAlias: "jev-test",
      typeSafeApiKey: undefined,
      typeSafeApiUrl: undefined,
      catalogSource: async () => [catalogDocument],
      rfcSourceFetcher: makeSourceFetcher(sourceText),
      decisionModel: makeDecisionModel(calls, "compound"),
      now: () => Date.parse("2026-01-01T00:00:00.000Z"),
    });
    clients.push(client);

    const result = await client.research({
      schemaVersion: 1,
      question: "What must the client send and what should the server cache?",
      rfc: "9110",
    });

    expect(result.status).toBe("needs_split");
    expect(result.evidence).toEqual([]);
    expect(result.diagnostics.atomicity.label).toBe("compound");
    expect(calls).toHaveLength(1);
  });

  test("returns unsupported when every passage candidate is confidently negative", async () => {
    const cacheDirectory = await makeCacheDirectory();
    const client = await createRfcClient({
      cacheDirectory,
      catalogPath: undefined,
      modelAlias: "jev-test",
      typeSafeApiKey: undefined,
      typeSafeApiUrl: undefined,
      catalogSource: async () => [catalogDocument],
      rfcSourceFetcher: makeSourceFetcher(sourceText),
      decisionModel: makeDecisionModel([], "atomic", "irrelevant", 0.9, 0.95, 0.1),
      now: () => Date.parse("2026-01-01T00:00:00.000Z"),
    });
    clients.push(client);

    const result = await client.research({
      schemaVersion: 1,
      question: "What does the server cache?",
      rfc: "RFC9110",
    });

    expect(result.status).toBe("unsupported");
    expect(result.evidence).toEqual([]);
    expect(result.diagnostics.selection).toEqual([{ candidateId: "block-1", probability: 0.1 }]);
    expect(result.diagnostics.classification).toEqual([]);
  });

  test("judges a borderline selected passage before classifying unsupported", async () => {
    const cacheDirectory = await makeCacheDirectory();
    const client = await createRfcClient({
      cacheDirectory,
      catalogPath: undefined,
      modelAlias: "jev-test",
      typeSafeApiKey: undefined,
      typeSafeApiUrl: undefined,
      catalogSource: async () => [catalogDocument],
      rfcSourceFetcher: makeSourceFetcher(sourceText),
      decisionModel: makeDecisionModel([], "atomic", "irrelevant", 0.9, 0.95, 0.45),
      now: () => Date.parse("2026-01-01T00:00:00.000Z"),
    });
    clients.push(client);

    const result = await client.research({
      schemaVersion: 1,
      question: "What does the server cache?",
      rfc: "RFC9110",
    });

    expect(result.status).toBe("unsupported");
    expect(result.diagnostics.classification).toHaveLength(1);
  });

  test("returns needs_review when a negative relation is low confidence", async () => {
    const cacheDirectory = await makeCacheDirectory();
    const client = await createRfcClient({
      cacheDirectory,
      catalogPath: undefined,
      modelAlias: "jev-test",
      typeSafeApiKey: undefined,
      typeSafeApiUrl: undefined,
      catalogSource: async () => [catalogDocument],
      rfcSourceFetcher: makeSourceFetcher(sourceText),
      decisionModel: makeDecisionModel([], "atomic", "irrelevant", 0.9, 0.5),
      now: () => Date.parse("2026-01-01T00:00:00.000Z"),
    });
    clients.push(client);

    const result = await client.research({
      schemaVersion: 1,
      question: "What does the server cache?",
      rfc: "RFC9110",
    });

    expect(result.status).toBe("needs_review");
  });

  test("rejects invalid provider probability distributions as typed failures", async () => {
    const cacheDirectory = await makeCacheDirectory();
    const model = {
      [DecisionModel.TypeId]: DecisionModel.TypeId,
      decide: (definition: { readonly decisions: Readonly<Record<string, Decision.Any>> }) => {
        const answers = Object.fromEntries(
          Object.entries(definition.decisions).map(([key, decision]) =>
            decision._tag === "Probability"
              ? [key, { probability: 0.1 }]
              : "atomic" in decision.criteria
                ? [
                    key,
                    {
                      label: "atomic",
                      probabilities: { atomic: 0.8, compound: 0.1 },
                      confidence: 0.95,
                    },
                  ]
                : [
                    key,
                    {
                      label: "background_only",
                      probabilities: {
                        direct_answer: 0.05,
                        partial_answer: 0.05,
                        background_only: 0.8,
                        contradictory: 0.05,
                        irrelevant: 0.05,
                      },
                      confidence: 0.95,
                    },
                  ],
          ),
        );
        return Effect.succeed({
          answers,
          usage: { inputTokens: 1, outputTokens: 1 },
        });
      },
    } as unknown as DecisionModel.DecisionModel;
    const client = await createRfcClient({
      cacheDirectory,
      catalogPath: undefined,
      modelAlias: "jev-test",
      typeSafeApiKey: undefined,
      typeSafeApiUrl: undefined,
      catalogSource: async () => [catalogDocument],
      rfcSourceFetcher: makeSourceFetcher(sourceText),
      decisionModel: model,
      now: () => Date.parse("2026-01-01T00:00:00.000Z"),
    });
    clients.push(client);

    await expect(
      client.research({
        schemaVersion: 1,
        question: "What must the client send?",
        rfc: "RFC9110",
      }),
    ).rejects.toBeInstanceOf(DecisionModelError);
  });

  test("retries retryable provider errors and succeeds without retrying non-retryable errors", async () => {
    const cacheDirectory = await makeCacheDirectory();
    const successful = makeDecisionModel([]);
    let attempts = 0;
    const model = {
      [DecisionModel.TypeId]: DecisionModel.TypeId,
      decide: (...args: Parameters<typeof successful.decide>) => {
        attempts += 1;
        if (attempts === 1) {
          return Effect.fail(
            AiError.make({
              module: "test",
              method: "decide",
              reason: new AiError.RateLimitError({ retryAfter: Duration.millis(0) }),
            }),
          );
        }
        return successful.decide(...args);
      },
    } as unknown as DecisionModel.DecisionModel;
    const client = await createRfcClient({
      cacheDirectory,
      catalogPath: undefined,
      modelAlias: "jev-test",
      typeSafeApiKey: undefined,
      typeSafeApiUrl: undefined,
      catalogSource: async () => [catalogDocument],
      rfcSourceFetcher: makeSourceFetcher(sourceText),
      decisionModel: model,
      now: () => Date.parse("2026-01-01T00:00:00.000Z"),
    });
    clients.push(client);

    await expect(
      client.research({
        schemaVersion: 1,
        question: "What must the client send?",
        rfc: "RFC9110",
      }),
    ).resolves.toMatchObject({ status: "answered" });
    expect(attempts).toBe(3);

    const nonRetryingCacheDirectory = await makeCacheDirectory();
    let nonRetryingAttempts = 0;
    const nonRetryingModel = {
      [DecisionModel.TypeId]: DecisionModel.TypeId,
      decide: (..._args: Parameters<typeof successful.decide>) => {
        nonRetryingAttempts += 1;
        return Effect.fail(
          AiError.make({
            module: "test",
            method: "decide",
            reason: new AiError.InvalidRequestError({ description: "bad request" }),
          }),
        );
      },
    } as unknown as DecisionModel.DecisionModel;
    const nonRetryingClient = await createRfcClient({
      cacheDirectory: nonRetryingCacheDirectory,
      catalogPath: undefined,
      modelAlias: "jev-test",
      typeSafeApiKey: undefined,
      typeSafeApiUrl: undefined,
      catalogSource: async () => [catalogDocument],
      rfcSourceFetcher: makeSourceFetcher(sourceText),
      decisionModel: nonRetryingModel,
      now: () => Date.parse("2026-01-01T00:00:00.000Z"),
    });
    clients.push(nonRetryingClient);

    await expect(
      nonRetryingClient.research({
        schemaVersion: 1,
        question: "What must the client send?",
        rfc: "RFC9110",
      }),
    ).rejects.toBeInstanceOf(DecisionModelError);
    expect(nonRetryingAttempts).toBe(1);
  });

  test("stops before a retry that would exceed the elapsed-time budget", async () => {
    const cacheDirectory = await makeCacheDirectory();
    const successful = makeDecisionModel([]);
    let attempts = 0;
    const model = {
      [DecisionModel.TypeId]: DecisionModel.TypeId,
      decide: (..._args: Parameters<typeof successful.decide>) => {
        attempts += 1;
        return Effect.fail(
          AiError.make({
            module: "test",
            method: "decide",
            reason: new AiError.RateLimitError({ retryAfter: Duration.seconds(60) }),
          }),
        );
      },
    } as unknown as DecisionModel.DecisionModel;
    const client = await createRfcClient({
      cacheDirectory,
      catalogPath: undefined,
      modelAlias: "jev-test",
      typeSafeApiKey: undefined,
      typeSafeApiUrl: undefined,
      catalogSource: async () => [catalogDocument],
      rfcSourceFetcher: makeSourceFetcher(sourceText),
      decisionModel: model,
      now: () => Date.parse("2026-01-01T00:00:00.000Z"),
    });
    clients.push(client);

    await expect(
      client.research({
        schemaVersion: 1,
        question: "What must the client send?",
        rfc: "RFC9110",
      }),
    ).rejects.toMatchObject({
      _tag: "DecisionModelError",
      reason: expect.stringContaining("retry"),
    });
    expect(attempts).toBe(1);
  });

  test("times out a never-completing provider attempt at the elapsed-time budget", async () => {
    const cacheDirectory = await makeCacheDirectory();
    const clock = await Effect.runPromise(
      Effect.scoped(TestClock.make({ warningDelay: Duration.seconds(30) })),
    );
    let attempts = 0;
    let startedResolve: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      startedResolve = resolve;
    });
    const successful = makeDecisionModel([]);
    const model = {
      [DecisionModel.TypeId]: DecisionModel.TypeId,
      decide: (..._args: Parameters<typeof successful.decide>) => {
        attempts += 1;
        startedResolve?.();
        return Effect.never;
      },
    } as unknown as DecisionModel.DecisionModel;
    const client = await createRfcClient({
      cacheDirectory,
      catalogPath: undefined,
      modelAlias: "jev-test",
      typeSafeApiKey: undefined,
      typeSafeApiUrl: undefined,
      catalogSource: async () => [catalogDocument],
      rfcSourceFetcher: makeSourceFetcher(sourceText),
      decisionModel: model,
      clock,
    });
    clients.push(client);

    const research = client.research({
      schemaVersion: 1,
      question: "What must the client send?",
      rfc: "RFC9110",
    });
    const researchOutcome = research.then(
      () => ({ kind: "success" as const }),
      (error) => ({ kind: "error" as const, error }),
    );
    const startedInTime = await Promise.race([
      started.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 250)),
    ]);
    expect(startedInTime).toBe(true);
    if (!startedInTime) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
    await Effect.runPromise(clock.adjust(Duration.seconds(10)));
    const outcome = await Promise.race([
      researchOutcome,
      new Promise<{ readonly kind: "guard" }>((resolve) =>
        setTimeout(() => resolve({ kind: "guard" }), 250),
      ),
    ]);

    expect(outcome.kind).toBe("error");
    if (outcome.kind === "error") {
      expect(outcome.error).toMatchObject({
        _tag: "DecisionModelError",
        stage: "selection",
        reason: expect.stringContaining("elapsed-time budget"),
        attempts: 1,
      });
    }
    expect(attempts).toBe(1);
  });

  test("fails with a typed provider error after retry exhaustion", async () => {
    const cacheDirectory = await makeCacheDirectory();
    const successful = makeDecisionModel([]);
    let attempts = 0;
    const model = {
      [DecisionModel.TypeId]: DecisionModel.TypeId,
      decide: (..._args: Parameters<typeof successful.decide>) => {
        attempts += 1;
        return Effect.fail(
          AiError.make({
            module: "test",
            method: "decide",
            reason: new AiError.InternalProviderError({ description: "temporarily unavailable" }),
          }),
        );
      },
    } as unknown as DecisionModel.DecisionModel;
    const client = await createRfcClient({
      cacheDirectory,
      catalogPath: undefined,
      modelAlias: "jev-test",
      typeSafeApiKey: undefined,
      typeSafeApiUrl: undefined,
      catalogSource: async () => [catalogDocument],
      rfcSourceFetcher: makeSourceFetcher(sourceText),
      decisionModel: model,
      now: () => Date.parse("2026-01-01T00:00:00.000Z"),
    });
    clients.push(client);

    await expect(
      client.research({
        schemaVersion: 1,
        question: "What must the client send?",
        rfc: "RFC9110",
      }),
    ).rejects.toMatchObject({
      _tag: "DecisionModelError",
      reason: expect.stringContaining("retry"),
    });
    expect(attempts).toBe(3);
  });

  test("fails closed for partial, unsupported, uncertain, and contradictory evidence", async () => {
    const cases = [
      {
        relation: "partial_answer" as const,
        probability: 0.9,
        confidence: 0.95,
        status: "partial",
      },
      {
        relation: "background_only" as const,
        probability: 0.9,
        confidence: 0.95,
        status: "unsupported",
      },
      {
        relation: "direct_answer" as const,
        probability: 0.5,
        confidence: 0.5,
        status: "needs_review",
      },
      {
        relation: "contradictory" as const,
        probability: 0.9,
        confidence: 0.95,
        status: "needs_review",
      },
    ] as const;

    for (const testCase of cases) {
      const cacheDirectory = await makeCacheDirectory();
      const client = await createRfcClient({
        cacheDirectory,
        catalogPath: undefined,
        modelAlias: "jev-test",
        typeSafeApiKey: undefined,
        typeSafeApiUrl: undefined,
        catalogSource: async () => [catalogDocument],
        rfcSourceFetcher: makeSourceFetcher(sourceText),
        decisionModel: makeDecisionModel(
          [],
          "atomic",
          testCase.relation,
          testCase.probability,
          testCase.confidence,
        ),
        now: () => Date.parse("2026-01-01T00:00:00.000Z"),
      });
      clients.push(client);

      const result = await client.research({
        schemaVersion: 1,
        question: "What must the client send?",
        rfc: "9110",
      });

      expect(result.status).toBe(testCase.status);
    }
  });

  test("refreshes a stale catalog before known-RFC research", async () => {
    const cacheDirectory = await makeCacheDirectory();
    await writeFile(
      join(cacheDirectory, "catalog.json"),
      JSON.stringify({
        schemaVersion: 1,
        kind: "rfc_catalog",
        cacheIdentity: "rfc-catalog-v1",
        fetchedAt: "2026-01-01T00:00:00.000Z",
        documents: [catalogDocument],
      }),
    );
    let refreshes = 0;
    const client = await createRfcClient({
      cacheDirectory,
      catalogPath: undefined,
      modelAlias: "jev-test",
      typeSafeApiKey: undefined,
      typeSafeApiUrl: undefined,
      catalogSource: async () => {
        refreshes += 1;
        return [catalogDocument];
      },
      rfcSourceFetcher: makeSourceFetcher(sourceText),
      decisionModel: makeDecisionModel([]),
      now: () => Date.parse("2026-01-09T00:00:01.000Z"),
    });
    clients.push(client);

    const result = await client.research({
      schemaVersion: 1,
      question: "What must the client send?",
      rfc: "9110",
    });

    expect(result.status).toBe("answered");
    expect(refreshes).toBe(1);
    expect(result.diagnostics.catalog?.state).toBe("fresh");
  });

  test("fetches RFC Editor plain text through the dedicated source HTTP client", async () => {
    const cacheDirectory = await makeCacheDirectory();
    const requests: Array<string> = [];
    const sourceHttpClient = HttpClient.make((request, url) => {
      requests.push(url.toString());
      return Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          new Response(sourceText, { headers: { "content-type": "text/plain; charset=utf-8" } }),
        ),
      );
    });
    const client = await createRfcClient({
      cacheDirectory,
      catalogPath: undefined,
      modelAlias: "jev-test",
      typeSafeApiKey: undefined,
      typeSafeApiUrl: undefined,
      catalogSource: async () => [catalogDocument],
      decisionModel: makeDecisionModel([]),
      rfcSourceHttpClient: sourceHttpClient,
      now: () => Date.parse("2026-01-01T00:00:00.000Z"),
    });
    clients.push(client);

    const result = await client.research({
      schemaVersion: 1,
      question: "What must the client send?",
      rfc: "9110",
    });

    expect(result.status).toBe("answered");
    expect(requests).toEqual(["https://www.rfc-editor.org/rfc/rfc9110.txt"]);
  });

  test("rejects a noncanonical RFC Editor source path before HTTP", async () => {
    let requests = 0;
    const sourceHttpClient = HttpClient.make((request) => {
      requests += 1;
      return Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          new Response(sourceText, { headers: { "content-type": "text/plain" } }),
        ),
      );
    });
    const program = Effect.gen(function* () {
      const service = yield* RfcSourceServiceTag;
      return yield* service.fetch(catalogDocument);
    }).pipe(
      Effect.provide(
        makeRfcSourceHttpLayer(sourceHttpClient, "https://www.rfc-editor.org/rfc/substituted/"),
      ),
    );

    await expect(Effect.runPromise(program)).rejects.toBeInstanceOf(RfcSourceFetchError);
    expect(requests).toBe(0);
  });

  test("rejects a substituted final RFC Editor response URL", async () => {
    const cacheDirectory = await makeCacheDirectory();
    const sourceHttpClient = HttpClient.make((request) => {
      const response = new Response(sourceText, { headers: { "content-type": "text/plain" } });
      Object.defineProperty(response, "url", {
        value: "https://www.rfc-editor.org/rfc/rfc9999.txt",
      });
      return Effect.succeed(HttpClientResponse.fromWeb(request, response));
    });
    const client = await createRfcClient({
      cacheDirectory,
      catalogPath: undefined,
      modelAlias: "jev-test",
      typeSafeApiKey: undefined,
      typeSafeApiUrl: undefined,
      catalogSource: async () => [catalogDocument],
      decisionModel: makeDecisionModel([]),
      rfcSourceHttpClient: sourceHttpClient,
      now: () => Date.parse("2026-01-01T00:00:00.000Z"),
    });
    clients.push(client);

    await expect(
      client.research({
        schemaVersion: 1,
        question: "What must the client send?",
        rfc: "9110",
      }),
    ).rejects.toBeInstanceOf(RfcSourceFetchError);
  });

  test("rejects a corrupted content-addressed source cache", async () => {
    const cacheDirectory = await makeCacheDirectory();
    const client = await createRfcClient({
      cacheDirectory,
      catalogPath: undefined,
      modelAlias: undefined,
      typeSafeApiKey: undefined,
      typeSafeApiUrl: undefined,
      catalogSource: async () => [catalogDocument],
      rfcSourceFetcher: makeSourceFetcher(sourceText),
      decisionModel: makeDecisionModel([]),
      now: () => Date.parse("2026-01-01T00:00:00.000Z"),
    });
    clients.push(client);

    await client.research({
      schemaVersion: 1,
      question: "What must the client send?",
      rfc: "9110",
    });
    const sourceFiles = await readdir(join(cacheDirectory, "sources"));
    const contentFile = sourceFiles.find((file) => file.length > 10 && !file.startsWith("RFC"));
    expect(contentFile).toBeDefined();
    if (contentFile === undefined) throw new Error("Expected content-addressed source file");
    const contentPath = join(cacheDirectory, "sources", contentFile);
    const content = JSON.parse(await readFile(contentPath, "utf8")) as { readonly text: string };
    await writeFile(contentPath, JSON.stringify({ ...content, text: "tampered" }));

    await expect(
      client.research({ schemaVersion: 1, question: "What must the client send?", rfc: "9110" }),
    ).rejects.toBeInstanceOf(RfcSourceCacheError);
  });

  test("keeps oversized source-block overlap bounded and exact", () => {
    const text = `1. Requirements\n\n${"x".repeat(4_200)}\nThe client MUST send a request.\n`;
    const blocks = parseSourceBlocks(text);
    expect(blocks.length).toBeGreaterThan(1);
    expect(blocks[1]?.startOffset).toBe(blocks[0]?.endOffset - 200);
    expect(blocks[1]?.startOffset).toBeGreaterThanOrEqual(0);
    for (const block of blocks) {
      expect(block.endOffset - block.startOffset).toBeLessThanOrEqual(4_000);
      expect(text.slice(block.startOffset, block.endOffset)).toBe(block.text);
    }
  });

  test("keeps exact offsets valid when a source has no recoverable section headings", async () => {
    const cacheDirectory = await makeCacheDirectory();
    const text = "An irregular RFC body states that clients send requests.\n";
    const client = await createRfcClient({
      cacheDirectory,
      catalogPath: undefined,
      modelAlias: undefined,
      typeSafeApiKey: undefined,
      typeSafeApiUrl: undefined,
      catalogSource: async () => [catalogDocument],
      rfcSourceFetcher: makeSourceFetcher(text),
      decisionModel: makeDecisionModel([]),
      now: () => Date.parse("2026-01-01T00:00:00.000Z"),
    });
    clients.push(client);

    const result = await client.research({
      schemaVersion: 1,
      question: "What do clients send?",
      rfc: "RFC9110",
    });
    const evidence = result.evidence[0];
    expect(evidence?.provenance.section).toBeNull();
    const sourceBytes = new TextEncoder().encode(text);
    expect(
      evidence === undefined
        ? ""
        : new TextDecoder().decode(
            sourceBytes.slice(evidence.provenance.startOffset, evidence.provenance.endOffset),
          ),
    ).toBe(evidence?.quote);
  });

  test("discovers a topic across the fresh catalog and uses three semantic stages", async () => {
    const cacheDirectory = await makeCacheDirectory();
    const secondDocument = {
      ...catalogDocument,
      identifier: "RFC7230",
      rfcNumber: 7230,
      title: "HTTP/1.1 Message Syntax and Routing",
      abstract: "HTTP message syntax and routing.",
      canonicalUrl: "https://datatracker.ietf.org/doc/rfc7230/",
    };
    const calls: Array<unknown> = [];
    const fetched: Array<string> = [];
    const model = {
      [DecisionModel.TypeId]: DecisionModel.TypeId,
      decide: (
        definition: { readonly decisions: Readonly<Record<string, Decision.Any>> },
        options: { readonly input: TopicDecisionCall["input"] },
      ) => {
        calls.push({ definition, input: options.input });
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
            if (decision._tag === "Probability") {
              return [key, { probability: options.input.documents === undefined ? 0.95 : 0.35 }];
            }
            return [
              key,
              {
                label: "direct_answer",
                probabilities: {
                  direct_answer: 0.99,
                  partial_answer: 0.005,
                  background_only: 0.001,
                  contradictory: 0.001,
                  irrelevant: 0.003,
                },
                confidence: 0.99,
              },
            ];
          }),
        );
        return Effect.succeed({
          answers,
          usage: { inputTokens: 10, outputTokens: 6 },
        });
      },
    } as unknown as DecisionModel.DecisionModel;
    const client = await createRfcClient({
      cacheDirectory,
      catalogPath: undefined,
      modelAlias: "jev-topic-test",
      typeSafeApiKey: undefined,
      typeSafeApiUrl: undefined,
      catalogSource: async () => [catalogDocument, secondDocument],
      rfcSourceFetcher: async (document) => {
        fetched.push(document.identifier);
        return {
          sourceUrl: `https://www.rfc-editor.org/rfc/rfc${document.rfcNumber}.txt`,
          text: `1. Requirements\n\nThe HTTP client MUST send a request.\n`,
        };
      },
      decisionModel: model,
      now: () => Date.parse("2026-01-01T00:00:00.000Z"),
    });
    clients.push(client);

    const result = await client.research({
      schemaVersion: 1,
      question: "What must an HTTP client send?",
      rfc: null,
    });

    expect(result.status).toBe("answered");
    expect(result.rfc?.identifier).toBe(fetched[0]);
    expect(result.evidence).toHaveLength(2);
    expect(result.evidence.every((passage) => passage.quote.includes("MUST send"))).toBe(true);
    expect(fetched).toHaveLength(2);
    expect(new Set(fetched)).toEqual(new Set(["RFC9110", "RFC7230"]));
    expect(calls).toHaveLength(3);

    const topicCalls = calls as Array<TopicDecisionCall>;
    const documentCall = topicCalls[0];
    const documentInputs = documentCall?.input.documents ?? {};
    expect(Object.keys(documentInputs)).toEqual(["document_0", "document_1"]);
    for (const [key, inputDocument] of Object.entries(documentInputs)) {
      const expectedDocument = [catalogDocument, secondDocument].find(
        ({ identifier }) => identifier === inputDocument.identifier,
      );
      const decision = documentCall?.definition.decisions[key] as InspectableDecision | undefined;
      expect(expectedDocument).toBeDefined();
      expect(decision?.instructions).toContain(`candidate ${key}`);
      expect(decision?.instructions).toContain(`input.documents["${key}"]`);
      expect(decision?.instructions).toContain(inputDocument.identifier);
      expect(decision?.instructions).toContain(inputDocument.title);
      expect(decision?.instructions).toContain(inputDocument.abstract);
      expect(decision?.criteria.true).toContain(inputDocument.identifier);
    }

    for (const call of [topicCalls[1], topicCalls[2]]) {
      const passageInputs = call?.input.passages ?? {};
      expect(Object.keys(passageInputs)).toEqual(["passage_0", "passage_1"]);
      for (const [key, inputPassage] of Object.entries(passageInputs)) {
        const decision = call?.definition.decisions[key] as InspectableDecision | undefined;
        expect(decision?.instructions).toContain(`candidate ${key}`);
        expect(decision?.instructions).toContain(`input.passages["${key}"].text`);
        expect(decision?.instructions).toContain(inputPassage.id);
        expect(inputPassage.text).toContain("MUST send a request");
        expect(decision?.criteria).toBeDefined();
        expect(Object.values(decision?.criteria ?? {}).join(" ")).toContain(inputPassage.id);
      }
    }

    expect(result.diagnostics.candidates).toMatchObject({
      documentCandidates: 2,
      acceptedDocuments: 2,
      selectedPassages: 2,
    });
    expect(result.diagnostics.documentSelection).toHaveLength(2);
    expect(result.diagnostics.documentSelection?.map(({ probability }) => probability)).toEqual([
      0.35, 0.35,
    ]);
    expect(result.diagnostics.timings.documentMs).toBeGreaterThanOrEqual(0);
  });

  test("bounds lexical document flow and rejects irrelevant catalog matches semantically", async () => {
    const cacheDirectory = await makeCacheDirectory();
    const documents = [
      catalogDocument,
      ...Array.from({ length: 19 }, (_, index) => ({
        ...catalogDocument,
        identifier: `RFC${8000 + index}`,
        rfcNumber: 8000 + index,
        title: `HTTP topic ${index}`,
        abstract: "HTTP topic background.",
        canonicalUrl: `https://datatracker.ietf.org/doc/rfc${8000 + index}/`,
      })),
    ];
    const documentBatchSizes: Array<number> = [];
    const fetched: Array<string> = [];
    const model = {
      [DecisionModel.TypeId]: DecisionModel.TypeId,
      decide: (
        definition: { readonly decisions: Readonly<Record<string, Decision.Any>> },
        options: {
          readonly input: TopicDecisionCall["input"];
        },
      ) => {
        if (options.input.documents !== undefined) {
          documentBatchSizes.push(Object.keys(options.input.documents).length);
        }
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
            if (decision._tag === "Probability") {
              const identifier = options.input.documents?.[key]?.identifier;
              return [
                key,
                {
                  probability:
                    options.input.documents === undefined
                      ? 0.95
                      : identifier === "RFC9110"
                        ? 0.95
                        : 0.1,
                },
              ];
            }
            return [
              key,
              {
                label: "direct_answer",
                probabilities: {
                  direct_answer: 0.99,
                  partial_answer: 0.005,
                  background_only: 0.001,
                  contradictory: 0.001,
                  irrelevant: 0.003,
                },
                confidence: 0.99,
              },
            ];
          }),
        );
        return Effect.succeed({ answers, usage: { inputTokens: 4, outputTokens: 2 } });
      },
    } as unknown as DecisionModel.DecisionModel;
    const client = await createRfcClient({
      cacheDirectory,
      catalogPath: undefined,
      modelAlias: "jev-topic-test",
      typeSafeApiKey: undefined,
      typeSafeApiUrl: undefined,
      catalogSource: async () => documents,
      rfcSourceFetcher: async (document) => {
        fetched.push(document.identifier);
        return makeSourceFetcher(sourceText)(document);
      },
      decisionModel: model,
      now: () => Date.parse("2026-01-01T00:00:00.000Z"),
    });
    clients.push(client);

    const result = await client.research({
      schemaVersion: 1,
      question: "What does HTTP semantics require?",
      rfc: null,
    });

    expect(result.status).toBe("answered");
    expect(documentBatchSizes).toEqual([8]);
    expect(result.diagnostics.candidates).toMatchObject({
      catalogDocuments: 20,
      documentCandidates: 8,
      acceptedDocuments: 1,
    });
    expect(fetched).toEqual(["RFC9110"]);
    expect(result.evidence.every((passage) => passage.provenance.identifier === "RFC9110")).toBe(
      true,
    );
  });

  test("returns needs_review without fetching sources when no document is accepted", async () => {
    const cacheDirectory = await makeCacheDirectory();
    const calls: Array<unknown> = [];
    let sourceFetches = 0;
    const model = {
      [DecisionModel.TypeId]: DecisionModel.TypeId,
      decide: (definition: { readonly decisions: Readonly<Record<string, Decision.Any>> }) => {
        calls.push(definition);
        const answers = Object.fromEntries(
          Object.entries(definition.decisions).map(([key, decision]) =>
            key === "question_atomicity"
              ? [
                  key,
                  {
                    label: "atomic",
                    probabilities: { atomic: 0.99, compound: 0.01 },
                    confidence: 0.99,
                  },
                ]
              : decision._tag === "Probability"
                ? [key, { probability: 0.1 }]
                : [key, { probability: 0.1 }],
          ),
        );
        return Effect.succeed({
          answers,
          usage: { inputTokens: 3, outputTokens: 2 },
        });
      },
    } as unknown as DecisionModel.DecisionModel;
    const client = await createRfcClient({
      cacheDirectory,
      catalogPath: undefined,
      modelAlias: "jev-topic-test",
      typeSafeApiKey: undefined,
      typeSafeApiUrl: undefined,
      catalogSource: async () => [catalogDocument],
      rfcSourceFetcher: async () => {
        sourceFetches += 1;
        return sourceText;
      },
      decisionModel: model,
      now: () => Date.parse("2026-01-01T00:00:00.000Z"),
    });
    clients.push(client);

    const result = await client.research({
      schemaVersion: 1,
      question: "What must an HTTP client send?",
      rfc: null,
    });

    expect(result.status).toBe("needs_review");
    expect(result.rfc).toBeNull();
    expect(result.evidence).toEqual([]);
    expect(calls).toHaveLength(1);
    expect(sourceFetches).toBe(0);
    expect(result.diagnostics.source).toBeNull();
    expect(result.diagnostics.candidates).toMatchObject({
      documentCandidates: 1,
      acceptedDocuments: 0,
      sourceBlocks: 0,
    });
  });

  test("fails with a document-stage error when a document probability is malformed", async () => {
    const cacheDirectory = await makeCacheDirectory();
    const model = {
      [DecisionModel.TypeId]: DecisionModel.TypeId,
      decide: () =>
        Effect.succeed({
          answers: {
            question_atomicity: {
              label: "atomic",
              probabilities: { atomic: 0.99, compound: 0.01 },
              confidence: 0.99,
            },
            document_0: { probability: 2 },
          },
          usage: { inputTokens: 1, outputTokens: 1 },
        }),
    } as unknown as DecisionModel.DecisionModel;
    const client = await createRfcClient({
      cacheDirectory,
      catalogPath: undefined,
      modelAlias: "jev-topic-test",
      typeSafeApiKey: undefined,
      typeSafeApiUrl: undefined,
      catalogSource: async () => [catalogDocument],
      decisionModel: model,
      now: () => Date.parse("2026-01-01T00:00:00.000Z"),
    });
    clients.push(client);

    await expect(
      client.research({
        schemaVersion: 1,
        question: "What must an HTTP client send?",
        rfc: null,
      }),
    ).rejects.toMatchObject({
      _tag: "DecisionModelError",
      stage: "document",
    });
  });
});
