import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { Duration, Effect } from "effect";
import * as AiError from "effect/unstable/ai/AiError";
import * as DecisionModel from "effect/unstable/ai/DecisionModel";
import { TestClock } from "effect/testing";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import {
  DecisionModelError,
  InvalidInputError,
  RfcSourceFetchError,
  buildCandidatePool,
  createRfcClient,
  hashRfcSource,
  retrievalPolicy,
  type PoolCandidate,
  type RfcClient,
  type RfcSourceFetcher,
} from "../src/index";
import type { RfcMetadata } from "../src/metadata";
import { researchQuestions } from "../src/research";
import type { RfcSource } from "../src/source";
import { makeRoutingModel, type RecordedCall } from "./helpers";

const clients: Array<RfcClient> = [];

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
});

const makeRfc = (
  number: number,
  overrides: Partial<Pick<RfcMetadata, "title" | "abstract" | "updatedBy" | "obsoletedBy">> = {},
): RfcMetadata => ({
  identifier: `RFC${number}`,
  rfcNumber: number,
  title: overrides.title ?? `Protocol ${number}`,
  abstract: overrides.abstract ?? `Abstract of RFC ${number}.`,
  status: "published",
  stream: "ietf",
  canonicalUrl: `https://datatracker.ietf.org/doc/rfc${number}/`,
  updates: [],
  updatedBy: overrides.updatedBy ?? [],
  obsoletes: [],
  obsoletedBy: overrides.obsoletedBy ?? [],
});

type SectionSpec = { readonly heading: string; readonly paragraphs: ReadonlyArray<string> };

const rfcText = (number: number, sections: ReadonlyArray<SectionSpec>): string =>
  [
    "Internet Engineering Task Force (IETF)                         E. Author",
    `Request for Comments: ${number}                                    March 2024`,
    "",
    ...sections.flatMap(({ heading, paragraphs }) => [
      heading,
      "",
      ...paragraphs.flatMap((paragraph) => [`   ${paragraph}`, ""]),
    ]),
  ].join("\n");

const defaultText = (number: number): string =>
  rfcText(number, [
    { heading: "1.  Introduction", paragraphs: [`RFC ${number} introduces a protocol.`] },
    {
      heading: "2.  Requirements",
      paragraphs: ["The client MUST send a request.", "The server MUST send a response."],
    },
  ]);

const makeSource = (document: RfcMetadata, text: string): RfcSource => ({
  identifier: document.identifier,
  rfcNumber: document.rfcNumber,
  sourceUrl: `https://www.rfc-editor.org/rfc/rfc${document.rfcNumber}.txt`,
  text,
  contentHash: hashRfcSource(text),
  fetchedAt: "2026-01-01T00:00:00.000Z",
});

const candidate = (
  document: RfcMetadata,
  role: PoolCandidate["role"] = "discovered",
  family: string | undefined = undefined,
): PoolCandidate => ({ document, role, family });

const runPipeline = (
  questions: ReadonlyArray<string>,
  pool: ReadonlyArray<PoolCandidate>,
  model: DecisionModel.DecisionModel,
  texts: Readonly<Record<string, string>> = {},
  failing: ReadonlySet<string> = new Set(),
) =>
  Effect.runPromise(
    researchQuestions({
      questions,
      pool,
      sourceLoader: (document) =>
        failing.has(document.identifier)
          ? Effect.fail(
              new RfcSourceFetchError({
                stage: "request",
                url: "https://www.rfc-editor.org/",
                reason: "unavailable",
                status: 503,
              }),
            )
          : Effect.succeed(
              makeSource(document, texts[document.identifier] ?? defaultText(document.rfcNumber)),
            ),
    }).pipe(Effect.provideService(DecisionModel.DecisionModel, model)) as Effect.Effect<
      Effect.Success<ReturnType<typeof researchQuestions>>,
      Effect.Error<ReturnType<typeof researchQuestions>>
    >,
  );

describe("buildCandidatePool", () => {
  test("orders named RFCs, then current successors, then topic hits without duplicates", () => {
    const rfc7231 = makeRfc(7231, { obsoletedBy: ["RFC9110"] });
    const rfc9110 = makeRfc(9110);
    const rfc6585 = makeRfc(6585);
    const { pool, currency } = buildCandidatePool(
      [
        { document: rfc7231, documents: [rfc7231, rfc9110], traversalComplete: true },
        { document: rfc6585, documents: [rfc6585], traversalComplete: true },
      ],
      [rfc9110, makeRfc(8297), rfc6585],
    );
    expect(pool.map(({ document, role, family }) => [document.identifier, role, family])).toEqual([
      ["RFC7231", "requested", "RFC7231"],
      ["RFC6585", "requested", "RFC6585"],
      ["RFC9110", "current", "RFC7231"],
      ["RFC8297", "discovered", undefined],
    ]);
    expect(currency).toEqual([
      {
        requested: "RFC7231",
        current: ["RFC9110"],
        complete: true,
        paths: [
          { identifier: "RFC7231", path: [] },
          {
            identifier: "RFC9110",
            path: [{ from: "RFC7231", to: "RFC9110", relationship: "obsoletes" }],
          },
        ],
      },
      {
        requested: "RFC6585",
        current: ["RFC6585"],
        complete: true,
        paths: [{ identifier: "RFC6585", path: [] }],
      },
    ]);
  });

  test("follows update chains to their terminal RFCs", () => {
    const first = makeRfc(1000, { updatedBy: ["RFC2000"] });
    const second = makeRfc(2000, { updatedBy: ["RFC3000", "RFC4000"] });
    const { pool, currency } = buildCandidatePool(
      [
        {
          document: first,
          documents: [first, second, makeRfc(3000), makeRfc(4000)],
          traversalComplete: true,
        },
      ],
      [],
    );
    expect(pool.map(({ document, role }) => `${document.identifier}:${role}`)).toEqual([
      "RFC1000:requested",
      "RFC3000:current",
      "RFC4000:current",
    ]);
    expect(currency[0]).toMatchObject({ current: ["RFC3000", "RFC4000"], complete: true });
  });

  test("marks currency incomplete when traversal was cut short or a successor is unresolved", () => {
    const requested = makeRfc(1000, { updatedBy: ["RFC2000", "RFC3000"] });
    const truncated = buildCandidatePool(
      [{ document: requested, documents: [requested, makeRfc(2000)], traversalComplete: false }],
      [],
    );
    expect(truncated.currency[0]).toMatchObject({ current: ["RFC2000"], complete: false });
    // An edge to metadata traversal never fetched is unresolved even when the
    // lookup itself reported a complete traversal.
    const unresolved = buildCandidatePool(
      [{ document: requested, documents: [requested, makeRfc(2000)], traversalComplete: true }],
      [],
    );
    expect(unresolved.currency[0]).toMatchObject({ current: ["RFC2000"], complete: false });
  });

  test("keeps a cycle complete while claiming no current RFC", () => {
    const first = makeRfc(1000, { updatedBy: ["RFC2000"] });
    const second = makeRfc(2000, { updatedBy: ["RFC1000"] });
    const { currency } = buildCandidatePool(
      [{ document: first, documents: [first, second], traversalComplete: true }],
      [],
    );
    expect(currency[0]).toMatchObject({ current: [], complete: true });
  });

  test("caps the pool without dropping named RFCs", () => {
    const named = makeRfc(1);
    const discovered = Array.from({ length: 40 }, (_, index) => makeRfc(100 + index));
    const { pool } = buildCandidatePool(
      [{ document: named, documents: [named], traversalComplete: true }],
      discovered,
    );
    expect(pool).toHaveLength(retrievalPolicy.maxPoolCandidates);
    expect(pool[0]?.document.identifier).toBe("RFC1");
  });
});

describe("researchQuestions ranking", () => {
  test("skips the rank request for a single-RFC pool", async () => {
    const calls: Array<RecordedCall> = [];
    const result = await runPipeline(
      ["What must the client send?"],
      [candidate(makeRfc(9110), "requested", "RFC9110")],
      makeRoutingModel({ paragraph: (_, text) => (text.includes("client") ? 1 : 0) }, calls),
    );
    expect(calls.some(({ decisions }) => "rank_q0" in decisions)).toBe(false);
    expect(calls).toHaveLength(2);
    expect(result.answers[0]?.hits[0]?.relevance).toBeNull();
    expect(result.answers[0]?.hits[0]?.passages.map(({ quote }) => quote)).toEqual([
      "The client MUST send a request.",
    ]);
  });

  test("keeps at most two RFCs above the relevance floor", async () => {
    const relevance: Record<string, number> = {
      RFC1: 0.2,
      RFC2: 0.95,
      RFC3: 0.5,
      RFC4: 0.7,
    };
    const result = await runPipeline(
      ["Which RFC?"],
      [1, 2, 3, 4].map((number) => candidate(makeRfc(number))),
      makeRoutingModel({ relevance: (_, identifier) => relevance[identifier] ?? 0 }),
    );
    expect(
      result.answers[0]?.hits.map(({ rfc, relevance: score }) => [rfc.identifier, score]),
    ).toEqual([
      ["RFC2", 0.95],
      ["RFC4", 0.7],
    ]);
    expect(result.rankedCount).toBe(2);
  });

  test("breaks relevance ties with the ranking Choice", async () => {
    const calls: Array<RecordedCall> = [];
    const model = makeRoutingModel({}, calls);
    const tiedModel = {
      ...model,
      decide: (definition: RecordedCall, options: { readonly input: RecordedCall["input"] }) =>
        (
          model.decide as unknown as (...args: Array<unknown>) => Effect.Effect<{
            readonly answers: Record<string, unknown>;
          }>
        )(definition, options).pipe(
          Effect.map((response) =>
            "rank_q0" in response.answers
              ? {
                  ...response,
                  answers: {
                    ...response.answers,
                    rank_q0: {
                      label: "c2",
                      probabilities: { c0: 0.1, c1: 0.2, c2: 0.7, none: 0 },
                      confidence: 0.9,
                    },
                  },
                }
              : response,
          ),
        ),
    } as unknown as DecisionModel.DecisionModel;
    const result = await runPipeline(
      ["Which RFC?"],
      [1, 2, 3].map((number) => candidate(makeRfc(number))),
      tiedModel,
    );
    expect(result.answers[0]?.hits.map(({ rfc }) => rfc.identifier)).toEqual(["RFC3", "RFC2"]);
  });

  test("keeps a requested RFC and its current successor together", async () => {
    const relevance: Record<string, number> = { RFC8000: 0.95, RFC7231: 0.6, RFC9110: 0.5 };
    const result = await runPipeline(
      ["What does it say?"],
      [
        candidate(makeRfc(7231), "requested", "RFC7231"),
        candidate(makeRfc(9110), "current", "RFC7231"),
        candidate(makeRfc(8000)),
      ],
      makeRoutingModel({ relevance: (_, identifier) => relevance[identifier] ?? 0 }),
    );
    expect(result.answers[0]?.hits.map(({ rfc, role }) => `${rfc.identifier}:${role}`)).toEqual([
      "RFC8000:discovered",
      "RFC7231:requested",
      "RFC9110:current",
    ]);
  });

  test("reports not found when no RFC clears the relevance floor", async () => {
    const calls: Array<RecordedCall> = [];
    const result = await runPipeline(
      ["Unrelated?"],
      [candidate(makeRfc(1)), candidate(makeRfc(2))],
      makeRoutingModel({ relevance: () => 0.1 }, calls),
    );
    expect(result.answers).toEqual([
      { question: "Unrelated?", found: false, searched: [], hits: [] },
    ]);
    expect(calls).toHaveLength(1);
  });
});

describe("researchQuestions sections and paragraphs", () => {
  const manySections = rfcText(9999, [
    {
      heading: "1.  Overview",
      paragraphs: ["Overview paragraph."],
    },
    {
      heading: "2.  Headers",
      paragraphs: [
        "Primary header answer.",
        "Secondary header detail.",
        "Tertiary header detail.",
        "Unrelated header note.",
        "Another unrelated note.",
      ],
    },
  ]);

  test("keeps paragraphs until they cover the probability mass", async () => {
    const weights: Record<string, number> = {
      "Primary header answer.": 0.5,
      "Secondary header detail.": 0.2,
      "Tertiary header detail.": 0.2,
      "Unrelated header note.": 0.1,
    };
    const result = await runPipeline(
      ["Which header?"],
      [candidate(makeRfc(9999), "requested", "RFC9999")],
      makeRoutingModel({
        section: (_, heading) => (heading.includes("Headers") ? 1 : 0),
        paragraph: (_, text) => weights[text] ?? 0,
      }),
      { RFC9999: manySections },
    );
    expect(result.answers[0]?.hits[0]?.passages.map(({ quote }) => quote)).toEqual([
      "Primary header answer.",
      "Secondary header detail.",
      "Tertiary header detail.",
    ]);
  });

  test("returns one passage when it carries the mass and caps passages at three", async () => {
    const peaked = await runPipeline(
      ["Which header?"],
      [candidate(makeRfc(9999), "requested", "RFC9999")],
      makeRoutingModel({
        section: (_, heading) => (heading.includes("Headers") ? 1 : 0),
        paragraph: (_, text) => (text === "Primary header answer." ? 0.9 : 0.02),
      }),
      { RFC9999: manySections },
    );
    expect(peaked.answers[0]?.hits[0]?.passages).toHaveLength(1);

    const flat = await runPipeline(
      ["Which header?"],
      [candidate(makeRfc(9999), "requested", "RFC9999")],
      makeRoutingModel(),
      { RFC9999: manySections },
    );
    expect(flat.answers[0]?.hits[0]?.passages).toHaveLength(retrievalPolicy.maxParagraphs);
  });

  test("offers only paragraphs of the chosen sections", async () => {
    const calls: Array<RecordedCall> = [];
    await runPipeline(
      ["Which header?"],
      [candidate(makeRfc(9999), "requested", "RFC9999")],
      makeRoutingModel({ section: (_, heading) => (heading.includes("Headers") ? 1 : 0) }, calls),
      { RFC9999: manySections },
    );
    const paragraphCall = calls.find(({ decisions }) => "paragraph_q0" in decisions);
    expect(
      Object.values(paragraphCall?.input.paragraphs ?? {}).map(({ text }) => text),
    ).not.toContain("Overview paragraph.");
    expect(Object.values(paragraphCall?.input.paragraphs ?? {})[0]?.section).toBe("2. Headers");
    const sectionCall = calls.find(({ decisions }) => "section_q0" in decisions);
    expect(Object.values(sectionCall?.input.toc ?? {})).toEqual([
      { heading: "1. Overview", preview: "Overview paragraph." },
      { heading: "2. Headers", preview: "Primary header answer." },
    ]);
  });

  test("uses a two-level section choice above the option limit", async () => {
    const large = rfcText(
      8888,
      Array.from({ length: 30 }, (_, chapter) => [
        {
          heading: `${chapter + 1}.  Chapter ${chapter + 1}`,
          paragraphs: [`Chapter ${chapter + 1} introduction.`],
        },
        ...Array.from({ length: 9 }, (_, section) => ({
          heading: `${chapter + 1}.${section + 1}.  Topic ${chapter + 1}.${section + 1}`,
          paragraphs: [`Text of topic ${chapter + 1}.${section + 1}.`],
        })),
      ]).flat(),
    );
    const calls: Array<RecordedCall> = [];
    const result = await runPipeline(
      ["Where is topic 12.7?"],
      [candidate(makeRfc(8888), "requested", "RFC8888")],
      makeRoutingModel(
        {
          section: (_, heading) =>
            heading === "12. Chapter 12" ? 0.6 : heading === "12.7. Topic 12.7" ? 1 : 0.001,
          paragraph: (_, text) => (text.includes("12.7") ? 1 : 0),
        },
        calls,
      ),
      { RFC8888: large },
    );
    const sectionCalls = calls.filter(({ decisions }) => "section_q0" in decisions);
    expect(sectionCalls).toHaveLength(2);
    const chapters = Object.values(sectionCalls[0]?.input.toc ?? {});
    expect(chapters).toHaveLength(30);
    expect(chapters[11]?.preview).toContain("12.7. Topic 12.7");
    expect(
      Object.keys(sectionCalls[1]?.decisions.section_q0?.criteria ?? {}).length,
    ).toBeLessThanOrEqual(retrievalPolicy.maxChoiceOptions + 1);
    expect(result.answers[0]?.hits[0]?.passages[0]).toMatchObject({
      quote: "Text of topic 12.7.",
      section: "12.7.  Topic 12.7",
    });
  });

  test("drops an RFC whose paragraphs do not answer the question", async () => {
    const result = await runPipeline(
      ["Is it here?"],
      [candidate(makeRfc(9110), "requested", "RFC9110")],
      makeRoutingModel({ exists: () => 0.2 }),
    );
    expect(result.answers[0]).toEqual({
      question: "Is it here?",
      found: false,
      searched: ["RFC9110"],
      hits: [],
    });
  });

  test("derives the hit verdict from paragraph verdicts", async () => {
    const result = await runPipeline(
      ["What must the client send?"],
      [candidate(makeRfc(9110), "requested", "RFC9110")],
      makeRoutingModel({
        section: (_, heading) => (heading.includes("Requirements") ? 1 : 0),
        verdict: (_, text) => (text.includes("client") ? "partial" : "says_nothing"),
      }),
    );
    const hit = result.answers[0]?.hits[0];
    expect(hit?.verdict).toBe("partial");
    expect(hit?.passages.map(({ verdict }) => verdict)).toEqual(["partial", "says_nothing"]);
  });

  test("shares one section and one paragraph request per RFC across questions", async () => {
    const calls: Array<RecordedCall> = [];
    const result = await runPipeline(
      ["What must the client send?", "What must the server send?"],
      [candidate(makeRfc(9110), "requested", "RFC9110")],
      makeRoutingModel(
        {
          section: (_, heading) => (heading.includes("Requirements") ? 1 : 0),
          paragraph: (question, text) =>
            text.includes(question.includes("client") ? "client" : "server") ? 1 : 0,
        },
        calls,
      ),
    );
    expect(calls).toHaveLength(2);
    expect(Object.keys(calls[0]?.input.questions ?? {})).toEqual(["q0", "q1"]);
    expect(result.answers.map((answer) => answer.hits[0]?.passages[0]?.quote)).toEqual([
      "The client MUST send a request.",
      "The server MUST send a response.",
    ]);
  });

  test("drops an unavailable successor source but fails for a named RFC", async () => {
    const pool = [
      candidate(makeRfc(7231), "requested", "RFC7231"),
      candidate(makeRfc(9110), "current", "RFC7231"),
    ];
    const result = await runPipeline(["What?"], pool, makeRoutingModel(), {}, new Set(["RFC9110"]));
    expect(result.answers[0]?.hits.map(({ rfc }) => rfc.identifier)).toEqual(["RFC7231"]);
    await expect(
      runPipeline(["What?"], pool, makeRoutingModel(), {}, new Set(["RFC7231"])),
    ).rejects.toBeInstanceOf(RfcSourceFetchError);
  });

  test("rejects an invalid provider distribution as a typed failure", async () => {
    // Built with DecisionModel.make so validation happens where production validates it.
    const broken = await Effect.runPromise(
      DecisionModel.make({
        decide: ({ decisions }) =>
          Effect.succeed({
            answers: Object.fromEntries(
              Object.entries(decisions).map(
                ([key, decision]): [string, DecisionModel.ProviderAnswer] => [
                  key,
                  decision._tag === "Probability"
                    ? { _tag: "Probability", probability: 0.9 }
                    : {
                        _tag: "Classify",
                        label: Object.keys(decision.criteria)[0] ?? "none",
                        probabilities: Object.fromEntries(
                          Object.keys(decision.criteria).map((label) => [label, 0.9]),
                        ),
                      },
                ],
              ),
            ),
            usage: { inputTokens: undefined, outputTokens: undefined },
          }),
      }),
    );
    await expect(
      runPipeline(["What?"], [candidate(makeRfc(9110), "requested", "RFC9110")], broken),
    ).rejects.toMatchObject({
      _tag: "DecisionModelError",
      stage: "section",
      // InvalidOutputError is retryable, so it is retried up to the attempt cap.
      reason: `DecisionModel retry budget exhausted after ${retrievalPolicy.providerMaxAttempts} attempts (InvalidOutputError)`,
      attempts: retrievalPolicy.providerMaxAttempts,
    });
  });
});

describe("createRfcClient research", () => {
  const makeDatatrackerClient = (documents: ReadonlyArray<RfcMetadata>) =>
    HttpClient.make((request, url) => {
      const exactName = url.pathname.match(/\/document\/(rfc\d+)\/$/)?.[1];
      if (exactName !== undefined) {
        const document = documents.find(
          (candidateDocument) => candidateDocument.identifier.toLowerCase() === exactName,
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
                  stream: `/api/v1/name/streamname/${document.stream}/`,
                  states: [],
                }),
          ),
        );
      }
      if (url.pathname.endsWith("/relateddocument/")) {
        const target = url.searchParams.get("target__name")?.toUpperCase();
        const document = documents.find(
          (candidateDocument) => candidateDocument.identifier === target,
        );
        const objects = (document?.obsoletedBy ?? []).map((identifier) => ({
          source: `/api/v1/doc/document/${identifier.toLowerCase()}/`,
          target: `/api/v1/doc/document/${target?.toLowerCase()}/`,
          relationship: "/api/v1/name/docrelationshipname/obs/",
        }));
        return Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            Response.json({
              meta: { limit: 64, offset: 0, total_count: objects.length, next: null },
              objects,
            }),
          ),
        );
      }
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
              stream: `/api/v1/name/streamname/${document.stream}/`,
              states: [],
            })),
          }),
        ),
      );
    });

  const makeSourceFetcher =
    (texts: Readonly<Record<string, string>>): RfcSourceFetcher =>
    async (document) => ({
      sourceUrl: `https://www.rfc-editor.org/rfc/rfc${document.rfcNumber}.txt`,
      text: texts[document.identifier] ?? defaultText(document.rfcNumber),
    });

  const makeClient = async (
    documents: ReadonlyArray<RfcMetadata>,
    model: DecisionModel.DecisionModel,
    texts: Readonly<Record<string, string>> = {},
    extra: Partial<Parameters<typeof createRfcClient>[0]> = {},
  ) => {
    const client = await createRfcClient({
      cacheDirectory: await mkdtemp(join(tmpdir(), "rfc-core-research-test-")),
      modelAlias: "jev-test",
      typeSafeApiKey: undefined,
      typeSafeApiUrl: undefined,
      datatrackerHttpClient: makeDatatrackerClient(documents),
      rfcSourceFetcher: makeSourceFetcher(texts),
      decisionModel: model,
      now: () => Date.parse("2026-01-01T00:00:00.000Z"),
      ...extra,
    });
    clients.push(client);
    return client;
  };

  test("researches named RFCs with successors and topic hits in one pool", async () => {
    const utf8Text = rfcText(7231, [
      { heading: "1.  Introduction", paragraphs: ["Written by Martin Dürst."] },
      { heading: "2.  Requirements", paragraphs: ["The client MUST send a request."] },
    ]);
    const client = await makeClient(
      [makeRfc(7231, { obsoletedBy: ["RFC9110"] }), makeRfc(9110), makeRfc(6585)],
      makeRoutingModel({
        section: (_, heading) => (heading.includes("Requirements") ? 1 : 0),
        paragraph: (_, text) => (text.includes("client") ? 1 : 0),
      }),
      { RFC7231: utf8Text },
    );
    const result = await client.research({
      schemaVersion: 3,
      questions: ["What must the client send?"],
      rfcs: ["RFC7231"],
      searchTerms: ["HTTP"],
    });
    expect(result).toMatchObject({ schemaVersion: 3, kind: "research_result" });
    expect(result.currency).toEqual([
      {
        requested: "RFC7231",
        current: ["RFC9110"],
        complete: true,
        paths: [
          { identifier: "RFC7231", path: [] },
          {
            identifier: "RFC9110",
            path: [{ from: "RFC7231", to: "RFC9110", relationship: "obsoletes" }],
          },
        ],
      },
    ]);
    expect(result.diagnostics.candidates).toEqual({ pool: 3, ranked: 2 });
    const hit = result.answers[0]?.hits.find(({ rfc }) => rfc.identifier === "RFC7231");
    const passage = hit?.passages[0];
    expect(hit?.role).toBe("requested");
    expect(passage?.quote).toBe("The client MUST send a request.");
    const bytes = Buffer.from(utf8Text, "utf8");
    expect(
      bytes
        .subarray(passage?.provenance.startOffset ?? 0, passage?.provenance.endOffset ?? 0)
        .toString("utf8"),
    ).toBe(passage?.quote ?? "");
    expect(passage?.provenance).toMatchObject({
      offsetUnit: "utf8-byte",
      sourceHash: hashRfcSource(utf8Text),
    });
    expect(result.diagnostics.usage).toEqual({ inputTokens: 50, outputTokens: 10 });
    expect(result.diagnostics.retrieval).toMatchObject({
      schemaVersion: 3,
      traversalComplete: true,
    });
  });

  test("omits currency for topic-only research", async () => {
    const client = await makeClient([makeRfc(9110)], makeRoutingModel());
    const result = await client.research({
      schemaVersion: 3,
      questions: ["What must the client send?"],
      searchTerms: ["HTTP"],
    });
    expect(result.currency).toBeUndefined();
    expect(result.answers[0]?.hits[0]?.role).toBe("discovered");
  });

  test("validates the version-three request contract", async () => {
    const client = await makeClient([makeRfc(9110)], makeRoutingModel());
    for (const request of [
      { schemaVersion: 2, questions: ["What?"], rfcs: ["RFC9110"] },
      { schemaVersion: 3, questions: ["What?"] },
      { schemaVersion: 3, questions: [], rfcs: ["RFC9110"] },
      { schemaVersion: 3, questions: ["1", "2", "3", "4", "5"], rfcs: ["RFC9110"] },
      { schemaVersion: 3, questions: ["What?"], searchTerms: ["a", "b", "c", "d", "e"] },
    ]) {
      await expect(client.research(request as never)).rejects.toBeInstanceOf(InvalidInputError);
    }
  });

  const failing = (reason: AiError.AiErrorReason, onAttempt: () => void) =>
    ({
      [DecisionModel.TypeId]: DecisionModel.TypeId,
      decide: () => {
        onAttempt();
        return Effect.fail(AiError.make({ module: "test", method: "decide", reason }));
      },
    }) as unknown as DecisionModel.DecisionModel;

  const request = {
    schemaVersion: 3,
    questions: ["What must the client send?"],
    rfcs: ["RFC9110"],
  } as const;

  test("retries retryable provider errors and does not retry non-retryable ones", async () => {
    let attempts = 0;
    const successful = makeRoutingModel();
    const flaky = {
      [DecisionModel.TypeId]: DecisionModel.TypeId,
      decide: (...args: Parameters<typeof successful.decide>) => {
        attempts += 1;
        return attempts === 1
          ? Effect.fail(
              AiError.make({
                module: "test",
                method: "decide",
                reason: new AiError.RateLimitError({ retryAfter: Duration.millis(0) }),
              }),
            )
          : successful.decide(...args);
      },
    } as unknown as DecisionModel.DecisionModel;
    const client = await makeClient([makeRfc(9110)], flaky);
    await expect(client.research(request)).resolves.toMatchObject({ kind: "research_result" });
    expect(attempts).toBe(3);

    let rejected = 0;
    const strict = await makeClient(
      [makeRfc(9110)],
      failing(new AiError.InvalidRequestError({ description: "bad request" }), () => {
        rejected += 1;
      }),
    );
    await expect(strict.research(request)).rejects.toBeInstanceOf(DecisionModelError);
    expect(rejected).toBe(1);
  });

  test("stops before a retry that would exceed the elapsed-time budget", async () => {
    let attempts = 0;
    const client = await makeClient(
      [makeRfc(9110)],
      failing(new AiError.RateLimitError({ retryAfter: Duration.seconds(60) }), () => {
        attempts += 1;
      }),
    );
    await expect(client.research(request)).rejects.toMatchObject({
      _tag: "DecisionModelError",
      reason: expect.stringContaining("retry"),
    });
    expect(attempts).toBe(1);
  });

  test("fails with a typed provider error after retry exhaustion", async () => {
    let attempts = 0;
    const client = await makeClient(
      [makeRfc(9110)],
      failing(new AiError.InternalProviderError({ description: "unavailable" }), () => {
        attempts += 1;
      }),
    );
    await expect(client.research(request)).rejects.toMatchObject({
      _tag: "DecisionModelError",
      stage: "section",
      reason: expect.stringContaining("retry"),
    });
    expect(attempts).toBe(retrievalPolicy.providerMaxAttempts);
  });

  test("times out a never-completing provider attempt at the elapsed-time budget", async () => {
    const clock = await Effect.runPromise(
      Effect.scoped(TestClock.make({ warningDelay: Duration.seconds(30) })),
    );
    let attempts = 0;
    let startedResolve: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      startedResolve = resolve;
    });
    const client = await makeClient(
      [makeRfc(9110)],
      {
        [DecisionModel.TypeId]: DecisionModel.TypeId,
        decide: () => {
          attempts += 1;
          startedResolve?.();
          return Effect.never;
        },
      } as unknown as DecisionModel.DecisionModel,
      {},
      { now: undefined, clock },
    );
    const outcome = client.research(request).then(
      () => ({ kind: "success" as const }),
      (error: unknown) => ({ kind: "error" as const, error }),
    );
    await started;
    await new Promise<void>((resolve) => setImmediate(resolve));
    await Effect.runPromise(clock.adjust(Duration.seconds(10)));
    const settled = await Promise.race([
      outcome,
      new Promise<{ readonly kind: "guard" }>((resolve) =>
        setTimeout(() => resolve({ kind: "guard" }), 250),
      ),
    ]);
    expect(settled).toMatchObject({
      kind: "error",
      error: {
        _tag: "DecisionModelError",
        stage: "section",
        reason: expect.stringContaining("elapsed-time budget"),
        attempts: 1,
      },
    });
    expect(attempts).toBe(1);
  });
});
