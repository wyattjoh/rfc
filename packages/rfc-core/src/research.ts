import MiniSearch from "minisearch";
import { Clock, Context, Effect, FileSystem, Ref, Schema } from "effect";
import * as Decision from "effect/unstable/ai/Decision";
import * as DecisionModel from "effect/unstable/ai/DecisionModel";
import {
  CatalogDocumentSchema,
  CatalogStatusSchema,
  type CatalogDocument,
  type CatalogStatus,
  type RfcCatalog,
} from "./catalog";
import {
  RfcSourceCacheError,
  RfcSourceServiceTag,
  RfcSourceStore,
  RfcSourceFetchError,
  defaultRfcEditorBaseUrl,
  makeRfcSource,
  makeRfcSourceUrl,
  type RfcSource,
} from "./source";

/**
 * Provider-observed model identifier shared with the research diagnostics layer.
 */
export class ResolvedModelName extends Context.Service<ResolvedModelName, Ref.Ref<string>>()(
  "@wyattjoh/rfc/ResolvedModelName",
) {}

/**
 * The answer-relation labels assigned to selected evidence passages.
 */
export const AnswerRelationSchema = Schema.Literals([
  "direct_answer",
  "partial_answer",
  "background_only",
  "contradictory",
  "irrelevant",
]);

/**
 * The relationship between a source block and the research question.
 */
export type AnswerRelation = Schema.Schema.Type<typeof AnswerRelationSchema>;

/**
 * The fail-closed statuses returned by semantic research.
 */
export const ResearchStatusSchema = Schema.Literals([
  "answered",
  "partial",
  "unsupported",
  "needs_review",
  "needs_split",
]);

/**
 * A fail-closed semantic research status.
 */
export type ResearchStatus = Schema.Schema.Type<typeof ResearchStatusSchema>;

/**
 * Versioned policy values for known-RFC research.
 */
export const knownRfcPolicy = {
  policyVersion: "precision-v1",
  maxPassageCandidates: 8,
  sourceBlockMaxCharacters: 4_000,
  sourceBlockOverlapCharacters: 200,
  selectionProbabilityThreshold: 0.65,
  relationConfidenceThreshold: 0.65,
  directAnswerProbabilityThreshold: 0.65,
  partialAnswerProbabilityThreshold: 0.6,
  contradictoryProbabilityThreshold: 0.65,
} as const;

/**
 * The acceptance and uncertainty rules for one research policy preset.
 */
export type ResearchPolicy = typeof knownRfcPolicy;

/**
 * Named policy presets available to the research pipeline.
 */
export const researchPolicyPresets: Readonly<Record<string, ResearchPolicy>> = {
  "precision-v1": knownRfcPolicy,
};

/**
 * Failure when the configured policy preset is not available.
 */
export class ResearchPolicyError extends Schema.TaggedError<ResearchPolicyError>()(
  "ResearchPolicyError",
  {
    policyPreset: Schema.String,
  },
) {}

/**
 * A bounded section-aware range of RFC source text.
 */
export const SourceBlockSchema = Schema.Struct({
  id: Schema.NonEmptyString,
  section: Schema.NullOr(Schema.String),
  startOffset: Schema.Natural,
  endOffset: Schema.Natural,
  text: Schema.String,
});

/**
 * A bounded source block used as a lexical and semantic candidate.
 */
export type SourceBlock = Schema.Schema.Type<typeof SourceBlockSchema>;

/**
 * Exact provenance for an evidence passage.
 */
export const EvidenceProvenanceSchema = Schema.Struct({
  identifier: Schema.NonEmptyString,
  rfcNumber: Schema.Natural,
  sourceUrl: Schema.NonEmptyString,
  canonicalUrl: Schema.NonEmptyString,
  sourceHash: Schema.NonEmptyString,
  startOffset: Schema.Natural,
  endOffset: Schema.Natural,
  section: Schema.NullOr(Schema.String),
  fetchedAt: Schema.String,
});

/**
 * Source identity and range metadata for an exact quotation.
 */
export type EvidenceProvenance = Schema.Schema.Type<typeof EvidenceProvenanceSchema>;

const ProbabilityMapSchema = Schema.Record(Schema.String, Schema.Number);

/**
 * A selected exact quotation and its independent semantic judgments.
 */
export const EvidencePassageSchema = Schema.Struct({
  id: Schema.NonEmptyString,
  quote: Schema.String,
  relation: AnswerRelationSchema,
  selectionProbability: Schema.Number,
  relationProbabilities: ProbabilityMapSchema,
  confidence: Schema.NullOr(Schema.Number),
  provenance: EvidenceProvenanceSchema,
});

/**
 * A returned evidence passage copied from authoritative RFC text.
 */
export type EvidencePassage = Schema.Schema.Type<typeof EvidencePassageSchema>;

const TokenUsageSchema = Schema.Struct({
  inputTokens: Schema.NullOr(Schema.Number),
  outputTokens: Schema.NullOr(Schema.Number),
});

const TimingSchema = Schema.Struct({
  catalogMs: Schema.Number,
  sourceMs: Schema.Number,
  lexicalMs: Schema.Number,
  selectionMs: Schema.Number,
  relationMs: Schema.Number,
  totalMs: Schema.Number,
});

const CandidateCountsSchema = Schema.Struct({
  sourceBlocks: Schema.Natural,
  passageCandidates: Schema.Natural,
  selectedPassages: Schema.Natural,
});

const SelectionDiagnosticSchema = Schema.Struct({
  candidateId: Schema.NonEmptyString,
  probability: Schema.Number,
});

const ClassificationDiagnosticSchema = Schema.Struct({
  candidateId: Schema.NonEmptyString,
  relation: AnswerRelationSchema,
  probabilities: ProbabilityMapSchema,
  confidence: Schema.NullOr(Schema.Number),
});

const AtomicityDiagnosticSchema = Schema.Struct({
  label: Schema.Literals(["atomic", "compound"]),
  probabilities: ProbabilityMapSchema,
  confidence: Schema.NullOr(Schema.Number),
});

const SourceDiagnosticSchema = Schema.Struct({
  identifier: Schema.NonEmptyString,
  rfcNumber: Schema.Number.check(Schema.isGreaterThan(0)),
  sourceUrl: Schema.NonEmptyString,
  sourceHash: Schema.NonEmptyString,
  fetchedAt: Schema.String,
});

/**
 * Bounded diagnostics for one known-RFC research operation.
 */
export const ResearchDiagnosticsSchema = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  policyVersion: Schema.NonEmptyString,
  requestedModel: Schema.NonEmptyString,
  resolvedModel: Schema.NonEmptyString,
  usage: TokenUsageSchema,
  timings: TimingSchema,
  source: SourceDiagnosticSchema,
  catalog: CatalogStatusSchema,
  candidates: CandidateCountsSchema,
  atomicity: AtomicityDiagnosticSchema,
  selection: Schema.Array(SelectionDiagnosticSchema),
  classification: Schema.Array(ClassificationDiagnosticSchema),
});

/**
 * Diagnostics returned with an evidence bundle.
 */
export type ResearchDiagnostics = Schema.Schema.Type<typeof ResearchDiagnosticsSchema>;

/**
 * The versioned public result of known-RFC research.
 */
export const EvidenceBundleSchema = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  kind: Schema.Literal("evidence_bundle"),
  status: ResearchStatusSchema,
  question: Schema.NonEmptyString,
  rfc: CatalogDocumentSchema,
  evidence: Schema.Array(EvidencePassageSchema),
  diagnostics: ResearchDiagnosticsSchema,
});

/**
 * A versioned evidence bundle returned by the Promise facade.
 */
export type EvidenceBundle = Schema.Schema.Type<typeof EvidenceBundleSchema>;

/**
 * A typed failure when a requested RFC is not an exact published catalog entry.
 */
export class RfcNotFoundError extends Schema.TaggedError<RfcNotFoundError>()("RfcNotFoundError", {
  rfc: Schema.String,
}) {}

/**
 * A typed failure from an official DecisionModel request.
 */
export class DecisionModelError extends Schema.TaggedError<DecisionModelError>()(
  "DecisionModelError",
  {
    stage: Schema.Literals(["selection", "relation"]),
    reason: Schema.String,
  },
) {}

/**
 * Configuration needed by the known-RFC research pipeline.
 */
export interface KnownRfcResearchOptions {
  /**
   * The fresh catalog used to resolve the exact published RFC.
   */
  readonly catalog: RfcCatalog;
  /**
   * Catalog status captured after freshness validation or refresh.
   */
  readonly catalogStatus: CatalogStatus;
  /**
   * Source cache directory.
   */
  readonly sourceDirectory: string;
  /**
   * Named policy preset recorded in diagnostics.
   */
  readonly policyPreset: string;
  /**
   * Model alias requested from the official provider.
   */
  readonly modelAlias: string;
  /**
   * Time spent validating or refreshing the catalog.
   */
  readonly catalogMs: number;
  /**
   * Start timestamp for the complete operation.
   */
  readonly startedAt: number;
}

interface LineRecord {
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

const answerRelationCriteria = {
  direct_answer: "The passage directly answers the atomic question.",
  partial_answer: "The passage answers only part of the atomic question.",
  background_only: "The passage provides relevant background but no answer.",
  contradictory: "The passage conflicts with the answer implied by the question.",
  irrelevant: "The passage does not address the atomic question.",
} as const;

const atomicityCriteria = {
  atomic: "The request contains one independently answerable question.",
  compound: "The request contains multiple independently answerable questions.",
} as const;

type AtomicityLabel = keyof typeof atomicityCriteria;

const PassageBatchInputSchema = Schema.Struct({
  question: Schema.NonEmptyString,
  passages: Schema.Array(
    Schema.Struct({
      id: Schema.NonEmptyString,
      section: Schema.NullOr(Schema.String),
      text: Schema.String,
    }),
  ),
});

type SelectionResult = {
  readonly selected: ReadonlyArray<{ readonly block: SourceBlock; readonly probability: number }>;
  readonly atomicity: {
    readonly label: AtomicityLabel;
    readonly probabilities: Readonly<Record<string, number>>;
    readonly confidence: number | undefined;
  };
  readonly diagnostics: ReadonlyArray<{
    readonly candidateId: string;
    readonly probability: number;
  }>;
  readonly usage: DecisionModel.DecisionUsage;
};

type RelationResult = {
  readonly answers: ReadonlyArray<{
    readonly block: SourceBlock;
    readonly selectionProbability: number;
    readonly relation: AnswerRelation;
    readonly probabilities: Readonly<Record<string, number>>;
    readonly confidence: number | undefined;
  }>;
  readonly diagnostics: ReadonlyArray<{
    readonly candidateId: string;
    readonly relation: AnswerRelation;
    readonly probabilities: Readonly<Record<string, number>>;
    readonly confidence: number | null;
  }>;
  readonly usage: DecisionModel.DecisionUsage;
};

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : "The DecisionModel request failed";

const policyFor = (policyPreset: string): Effect.Effect<ResearchPolicy, ResearchPolicyError> => {
  const policy = researchPolicyPresets[policyPreset];
  return policy === undefined
    ? Effect.fail(new ResearchPolicyError({ policyPreset }))
    : Effect.succeed(policy);
};

const elapsed = (start: number, end: number): number => Math.max(0, end - start);

const addUsage = (left: number | undefined, right: number | undefined): number | undefined => {
  if (left === undefined) return right;
  if (right === undefined) return left;
  return left + right;
};

const combineUsage = (
  left: DecisionModel.DecisionUsage,
  right: DecisionModel.DecisionUsage,
): { readonly inputTokens: number | undefined; readonly outputTokens: number | undefined } => ({
  inputTokens: addUsage(left.inputTokens, right.inputTokens),
  outputTokens: addUsage(left.outputTokens, right.outputTokens),
});

const linesOf = (text: string): ReadonlyArray<LineRecord> => {
  const lines: Array<LineRecord> = [];
  let start = 0;
  while (start <= text.length) {
    const newline = text.indexOf("\n", start);
    const end = newline === -1 ? text.length : newline;
    const contentEnd = end > start && text[end - 1] === "\r" ? end - 1 : end;
    lines.push({
      start,
      end: newline === -1 ? text.length : newline + 1,
      text: text.slice(start, contentEnd),
    });
    if (newline === -1) break;
    start = newline + 1;
  }
  return lines;
};

const sectionHeading = (line: string): string | undefined => {
  const normalized = line.replace(/\f/g, "").trim();
  if (normalized.length === 0 || normalized.length > 240) return undefined;
  const match =
    /^(?:(?:\d+(?:\.\d+)*\.?)|(?:[A-Z](?:\.\d+)*\.?)|(?:Appendix\s+[A-Z](?:\.\d+)*\.?))\s+(.+?)\s*$/.exec(
      normalized,
    );
  if (match === null) return undefined;
  const title = match[1];
  if (title === undefined || title.length === 0 || /^[\d\W]+$/.test(title)) return undefined;
  return normalized;
};

/**
 * Parse RFC plain text into bounded, section-aware source blocks.
 *
 * @param text Exact RFC Editor plain-text source.
 * @param maxCharacters Maximum source characters per block.
 * @param overlapCharacters Bounded overlap between blocks from one oversized section.
 * @returns Blocks with exact absolute source offsets and nullable section labels.
 */
export const parseSourceBlocks = (
  text: string,
  maxCharacters: number = knownRfcPolicy.sourceBlockMaxCharacters,
  overlapCharacters: number = knownRfcPolicy.sourceBlockOverlapCharacters,
): ReadonlyArray<SourceBlock> => {
  const lines = linesOf(text);
  const headings = lines.flatMap((line) => {
    const section = sectionHeading(line.text);
    return section === undefined ? [] : [{ start: line.start, section }];
  });
  const headingSections = headings.map((heading, index) => ({
    start: heading.start,
    end: headings[index + 1]?.start ?? text.length,
    section: heading.section,
  }));
  const sections =
    headings.length === 0
      ? [{ start: 0, end: text.length, section: null }]
      : headings[0] !== undefined && headings[0].start > 0
        ? [{ start: 0, end: headings[0].start, section: null }, ...headingSections]
        : headingSections;
  const blocks: Array<SourceBlock> = [];
  let blockIndex = 0;

  for (const section of sections) {
    if (section.end <= section.start) continue;
    const size = Math.max(1, maxCharacters);
    const overlap = Math.min(Math.max(0, overlapCharacters), Math.max(0, size - 1));
    let start = section.start;
    while (start < section.end) {
      const end = Math.min(section.end, start + size);
      const blockText = text.slice(start, end);
      if (blockText.trim().length > 0) {
        const block = {
          id: `block-${blockIndex}`,
          section: section.section,
          startOffset: start,
          endOffset: end,
          text: blockText,
        };
        blocks.push(Schema.decodeUnknownSync(SourceBlockSchema)(block));
        blockIndex += 1;
      }
      if (end >= section.end) break;
      start = Math.max(start + 1, end - overlap);
    }
  }

  return blocks;
};

/**
 * Deterministically shortlist source blocks with MiniSearch before semantic judgment.
 *
 * @param blocks Parsed source blocks.
 * @param question Atomic research question.
 * @param limit Maximum number of returned candidates.
 * @returns Ranked, bounded passage candidates with stable offset tie-breaking.
 */
export const shortlistPassageCandidates = (
  blocks: ReadonlyArray<SourceBlock>,
  question: string,
  limit: number = knownRfcPolicy.maxPassageCandidates,
): ReadonlyArray<SourceBlock> => {
  if (blocks.length === 0 || question.trim().length === 0 || limit <= 0) return [];
  const search = new MiniSearch<SourceBlock>({
    fields: ["text", "section"],
    storeFields: ["id", "section", "startOffset", "endOffset", "text"],
    searchOptions: {
      boost: { section: 1.5, text: 1 },
      prefix: true,
      fuzzy: 0.2,
    },
  });
  search.addAll(blocks);
  const byId = new Map(blocks.map((block) => [block.id, block]));
  return search
    .search(question)
    .sort(
      (left, right) =>
        right.score - left.score || Number(left.startOffset) - Number(right.startOffset),
    )
    .slice(0, limit)
    .flatMap((result) => {
      const block = byId.get(String(result.id));
      return block === undefined ? [] : [block];
    });
};

const selectionProbability = (answer: Decision.Answer<Decision.Any>): number => {
  if ("probability" in answer) return answer.probability;
  return 0;
};

const selectionStage = Effect.fnUntraced(function* (
  question: string,
  candidates: ReadonlyArray<SourceBlock>,
  policy: ResearchPolicy,
): Effect.fn.Return<SelectionResult, DecisionModelError, DecisionModel.DecisionModel> {
  const decisions = Object.fromEntries([
    [
      "question_atomicity",
      Decision.classify({
        instructions:
          "Determine whether the request contains one atomic question or multiple questions.",
        criteria: atomicityCriteria,
      }),
    ],
    ...candidates.map((candidate, index) => [
      `passage_${index}`,
      Decision.probability({
        instructions:
          "Estimate whether this exact RFC source block contains evidence that answers the question.",
        criteria: {
          false: "The source block does not answer the question.",
          true: "The source block contains evidence that answers the question.",
        },
      }),
    ]),
  ]) as Record<string, Decision.Any>;
  const definition = Decision.make({ input: PassageBatchInputSchema, decisions });
  const response = yield* DecisionModel.decide(definition, {
    input: {
      question,
      passages: candidates.map((candidate) => ({
        id: candidate.id,
        section: candidate.section,
        text: candidate.text,
      })),
    },
  }).pipe(
    Effect.mapError(
      (error) => new DecisionModelError({ stage: "selection", reason: errorMessage(error) }),
    ),
  );
  const atomicityAnswer = response.answers.question_atomicity;
  const atomicity =
    atomicityAnswer !== undefined &&
    "label" in atomicityAnswer &&
    "probabilities" in atomicityAnswer
      ? {
          label: atomicityAnswer.label as AtomicityLabel,
          probabilities: atomicityAnswer.probabilities,
          confidence: atomicityAnswer.confidence,
        }
      : {
          label: "compound" as const,
          probabilities: { atomic: 0, compound: 1 },
          confidence: undefined,
        };
  const atomic =
    atomicity.label === "atomic" &&
    (atomicity.probabilities.atomic ?? 0) >= policy.relationConfidenceThreshold &&
    atomicity.confidence !== undefined &&
    atomicity.confidence >= policy.relationConfidenceThreshold;
  const diagnostics = candidates.map((candidate, index) => {
    const answer = response.answers[`passage_${index}`];
    return {
      candidateId: candidate.id,
      probability: answer === undefined ? 0 : selectionProbability(answer),
    };
  });
  return {
    selected: atomic
      ? candidates.flatMap((candidate, index) => {
          const probability = diagnostics[index]?.probability ?? 0;
          return probability >= policy.selectionProbabilityThreshold
            ? [{ block: candidate, probability }]
            : [];
        })
      : [],
    atomicity,
    diagnostics,
    usage: response.usage,
  };
});

const relationStage = Effect.fnUntraced(function* (
  question: string,
  selected: ReadonlyArray<{ readonly block: SourceBlock; readonly probability: number }>,
): Effect.fn.Return<RelationResult, DecisionModelError, DecisionModel.DecisionModel> {
  if (selected.length === 0) {
    return {
      answers: [],
      diagnostics: [],
      usage: new DecisionModel.DecisionUsage({ inputTokens: undefined, outputTokens: undefined }),
    };
  }
  const decisions = Object.fromEntries(
    selected.map((candidate, index) => [
      `passage_${index}`,
      Decision.classify({
        instructions:
          "Classify the selected exact RFC passage's relationship to the research question.",
        criteria: answerRelationCriteria,
      }),
    ]),
  ) as Record<string, Decision.Any>;
  const definition = Decision.make({ input: PassageBatchInputSchema, decisions });
  const response = yield* DecisionModel.decide(definition, {
    input: {
      question,
      passages: selected.map(({ block }) => ({
        id: block.id,
        section: block.section,
        text: block.text,
      })),
    },
  }).pipe(
    Effect.mapError(
      (error) => new DecisionModelError({ stage: "relation", reason: errorMessage(error) }),
    ),
  );
  const answers = selected.flatMap((candidate, index) => {
    const answer = response.answers[`passage_${index}`];
    if (answer === undefined || !("label" in answer) || !("probabilities" in answer)) return [];
    return [
      {
        block: candidate.block,
        selectionProbability: candidate.probability,
        relation: answer.label as AnswerRelation,
        probabilities: answer.probabilities,
        confidence: answer.confidence,
      },
    ];
  });
  return {
    answers,
    diagnostics: answers.map((answer) => ({
      candidateId: answer.block.id,
      relation: answer.relation,
      probabilities: answer.probabilities,
      confidence: answer.confidence ?? null,
    })),
    usage: response.usage,
  };
});

const resolveRfcNumber = (hint: string): number | undefined => {
  const normalized = hint.trim();
  const match = /^(?:rfc\s*)?(\d+)$/i.exec(normalized);
  if (match === null) return undefined;
  const value = Number(match[1]);
  return Number.isSafeInteger(value) && value > 0 ? value : undefined;
};

/**
 * Resolve a research hint only against exact published catalog metadata.
 *
 * @param catalog Fresh published RFC catalog.
 * @param hint RFC identifier or number supplied by the caller.
 * @returns The exact catalog document.
 * @throws RfcNotFoundError when the hint is invalid or absent from the catalog.
 */
export const resolveKnownRfc = (catalog: RfcCatalog, hint: string): CatalogDocument => {
  const rfcNumber = resolveRfcNumber(hint);
  const document =
    rfcNumber === undefined
      ? undefined
      : catalog.documents.find(
          (candidate) =>
            candidate.rfcNumber === rfcNumber &&
            candidate.identifier.toUpperCase() === `RFC${rfcNumber}`,
        );
  if (document === undefined) {
    throw new RfcNotFoundError({ rfc: hint });
  }
  return document;
};

const loadSource = Effect.fnUntraced(function* (
  document: CatalogDocument,
  options: KnownRfcResearchOptions,
): Effect.fn.Return<
  RfcSource,
  RfcSourceCacheError | RfcSourceFetchError,
  FileSystem.FileSystem | RfcSourceStore | RfcSourceServiceTag
> {
  const store = yield* RfcSourceStore;
  const expectedSourceUrl = makeRfcSourceUrl(defaultRfcEditorBaseUrl, document.rfcNumber);
  const cached = yield* store.read(options.sourceDirectory, document.identifier);
  if (cached !== undefined) {
    if (cached.identifier !== document.identifier || cached.rfcNumber !== document.rfcNumber) {
      return yield* new RfcSourceCacheError({
        stage: "decode",
        sourcePath: options.sourceDirectory,
        reason: "The RFC source cache entry does not match the requested published RFC",
      });
    }
    if (cached.sourceUrl !== expectedSourceUrl) {
      return yield* new RfcSourceCacheError({
        stage: "decode",
        sourcePath: options.sourceDirectory,
        reason: "The RFC source cache entry does not match the canonical RFC Editor URL",
      });
    }
    return cached;
  }

  const sourceService = yield* RfcSourceServiceTag;
  const payload = yield* sourceService.fetch(document);
  const fetchedAt = yield* Clock.currentTimeMillis;
  const source = yield* Effect.try({
    try: () => makeRfcSource(document, payload, fetchedAt, expectedSourceUrl),
    catch: (error) =>
      new RfcSourceFetchError({
        stage: "decode",
        url: expectedSourceUrl,
        reason: errorMessage(error),
      }),
  });
  const sourceOrigin = yield* Effect.try({
    try: () => new URL(source.sourceUrl).origin,
    catch: () =>
      new RfcSourceFetchError({
        stage: "decode",
        url: source.sourceUrl,
        reason: "RFC source has an invalid source URL",
      }),
  });
  if (
    sourceOrigin !== new URL(defaultRfcEditorBaseUrl).origin ||
    source.sourceUrl !== expectedSourceUrl
  ) {
    return yield* new RfcSourceFetchError({
      stage: "decode",
      url: source.sourceUrl,
      reason: "RFC source retrieval must use the canonical RFC Editor URL",
    });
  }
  yield* store.write(options.sourceDirectory, source);
  return source;
});

const relationIsConfident = (confidence: number | undefined, policy: ResearchPolicy): boolean =>
  confidence !== undefined && confidence >= policy.relationConfidenceThreshold;

const acceptedRelation = (
  relation: AnswerRelation,
  probabilities: Readonly<Record<string, number>>,
  confidence: number | undefined,
  policy: ResearchPolicy,
): boolean => {
  if (!relationIsConfident(confidence, policy)) return false;
  const probability = probabilities[relation] ?? 0;
  if (relation === "direct_answer") return probability >= policy.directAnswerProbabilityThreshold;
  if (relation === "partial_answer") return probability >= policy.partialAnswerProbabilityThreshold;
  if (relation === "contradictory") {
    return probability >= policy.contradictoryProbabilityThreshold;
  }
  return false;
};

const confidentNegativeRelation = (
  answer: RelationResult["answers"][number],
  policy: ResearchPolicy,
): boolean =>
  (answer.relation === "background_only" || answer.relation === "irrelevant") &&
  relationIsConfident(answer.confidence, policy) &&
  (answer.probabilities[answer.relation] ?? 0) >= policy.relationConfidenceThreshold;

const statusFromRelations = (
  answers: ReadonlyArray<RelationResult["answers"][number]>,
  atomicity: SelectionResult["atomicity"],
  policy: ResearchPolicy,
): ResearchStatus => {
  const atomicityConfident =
    atomicity.confidence !== undefined &&
    atomicity.confidence >= policy.relationConfidenceThreshold &&
    (atomicity.probabilities[atomicity.label] ?? 0) >= policy.relationConfidenceThreshold;
  if (
    atomicity.label === "compound" &&
    atomicityConfident &&
    (atomicity.probabilities.compound ?? 0) >= policy.relationConfidenceThreshold
  ) {
    return "needs_split";
  }
  if (!atomicityConfident) return "needs_review";

  const accepted = answers.filter((answer) =>
    acceptedRelation(answer.relation, answer.probabilities, answer.confidence, policy),
  );
  const contradictory = answers.some((answer) => answer.relation === "contradictory");
  const uncertainAnswer = answers.some(
    (answer) =>
      (answer.relation === "direct_answer" ||
        answer.relation === "partial_answer" ||
        answer.relation === "contradictory") &&
      !acceptedRelation(answer.relation, answer.probabilities, answer.confidence, policy),
  );
  const direct = accepted.some((answer) => answer.relation === "direct_answer");
  const partial = accepted.some((answer) => answer.relation === "partial_answer");
  if (contradictory || uncertainAnswer) return "needs_review";
  if (direct) return "answered";
  if (partial) return "partial";
  if (answers.length > 0 && answers.every((answer) => confidentNegativeRelation(answer, policy))) {
    return "unsupported";
  }
  return "needs_review";
};

/**
 * Run the complete known-RFC retrieval and semantic evidence pipeline.
 *
 * @param question Atomic research question.
 * @param hint Exact RFC identifier or number.
 * @param options Fresh catalog, cache, provider, and timing configuration.
 * @returns A versioned evidence bundle with exact provenance and diagnostics.
 */
export const researchKnownRfc = Effect.fnUntraced(function* (
  question: string,
  hint: string,
  options: KnownRfcResearchOptions,
): Effect.fn.Return<
  EvidenceBundle,
  | RfcNotFoundError
  | RfcSourceCacheError
  | RfcSourceFetchError
  | DecisionModelError
  | ResearchPolicyError
  | import("./catalog").CatalogReadError
  | import("./catalog").CatalogStaleError,
  | FileSystem.FileSystem
  | RfcSourceStore
  | RfcSourceServiceTag
  | DecisionModel.DecisionModel
  | ResolvedModelName
> {
  const policy = yield* policyFor(options.policyPreset);
  const resolvedModelRef = yield* ResolvedModelName;
  const document = resolveKnownRfc(options.catalog, hint);
  const sourceStarted = yield* Clock.currentTimeMillis;
  const source = yield* loadSource(document, options);
  const sourceFinished = yield* Clock.currentTimeMillis;
  const lexicalStarted = sourceFinished;
  const blocks = parseSourceBlocks(
    source.text,
    policy.sourceBlockMaxCharacters,
    policy.sourceBlockOverlapCharacters,
  );
  const candidates = shortlistPassageCandidates(blocks, question, policy.maxPassageCandidates);
  const lexicalFinished = yield* Clock.currentTimeMillis;
  const selectionStarted = lexicalFinished;
  const selection = yield* selectionStage(question, candidates, policy);
  const selectionFinished = yield* Clock.currentTimeMillis;
  const relationStarted = selectionFinished;
  const relation = yield* relationStage(question, selection.selected);
  const relationFinished = yield* Clock.currentTimeMillis;
  const resolvedModel = yield* Ref.get(resolvedModelRef);
  const usage = combineUsage(selection.usage, relation.usage);
  const evidence = relation.answers
    .filter((answer) =>
      acceptedRelation(answer.relation, answer.probabilities, answer.confidence, policy),
    )
    .map((answer) => {
      const quote = source.text.slice(answer.block.startOffset, answer.block.endOffset);
      return {
        id: answer.block.id,
        quote,
        relation: answer.relation,
        selectionProbability: answer.selectionProbability,
        relationProbabilities: answer.probabilities,
        confidence: answer.confidence ?? null,
        provenance: {
          identifier: document.identifier,
          rfcNumber: document.rfcNumber,
          sourceUrl: source.sourceUrl,
          canonicalUrl: document.canonicalUrl,
          sourceHash: source.contentHash,
          startOffset: answer.block.startOffset,
          endOffset: answer.block.endOffset,
          section: answer.block.section,
          fetchedAt: source.fetchedAt,
        },
      } satisfies EvidencePassage;
    });
  const status = statusFromRelations(relation.answers, selection.atomicity, policy);
  const finishedAt = yield* Clock.currentTimeMillis;
  const diagnostics = {
    schemaVersion: 1 as const,
    policyVersion: policy.policyVersion,
    requestedModel: options.modelAlias,
    resolvedModel,
    usage: {
      inputTokens: usage.inputTokens ?? null,
      outputTokens: usage.outputTokens ?? null,
    },
    timings: {
      catalogMs: options.catalogMs,
      sourceMs: elapsed(sourceStarted, sourceFinished),
      lexicalMs: elapsed(lexicalStarted, lexicalFinished),
      selectionMs: elapsed(selectionStarted, selectionFinished),
      relationMs: elapsed(relationStarted, relationFinished),
      totalMs: elapsed(options.startedAt, finishedAt),
    },
    source: {
      identifier: source.identifier,
      rfcNumber: source.rfcNumber,
      sourceUrl: source.sourceUrl,
      sourceHash: source.contentHash,
      fetchedAt: source.fetchedAt,
    },
    catalog: options.catalogStatus,
    candidates: {
      sourceBlocks: blocks.length,
      passageCandidates: candidates.length,
      selectedPassages: selection.selected.length,
    },
    atomicity: {
      label: selection.atomicity.label,
      probabilities: selection.atomicity.probabilities,
      confidence: selection.atomicity.confidence ?? null,
    },
    selection: selection.diagnostics,
    classification: relation.diagnostics,
  } satisfies ResearchDiagnostics;

  return Schema.decodeUnknownSync(EvidenceBundleSchema)({
    schemaVersion: 1,
    kind: "evidence_bundle",
    status,
    question,
    rfc: document,
    evidence,
    diagnostics,
  });
});
