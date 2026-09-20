import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { Duration, Effect } from "effect";
import { TestClock } from "effect/testing";
import * as AiError from "effect/unstable/ai/AiError";
import * as DecisionModel from "effect/unstable/ai/DecisionModel";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import {
  CitationOffsetMismatchError,
  CitationQuoteAmbiguousError,
  CitationVerificationResultSchema,
  citationPolicy,
  RfcDiscoveryError,
  createRfcClient as createCoreRfcClient,
  hashRfcSource,
  type RfcClient,
  type RfcClientOptions,
  type RfcSourceFetcher,
} from "../src/index";
import type * as Decision from "effect/unstable/ai/Decision";
import type { CatalogDocument, CatalogSource } from "../src/catalog";

const clients: Array<RfcClient> = [];
type TestClientOptions = Omit<RfcClientOptions, "automaticAnswerActivation"> & {
  readonly automaticAnswerActivation?: RfcClientOptions["automaticAnswerActivation"];
  readonly metadataSource: CatalogSource;
};

const makeDatatrackerClient = (documents: ReadonlyArray<CatalogDocument>) =>
  HttpClient.make((request, url) => {
    const name = url.pathname.match(/\/document\/(rfc\d+)\/$/)?.[1];
    if (name !== undefined) {
      const document = documents.find((candidate) => candidate.identifier.toLowerCase() === name);
      return Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          document === undefined
            ? new Response("not found", { status: 404 })
            : Response.json({
                name,
                rfc_number: document.rfcNumber,
                title: document.title,
                abstract: document.abstract,
                resource_uri: `/api/v1/doc/document/${name}/`,
                stream: `/api/v1/name/streamname/${document.stream}/`,
                states: [],
              }),
        ),
      );
    }
    const target = url.searchParams.get("target__name")?.toUpperCase();
    const targetDocument = documents.find((candidate) => candidate.identifier === target);
    const objects = [
      ...(targetDocument?.updatedBy ?? []).map((identifier) => ({
        source: `/api/v1/doc/document/${identifier.toLowerCase()}/`,
        target: `/api/v1/doc/document/${target?.toLowerCase()}/`,
        relationship: "/api/v1/name/docrelationshipname/updates/",
      })),
      ...(targetDocument?.obsoletedBy ?? []).map((identifier) => ({
        source: `/api/v1/doc/document/${identifier.toLowerCase()}/`,
        target: `/api/v1/doc/document/${target?.toLowerCase()}/`,
        relationship: "/api/v1/name/docrelationshipname/obs/",
      })),
    ];
    return Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        Response.json({
          meta: { limit: 64, offset: 0, total_count: objects.length, next: null },
          objects,
        }),
      ),
    );
  });

const createRfcClient = async (options: TestClientOptions) => {
  const { metadataSource, ...clientOptions } = options;
  const documents = await metadataSource();
  return createCoreRfcClient({
    ...clientOptions,
    datatrackerHttpClient: clientOptions.datatrackerHttpClient ?? makeDatatrackerClient(documents),
    automaticAnswerActivation: clientOptions.automaticAnswerActivation,
  });
};

const makeCacheDirectory = async () => mkdtemp(join(tmpdir(), "rfc-core-citation-test-"));

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
  "1. Requirements",
  "",
  "The client MUST send a request containing the target resource.",
  "",
  "2. Background",
  "",
  "Requests use a target resource.",
  "",
  "3. Qualifications",
  "",
  "Clients MUST send requests when a target resource is known.",
  "",
  "4. Contradiction",
  "",
  "The server MUST NOT cache requests.",
  "",
].join("\n");

const makeSourceFetcher =
  (text: string): RfcSourceFetcher =>
  async () => ({
    sourceUrl: "https://www.rfc-editor.org/rfc/rfc9110.txt",
    text,
  });

const makeTypeSafeCitationHttpClient = (models: ReadonlyArray<string>) => {
  let calls = 0;
  const client = HttpClient.make((request) => {
    const model = models[Math.min(calls, models.length - 1)] ?? "jev-1.13.0";
    calls += 1;
    return Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        new Response(
          JSON.stringify({
            model,
            answers: {
              citation_verdict: {
                type: "choice",
                choice: "verified",
                probabilities: { verified: 0.95, unsupported: 0.025, contradicted: 0.025 },
                confidence: 0.95,
              },
            },
            usage: { input_tokens: 12, output_tokens: 8 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      ),
    );
  });
  return { client, calls: () => calls };
};

const makeDecisionModel = (
  calls: Array<unknown>,
  verdict: "verified" | "unsupported" | "contradicted" = "verified",
  confidence = 0.95,
  failFirst = false,
  onAttempt: (() => void) | undefined = undefined,
): DecisionModel.DecisionModel => {
  let attempts = 0;
  const model = {
    [DecisionModel.TypeId]: DecisionModel.TypeId,
    decide: (
      definition: { readonly decisions: Readonly<Record<string, Decision.Any>> },
      options: { readonly input: unknown },
    ) => {
      attempts += 1;
      onAttempt?.();
      calls.push({ definition, input: options.input });
      if (failFirst && attempts === 1) {
        return Effect.fail(
          AiError.make({
            module: "test",
            method: "decide",
            reason: new AiError.InternalProviderError({ description: "temporary" }),
          }),
        );
      }
      return Effect.succeed({
        answers: {
          citation_verdict: {
            label: verdict,
            probabilities: {
              verified: verdict === "verified" ? 0.95 : 0.025,
              unsupported: verdict === "unsupported" ? 0.95 : 0.025,
              contradicted: verdict === "contradicted" ? 0.95 : 0.025,
            },
            confidence,
          },
        },
        usage: { inputTokens: 12, outputTokens: 8 },
      });
    },
  } as unknown as DecisionModel.DecisionModel;
  return model;
};

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
});

describe("citation verification", () => {
  test("verifies an exact quote and returns canonical provenance", async () => {
    const cacheDirectory = await makeCacheDirectory();
    const calls: Array<unknown> = [];
    const client = await createRfcClient({
      cacheDirectory,
      modelAlias: "jev-test",
      typeSafeApiKey: undefined,
      typeSafeApiUrl: undefined,
      metadataSource: async () => [catalogDocument],
      rfcSourceFetcher: makeSourceFetcher(sourceText),
      decisionModel: makeDecisionModel(calls),
      now: () => Date.parse("2026-01-01T00:00:00.000Z"),
    });
    clients.push(client);

    const quote = "The client MUST send a request containing the target resource.";
    const result = await client.verifyCitation({
      schemaVersion: 2,
      rfc: "RFC9110",
      claim: "The client must send a request containing the target resource.",
      quote,
      offset: null,
    });

    expect(result.verdict).toBe("verified");
    expect(result.quote).toBe(quote);
    expect(result.provenance.startOffset).toBe(sourceText.indexOf(quote));
    expect(result.provenance.endOffset).toBe(sourceText.indexOf(quote) + quote.length);
    const startOffset = result.provenance.startOffset;
    expect(startOffset).not.toBeNull();
    if (startOffset === null) throw new Error("Expected a citation start offset");
    expect(sourceText.slice(startOffset, result.provenance.endOffset ?? undefined)).toBe(
      result.quote,
    );
    expect(result.provenance.sourceHash).toBe(hashRfcSource(sourceText));
    expect(result.provenance.section).toBe("1. Requirements");
    expect(result.provenance.sourceUrl).toBe("https://www.rfc-editor.org/rfc/rfc9110.txt");
    expect(result.provenance.canonicalUrl).toBe(catalogDocument.canonicalUrl);
    expect(result.diagnostics).toMatchObject({
      requestedModel: "jev-test",
      resolvedModel: "jev-test",
      resolvedModels: ["jev-test"],
      usage: { inputTokens: 12, outputTokens: 8 },
      confidence: 0.95,
      retrieval: {
        requestCount: 2,
        datatrackerRequestCount: 1,
        sourceRequestCount: 1,
        sourceCacheOutcome: "miss",
      },
    });
    expect(result.schemaVersion).toBe(2);
    expect(result.rfc).not.toHaveProperty("updates");
    expect(result.rfc).not.toHaveProperty("obsoletes");
    expect(result.diagnostics.schemaVersion).toBe(2);
    expect(result.diagnostics.retrieval?.requests).toHaveLength(2);
    expect(result.diagnostics.retrieval?.requests.map(({ kind }) => kind)).toEqual([
      "metadata",
      "source",
    ]);
    expect(calls).toHaveLength(1);
    expect(CitationVerificationResultSchema.make(result)).toEqual(result);
  });

  test("keeps resolved model diagnostics local to each citation operation", async () => {
    const cacheDirectory = await makeCacheDirectory();
    const typeSafe = makeTypeSafeCitationHttpClient(["jev-first", "jev-second"]);
    const client = await createRfcClient({
      cacheDirectory,
      modelAlias: "jev-latest",
      typeSafeApiKey: undefined,
      typeSafeApiUrl: undefined,
      typeSafeHttpClient: typeSafe.client,
      metadataSource: async () => [catalogDocument],
      rfcSourceFetcher: makeSourceFetcher(sourceText),
      now: () => Date.parse("2026-01-01T00:00:00.000Z"),
    });
    clients.push(client);

    const request = {
      schemaVersion: 2 as const,
      rfc: "RFC9110",
      claim: "The client must send a request containing the target resource.",
      quote: "The client MUST send a request containing the target resource.",
      offset: null,
    };
    const first = await client.verifyCitation(request);
    const second = await client.verifyCitation(request);

    expect(first.diagnostics.resolvedModels).toEqual(["jev-first"]);
    expect(second.diagnostics.resolvedModels).toEqual(["jev-second"]);
    expect(first.diagnostics.resolvedModel).toBe("jev-first");
    expect(second.diagnostics.resolvedModel).toBe("jev-second");
    expect(second.diagnostics.retrieval).toMatchObject({
      requestCount: 1,
      datatrackerRequestCount: 1,
      sourceRequestCount: 0,
      sourceCacheOutcome: "hit",
    });
    expect(second.diagnostics.retrieval?.requests).toHaveLength(1);
    expect(typeSafe.calls()).toBe(2);
  });

  test("uses UTF-8 byte offsets for Unicode quotations and provenance", async () => {
    const unicodeSourceText = [
      "Preamble: café 😀.",
      "",
      "1. Unicode",
      "",
      "The 😀 résumé client MUST send a request.",
      "",
      "2. End",
      "",
    ].join("\n");
    const quote = "The 😀 résumé client MUST send a request.";
    const codeUnitOffset = unicodeSourceText.indexOf(quote);
    const encoder = new TextEncoder();
    const startOffset = encoder.encode(unicodeSourceText.slice(0, codeUnitOffset)).byteLength;
    const endOffset = encoder.encode(
      unicodeSourceText.slice(0, codeUnitOffset + quote.length),
    ).byteLength;
    expect(startOffset).not.toBe(codeUnitOffset);

    const cacheDirectory = await makeCacheDirectory();
    const client = await createRfcClient({
      cacheDirectory,
      modelAlias: "jev-test",
      typeSafeApiKey: undefined,
      typeSafeApiUrl: undefined,
      metadataSource: async () => [catalogDocument],
      rfcSourceFetcher: makeSourceFetcher(unicodeSourceText),
      decisionModel: makeDecisionModel([]),
      now: () => Date.parse("2026-01-01T00:00:00.000Z"),
    });
    clients.push(client);

    const result = await client.verifyCitation({
      schemaVersion: 2,
      rfc: "RFC9110",
      claim: "The client must send a request.",
      quote,
      offset: startOffset,
    });

    expect(result.provenance.offsetUnit).toBe("utf8-byte");
    expect(result.provenance.startOffset).toBe(startOffset);
    expect(result.provenance.endOffset).toBe(endOffset);
    expect(result.provenance.sourceHash).toBe(hashRfcSource(unicodeSourceText));
    expect(result.provenance.section).toBe("1. Unicode");
    const sourceBytes = encoder.encode(unicodeSourceText);
    expect(new TextDecoder().decode(sourceBytes.slice(startOffset, endOffset))).toBe(quote);

    await expect(
      client.verifyCitation({
        schemaVersion: 2,
        rfc: "RFC9110",
        claim: "The client must send a request.",
        quote,
        offset: codeUnitOffset,
      }),
    ).rejects.toBeInstanceOf(CitationOffsetMismatchError);
  });

  test("returns fabricated without calling the DecisionModel", async () => {
    const cacheDirectory = await makeCacheDirectory();
    const calls: Array<unknown> = [];
    const client = await createRfcClient({
      cacheDirectory,
      modelAlias: "jev-test",
      typeSafeApiKey: undefined,
      typeSafeApiUrl: undefined,
      metadataSource: async () => [catalogDocument],
      rfcSourceFetcher: makeSourceFetcher(sourceText),
      decisionModel: makeDecisionModel(calls),
      now: () => Date.parse("2026-01-01T00:00:00.000Z"),
    });
    clients.push(client);

    const result = await client.verifyCitation({
      schemaVersion: 2,
      rfc: "9110",
      claim: "The server must cache requests.",
      quote: "The server MUST cache requests.",
      offset: null,
    });

    expect(result.verdict).toBe("fabricated");
    expect(result.probabilities).toEqual({ fabricated: 1 });
    expect(result.provenance.startOffset).toBeNull();
    expect(result.provenance.endOffset).toBeNull();
    expect(result.diagnostics.usage).toEqual({ inputTokens: null, outputTokens: null });
    expect(calls).toHaveLength(0);

    await expect(
      client.verifyCitation({
        schemaVersion: 2,
        rfc: "RFC9999",
        claim: "The server caches requests.",
        quote: "The server MUST cache requests.",
        offset: null,
      }),
    ).rejects.toBeInstanceOf(RfcDiscoveryError);
  });

  test("requires an offset for duplicate quotations and rejects mismatches", async () => {
    const duplicate = `${sourceText}\n${sourceText}`;
    const cacheDirectory = await makeCacheDirectory();
    const client = await createRfcClient({
      cacheDirectory,
      modelAlias: "jev-test",
      typeSafeApiKey: undefined,
      typeSafeApiUrl: undefined,
      metadataSource: async () => [catalogDocument],
      rfcSourceFetcher: makeSourceFetcher(duplicate),
      decisionModel: makeDecisionModel([]),
      now: () => Date.parse("2026-01-01T00:00:00.000Z"),
    });
    clients.push(client);
    const quote = "The client MUST send a request containing the target resource.";
    const occurrences = [duplicate.indexOf(quote), duplicate.lastIndexOf(quote)];

    await expect(
      client.verifyCitation({
        schemaVersion: 2,
        rfc: "RFC9110",
        claim: "The client sends a request.",
        quote,
        offset: null,
      }),
    ).rejects.toBeInstanceOf(CitationQuoteAmbiguousError);

    await expect(
      client.verifyCitation({
        schemaVersion: 2,
        rfc: "RFC9110",
        claim: "The client sends a request.",
        quote,
        offset: occurrences[0] + 1,
      }),
    ).rejects.toBeInstanceOf(CitationOffsetMismatchError);

    const result = await client.verifyCitation({
      schemaVersion: 2,
      rfc: "RFC9110",
      claim: "The client sends a request.",
      quote,
      offset: occurrences[1],
    });
    expect(result.provenance.startOffset).toBe(occurrences[1]);
  });

  test("maps topical, omitted-qualification, contradictory, and low-confidence cases safely", async () => {
    const cases = [
      {
        verdict: "unsupported" as const,
        confidence: 0.95,
        expected: "unsupported",
        claim: "The server caches requests.",
        quote: "Requests use a target resource.",
      },
      {
        verdict: "unsupported" as const,
        confidence: 0.95,
        expected: "unsupported",
        claim: "Clients must always send requests.",
        quote: "Clients MUST send requests when a target resource is known.",
      },
      {
        verdict: "contradicted" as const,
        confidence: 0.95,
        expected: "contradicted",
        claim: "The server must cache requests.",
        quote: "The server MUST NOT cache requests.",
      },
      {
        verdict: "verified" as const,
        confidence: 0.4,
        expected: "unsupported",
        claim: "The client sends a request.",
        quote: "The client MUST send a request containing the target resource.",
      },
    ] as const;

    for (const testCase of cases) {
      const cacheDirectory = await makeCacheDirectory();
      const calls: Array<unknown> = [];
      const client = await createRfcClient({
        cacheDirectory,
        modelAlias: "jev-test",
        typeSafeApiKey: undefined,
        typeSafeApiUrl: undefined,
        metadataSource: async () => [catalogDocument],
        rfcSourceFetcher: makeSourceFetcher(sourceText),
        decisionModel: makeDecisionModel(calls, testCase.verdict, testCase.confidence),
        now: () => Date.parse("2026-01-01T00:00:00.000Z"),
      });
      clients.push(client);

      const result = await client.verifyCitation({
        schemaVersion: 2,
        rfc: "RFC9110",
        claim: testCase.claim,
        quote: testCase.quote,
        offset: null,
      });
      expect(result.verdict).toBe(testCase.expected);
      expect(calls[0]).toMatchObject({
        input: {
          claim: testCase.claim,
          quote: testCase.quote,
          context: expect.stringContaining(testCase.quote),
        },
      });
    }
  });

  test("retries retryable provider failures and fails after the retry budget", async () => {
    const cacheDirectory = await makeCacheDirectory();
    const calls: Array<unknown> = [];
    const clock = await Effect.runPromise(
      Effect.scoped(TestClock.make({ warningDelay: Duration.seconds(30) })),
    );
    let resolveFirstAttempt: (() => void) | undefined;
    const firstAttempt = new Promise<void>((resolve) => {
      resolveFirstAttempt = resolve;
    });
    const client = await createRfcClient({
      cacheDirectory,
      modelAlias: "jev-test",
      typeSafeApiKey: undefined,
      typeSafeApiUrl: undefined,
      metadataSource: async () => [catalogDocument],
      rfcSourceFetcher: makeSourceFetcher(sourceText),
      decisionModel: makeDecisionModel(calls, "verified", 0.95, true, () => {
        resolveFirstAttempt?.();
      }),
      clock,
    });
    clients.push(client);

    const verification = client.verifyCitation({
      schemaVersion: 2,
      rfc: "RFC9110",
      claim: "The client sends a request.",
      quote: "The client MUST send a request containing the target resource.",
      offset: null,
    });
    await firstAttempt;
    expect(calls).toHaveLength(1);
    await Effect.runPromise(
      clock.adjust(Duration.millis(citationPolicy.initialRetryDelayMilliseconds)),
    );
    const result = await verification;

    expect(result.verdict).toBe("verified");
    expect(calls).toHaveLength(2);

    let nonRetryableCalls = 0;
    const nonRetryableClient = await createRfcClient({
      cacheDirectory: await makeCacheDirectory(),
      modelAlias: "jev-test",
      typeSafeApiKey: undefined,
      typeSafeApiUrl: undefined,
      metadataSource: async () => [catalogDocument],
      rfcSourceFetcher: makeSourceFetcher(sourceText),
      decisionModel: {
        [DecisionModel.TypeId]: DecisionModel.TypeId,
        decide: () => {
          nonRetryableCalls += 1;
          return Effect.fail(
            AiError.make({
              module: "test",
              method: "decide",
              reason: new AiError.AuthenticationError({ kind: "InvalidKey" }),
            }),
          );
        },
      } as unknown as DecisionModel.DecisionModel,
      now: () => Date.parse("2026-01-01T00:00:00.000Z"),
    });
    clients.push(nonRetryableClient);

    await expect(
      nonRetryableClient.verifyCitation({
        schemaVersion: 2,
        rfc: "RFC9110",
        claim: "The client sends a request.",
        quote: "The client MUST send a request containing the target resource.",
        offset: null,
      }),
    ).rejects.toMatchObject({ _tag: "DecisionModelError", stage: "citation" });
    expect(nonRetryableCalls).toBe(1);

    let delayedCalls = 0;
    const delayedClient = await createRfcClient({
      cacheDirectory: await makeCacheDirectory(),
      modelAlias: "jev-test",
      typeSafeApiKey: undefined,
      typeSafeApiUrl: undefined,
      metadataSource: async () => [catalogDocument],
      rfcSourceFetcher: makeSourceFetcher(sourceText),
      decisionModel: {
        [DecisionModel.TypeId]: DecisionModel.TypeId,
        decide: () => {
          delayedCalls += 1;
          return Effect.fail(
            AiError.make({
              module: "test",
              method: "decide",
              reason: new AiError.RateLimitError({ retryAfter: Duration.seconds(6) }),
            }),
          );
        },
      } as unknown as DecisionModel.DecisionModel,
      now: () => Date.parse("2026-01-01T00:00:00.000Z"),
    });
    clients.push(delayedClient);

    await expect(
      delayedClient.verifyCitation({
        schemaVersion: 2,
        rfc: "RFC9110",
        claim: "The client sends a request.",
        quote: "The client MUST send a request containing the target resource.",
        offset: null,
      }),
    ).rejects.toMatchObject({ _tag: "DecisionModelError", stage: "citation" });
    expect(delayedCalls).toBe(1);

    const exhaustedClock = await Effect.runPromise(
      Effect.scoped(TestClock.make({ warningDelay: Duration.seconds(30) })),
    );
    const exhaustedResolvers: Array<() => void> = [];
    const exhaustedAttempts = Array.from(
      { length: 3 },
      (_, index) =>
        new Promise<void>((resolve) => {
          exhaustedResolvers[index] = resolve;
        }),
    );
    let exhaustedCalls = 0;
    const exhaustedClient = await createRfcClient({
      cacheDirectory: await makeCacheDirectory(),
      modelAlias: "jev-test",
      typeSafeApiKey: undefined,
      typeSafeApiUrl: undefined,
      metadataSource: async () => [catalogDocument],
      rfcSourceFetcher: makeSourceFetcher(sourceText),
      decisionModel: {
        [DecisionModel.TypeId]: DecisionModel.TypeId,
        decide: () => {
          exhaustedResolvers[exhaustedCalls]?.();
          exhaustedCalls += 1;
          return Effect.fail(
            AiError.make({
              module: "test",
              method: "decide",
              reason: new AiError.InternalProviderError({ description: "down" }),
            }),
          );
        },
      } as unknown as DecisionModel.DecisionModel,
      clock: exhaustedClock,
    });
    clients.push(exhaustedClient);

    const exhaustedVerification = exhaustedClient.verifyCitation({
      schemaVersion: 2,
      rfc: "RFC9110",
      claim: "The client sends a request.",
      quote: "The client MUST send a request containing the target resource.",
      offset: null,
    });
    const exhaustedOutcome = exhaustedVerification.then(
      () => ({ kind: "success" as const }),
      (error) => ({ kind: "error" as const, error }),
    );
    for (const [index, attempt] of exhaustedAttempts.entries()) {
      await attempt;
      if (index < exhaustedAttempts.length - 1) {
        await Effect.runPromise(
          exhaustedClock.adjust(
            Duration.millis(citationPolicy.initialRetryDelayMilliseconds * 2 ** index),
          ),
        );
      }
    }
    const outcome = await exhaustedOutcome;
    expect(outcome.kind).toBe("error");
    if (outcome.kind === "error") {
      expect(outcome.error).toMatchObject({
        _tag: "DecisionModelError",
        stage: "citation",
      });
    }
  });

  test("times out a never-resolving provider at the remaining citation budget", async () => {
    const cacheDirectory = await makeCacheDirectory();
    const clock = await Effect.runPromise(
      Effect.scoped(TestClock.make({ warningDelay: Duration.seconds(30) })),
    );
    let startedResolve: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      startedResolve = resolve;
    });
    const successful = makeDecisionModel([]);
    const client = await createRfcClient({
      cacheDirectory,
      modelAlias: "jev-test",
      typeSafeApiKey: undefined,
      typeSafeApiUrl: undefined,
      metadataSource: async () => [catalogDocument],
      rfcSourceFetcher: makeSourceFetcher(sourceText),
      decisionModel: {
        [DecisionModel.TypeId]: DecisionModel.TypeId,
        decide: (..._args: Parameters<typeof successful.decide>) => {
          startedResolve?.();
          return Effect.never;
        },
      } as unknown as DecisionModel.DecisionModel,
      clock,
    });
    clients.push(client);

    const verification = client.verifyCitation({
      schemaVersion: 2,
      rfc: "RFC9110",
      claim: "The client sends a request.",
      quote: "The client MUST send a request containing the target resource.",
      offset: null,
    });
    const verificationOutcome = verification.then(
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
    await Effect.runPromise(clock.adjust(Duration.millis(citationPolicy.maxElapsedMilliseconds)));
    const outcome = await Promise.race([
      verificationOutcome,
      new Promise<{ readonly kind: "guard" }>((resolve) =>
        setTimeout(() => resolve({ kind: "guard" }), 250),
      ),
    ]);

    expect(outcome.kind).toBe("error");
    if (outcome.kind === "error") {
      expect(outcome.error).toMatchObject({
        _tag: "DecisionModelError",
        stage: "citation",
        reason: expect.stringContaining("elapsed-time budget"),
        attempts: 1,
      });
    }
  });

  test("rejects malformed provider classification as a typed failure", async () => {
    const cacheDirectory = await makeCacheDirectory();
    const client = await createRfcClient({
      cacheDirectory,
      modelAlias: "jev-test",
      typeSafeApiKey: undefined,
      typeSafeApiUrl: undefined,
      metadataSource: async () => [catalogDocument],
      rfcSourceFetcher: makeSourceFetcher(sourceText),
      decisionModel: {
        [DecisionModel.TypeId]: DecisionModel.TypeId,
        decide: () =>
          Effect.succeed({
            answers: {
              citation_verdict: {
                label: "verified",
                probabilities: { verified: 1 },
                confidence: 1,
              },
            },
            usage: { inputTokens: 1, outputTokens: 1 },
          }),
      } as unknown as DecisionModel.DecisionModel,
      now: () => Date.parse("2026-01-01T00:00:00.000Z"),
    });
    clients.push(client);

    await expect(
      client.verifyCitation({
        schemaVersion: 2,
        rfc: "RFC9110",
        claim: "The client sends a request.",
        quote: "The client MUST send a request containing the target resource.",
        offset: null,
      }),
    ).rejects.toMatchObject({ _tag: "DecisionModelError", stage: "citation" });
  });

  test("repairs malformed cached source data from the live source", async () => {
    const cacheDirectory = await makeCacheDirectory();
    const client = await createRfcClient({
      cacheDirectory,
      modelAlias: "jev-test",
      typeSafeApiKey: undefined,
      typeSafeApiUrl: undefined,
      metadataSource: async () => [catalogDocument],
      rfcSourceFetcher: makeSourceFetcher(sourceText),
      decisionModel: makeDecisionModel([]),
      now: () => Date.parse("2026-01-01T00:00:00.000Z"),
    });
    clients.push(client);

    await client.verifyCitation({
      schemaVersion: 2,
      rfc: "RFC9110",
      claim: "The client sends a request.",
      quote: "The client MUST send a request containing the target resource.",
      offset: null,
    });
    const contentPath = join(cacheDirectory, "sources", "v2", "RFC9110.json");
    await Bun.write(contentPath, JSON.stringify({ text: "tampered" }));

    const repaired = await client.verifyCitation({
      schemaVersion: 2,
      rfc: "RFC9110",
      claim: "The client sends a request.",
      quote: "The client MUST send a request containing the target resource.",
      offset: null,
    });
    expect(repaired.verdict).toBe("verified");
  });
});
