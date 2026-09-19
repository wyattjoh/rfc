import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { Effect, Ref } from "effect";
import * as Decision from "effect/unstable/ai/Decision";
import * as DecisionModel from "effect/unstable/ai/DecisionModel";
import {
  evaluationCorpus,
  observationFromCitationResult,
  observationFromEvidenceBundle,
  ResolvedModelName,
  ResolvedModelNames,
  runEvaluation,
  type EvaluationCase,
  type EvaluationObservation,
  type RfcSourceFetcher,
} from "../src/index";
import { createRfcCalibrationClient } from "../src/internal-calibration";

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
    "The server SHOULD generate a Location header field in the response containing a preferred URI reference for the new permanent URI.",
    "",
    "The server SHOULD generate a Location header field in the response containing a preferred URI reference for the new permanent URI.",
    "",
    "The representation data associated with an HTTP message is either provided as the content of the message or referred to by the message semantics and the target URI.",
    "",
    "A sender MUST NOT generate protocol elements that do not match the grammar defined by the corresponding ABNF rules.",
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
          const lowConfidenceTopicSelection =
            input.documents !== undefined &&
            input.question === "How does an HTTP client send a request message?";
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
  return {
    schemaVersion: 1 as const,
    question: evaluationCase.question,
    rfc: evaluationCase.rfc,
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
    schemaVersion: 1 as const,
    rfc: evaluationCase.rfc,
    claim: evaluationCase.claim,
    quote: evaluationCase.quote,
    offset,
  };
};

const clientOptions = (cacheDirectory: string, decisionModel: DecisionModel.DecisionModel) => ({
  cacheDirectory,
  catalogPath: undefined,
  modelAlias: "jev-latest",
  typeSafeApiKey: undefined,
  typeSafeApiUrl: undefined,
  catalogSource: async () => fixtureDocuments,
  rfcSourceFetcher: sourceFetcher,
  decisionModel,
  policyPreset: "precision-v1",
  now: () => Date.parse("2026-01-01T00:00:00.000Z"),
});

describe("committed evaluation runner", () => {
  test("executes every committed case through public research and citation results", async () => {
    const cacheDirectory = await mkdtemp(join(tmpdir(), "rfc-core-evaluation-runner-test-"));
    const client = await createRfcCalibrationClient(
      clientOptions(cacheDirectory, makeRecordedDecisionModel()),
    );
    const evaluatedCaseIds: Array<string> = [];

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
      );

      expect(evaluatedCaseIds).toEqual(evaluationCorpus.cases.map(({ id }) => id));
      expect(report.observations).toHaveLength(evaluationCorpus.cases.length);
      expect(report.gate.passed).toBe(true);
      expect(report.gate.expectedOutcomePassed).toBe(true);
      expect(report.metrics.supportedClaimPrecision).toBe(1);
      expect(report.metrics.unsafeCitationAcceptances).toBe(0);
    } finally {
      await client.close();
    }
  });
});
