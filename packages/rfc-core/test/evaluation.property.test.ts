import { describe, expect, test } from "bun:test";
import { Schema } from "effect";
import {
  EvaluationObservationSchema,
  EvaluationReportSchema,
  evaluationCorpus,
  evaluationSchemaVersion,
  isValidProbabilityDistribution,
  makeEvaluationReport,
  makeUtf8OffsetMap,
  parseSourceBlocks,
} from "../src/index";

const generatedSource = (seed: number): string => {
  const words = ["client", "serveur", "résumé", "😀", "request", "resource"];
  const body = Array.from({ length: 24 + (seed % 9) }, (_, index) => {
    const word = words[(seed + index * 3) % words.length] ?? "client";
    return `${word}-${seed}-${index}`;
  }).join(" ");
  return `Preamble ${seed}\n\n1. Requirements\n\n${body}\n\n2. Procedure\n\nThe client MUST send a request.\n`;
};

const expectedOutcome = (evaluationCase: (typeof evaluationCorpus.cases)[number]): string =>
  evaluationCase.kind === "research"
    ? (evaluationCase.expectedStatus ?? "needs_review")
    : (evaluationCase.expectedVerdict ?? "unsupported");

const generatedObservation = (
  evaluationCase: (typeof evaluationCorpus.cases)[number],
  seed: number,
) => {
  const outcome = expectedOutcome(evaluationCase);
  const acceptedByPolicy = outcome === "answered" || outcome === "verified";
  const totalLatencyMs = evaluationCase.mode === "topic" ? 80 + seed : 60 + seed;
  return Schema.decodeUnknownSync(EvaluationObservationSchema)({
    schemaVersion: evaluationSchemaVersion,
    caseId: evaluationCase.id,
    category: evaluationCase.category,
    kind: evaluationCase.kind,
    mode: evaluationCase.mode,
    expectedOutcome: outcome,
    observedOutcome: outcome,
    allowedOutcomes: evaluationCase.allowedOutcomes,
    acceptedByPolicy,
    unsafeCitationAccepted: false,
    sourceHashes: ["a".repeat(64)],
    requestedModel: "jev-latest",
    resolvedModel: "jev-1.13.0",
    resolvedModels: ["jev-1.13.0"],
    policyVersion: "precision-v2",
    usage: { inputTokens: 10 + seed, outputTokens: 4 + seed },
    timings: {
      metadataMs: 1,
      documentMs: evaluationCase.mode === "topic" ? 2 : null,
      sourceMs: 3,
      lexicalMs: evaluationCase.mode === "topic" ? 4 : null,
      selectionMs: 5,
      relationMs: 6,
      verificationMs: evaluationCase.kind === "citation" ? 7 : null,
      totalMs: totalLatencyMs,
    },
    retrieval: {
      schemaVersion: 2,
      requestCount: 1,
      datatrackerRequestCount: 1,
      sourceRequestCount: 0,
      metadataMs: 1,
      sourceMs: 0,
      sourceCacheOutcome: "not_requested",
      ...(evaluationCase.mode === "topic"
        ? {
            upstreamRows: 1,
            uniqueCandidates: 1,
            mergeLimit: 32,
            semanticCandidates: 1,
            selectedSources: 0,
            topicTruncated: false,
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
      ],
    },
    totalLatencyMs,
    probabilities:
      evaluationCase.kind === "research" && outcome === "answered"
        ? {
            accepted: 0.99,
            "selection.fixture.probability": 0.99,
            "classification.fixture.direct_answer": 0.99,
          }
        : { accepted: acceptedByPolicy ? 0.99 : 0.01 },
    confidence: acceptedByPolicy ? 0.99 : 0.5,
    errorKind: null,
  });
};

describe("evaluation invariants", () => {
  test("source slices round-trip through UTF-8 offsets", () => {
    for (let seed = 0; seed < 100; seed += 1) {
      const text = generatedSource(seed);
      const offsets = makeUtf8OffsetMap(text);
      const bytes = new TextEncoder().encode(text);
      for (const boundary of [0, text.indexOf("1. Requirements"), text.length]) {
        const byteOffset = offsets.byteOffsetAtCodeUnit(boundary);
        expect(byteOffset).toBeDefined();
      }
      const blocks = parseSourceBlocks(text, 80, 12);
      for (const block of blocks) {
        const start = offsets.byteOffsetAtCodeUnit(block.startOffset);
        const end = offsets.byteOffsetAtCodeUnit(block.endOffset);
        expect(start).toBeDefined();
        expect(end).toBeDefined();
        if (start === undefined || end === undefined) continue;
        expect(new TextDecoder().decode(bytes.slice(start, end))).toBe(block.text);
      }
    }
  });

  test("source blocks remain bounded and overlap only adjacent ranges", () => {
    for (let seed = 0; seed < 100; seed += 1) {
      const text = generatedSource(seed);
      const blocks = parseSourceBlocks(text, 80, 12);
      for (const block of blocks) {
        expect(block.startOffset).toBeGreaterThanOrEqual(0);
        expect(block.endOffset).toBeLessThanOrEqual(text.length);
        expect(block.endOffset).toBeGreaterThan(block.startOffset);
        expect(text.slice(block.startOffset, block.endOffset)).toBe(block.text);
      }
      for (let index = 1; index < blocks.length; index += 1) {
        const previous = blocks[index - 1];
        const current = blocks[index];
        if (previous === undefined || current === undefined) continue;
        expect(current.startOffset).toBeGreaterThanOrEqual(previous.startOffset);
        expect(current.startOffset).toBeLessThanOrEqual(previous.endOffset);
        expect(previous.endOffset - current.startOffset).toBeLessThanOrEqual(12);
      }
    }
  });

  test("generated reports round-trip through their JSON schema", () => {
    for (let seed = 0; seed < 32; seed += 1) {
      const observations = evaluationCorpus.cases.map((evaluationCase) =>
        generatedObservation(evaluationCase, seed),
      );
      const report = makeEvaluationReport(evaluationCorpus, observations);
      const encoded = JSON.parse(JSON.stringify(report)) as unknown;
      expect(Schema.decodeUnknownSync(EvaluationReportSchema)(encoded)).toEqual(report);
    }
  });

  test("generated decision distributions stay valid at every boundary", () => {
    for (let numerator = 0; numerator <= 100; numerator += 1) {
      const yes = numerator / 100;
      const no = 1 - yes;
      expect(isValidProbabilityDistribution({ yes, no }, ["yes", "no"])).toBe(true);
    }
    expect(isValidProbabilityDistribution({ yes: 0.25, no: 0.25 }, ["yes", "no"])).toBe(false);
    expect(isValidProbabilityDistribution({ yes: -0.1, no: 1.1 }, ["yes", "no"])).toBe(false);
  });
});
