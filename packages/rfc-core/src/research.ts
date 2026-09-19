import MiniSearch from "minisearch";
import {
  Cause,
  Clock,
  Context,
  Duration,
  Effect,
  FileSystem,
  Predicate,
  Ref,
  Result,
  Schema,
} from "effect";
import * as AiError from "effect/unstable/ai/AiError";
import * as Decision from "effect/unstable/ai/Decision";
import * as DecisionModel from "effect/unstable/ai/DecisionModel";
import { makeUtf8OffsetMap, moveToUtf8Boundary, utf8OffsetUnit } from "./offsets";
import {
  CatalogDocumentSchema,
  CatalogStatusSchema,
  type CatalogDocument,
  type CatalogStatus,
  type RfcCatalog,
} from "./catalog";
import {
  RfcSourceCacheError,
  RfcSourceFetchError,
  RfcSourceServiceTag,
  RfcSourceStore,
  loadRfcSource,
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
 * Versioned policy values shared by known-RFC and topic-only research.
 */
export const knownRfcPolicy = {
  policyVersion: "precision-v1",
  maxDocumentCandidates: 8,
  maxAcceptedDocumentCandidates: 3,
  documentProbabilityThreshold: 0.65,
  maxPassageCandidates: 8,
  sourceBlockMaxCharacters: 4_000,
  sourceBlockOverlapCharacters: 200,
  selectionProbabilityThreshold: 0.65,
  unsupportedProbabilityThreshold: 0.35,
  relationConfidenceThreshold: 0.65,
  providerMaxAttempts: 3,
  providerMaxElapsedMilliseconds: 10_000,
  providerDefaultRetryDelayMilliseconds: 100,
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
 *
 * These offsets are internal JavaScript string boundaries used while parsing;
 * returned evidence provenance converts them to UTF-8 byte offsets.
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
 *
 * The start and end offsets are UTF-8 byte offsets into the exact source text
 * represented by sourceHash, so they compose with citation verification.
 */
export const EvidenceProvenanceSchema = Schema.Struct({
  identifier: Schema.NonEmptyString,
  rfcNumber: Schema.Natural,
  sourceUrl: Schema.NonEmptyString,
  canonicalUrl: Schema.NonEmptyString,
  sourceHash: Schema.NonEmptyString,
  offsetUnit: Schema.Literal(utf8OffsetUnit),
  startOffset: Schema.Natural,
  endOffset: Schema.Natural,
  section: Schema.NullOr(Schema.String),
  fetchedAt: Schema.String,
});

/**
 * Source identity and range metadata for an exact quotation.
 */
export type EvidenceProvenance = Schema.Schema.Type<typeof EvidenceProvenanceSchema>;

const ProbabilityMapSchema = Schema.Record(Schema.String, Schema.Finite);

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
  documentMs: Schema.Union([Schema.Number, Schema.Undefined]),
});

const CandidateCountsSchema = Schema.Struct({
  sourceBlocks: Schema.Natural,
  passageCandidates: Schema.Natural,
  selectedPassages: Schema.Natural,
  catalogDocuments: Schema.Union([Schema.Natural, Schema.Undefined]),
  documentCandidates: Schema.Union([Schema.Natural, Schema.Undefined]),
  acceptedDocuments: Schema.Union([Schema.Natural, Schema.Undefined]),
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
 * Bounded diagnostics for one semantic research operation.
 */
export const ResearchDiagnosticsSchema = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  policyVersion: Schema.NonEmptyString,
  requestedModel: Schema.NonEmptyString,
  resolvedModel: Schema.NonEmptyString,
  usage: TokenUsageSchema,
  timings: TimingSchema,
  source: Schema.NullOr(SourceDiagnosticSchema),
  sources: Schema.Union([Schema.Array(SourceDiagnosticSchema), Schema.Undefined]),
  catalog: CatalogStatusSchema,
  candidates: CandidateCountsSchema,
  atomicity: AtomicityDiagnosticSchema,
  documentSelection: Schema.Union([Schema.Array(SelectionDiagnosticSchema), Schema.Undefined]),
  selection: Schema.Array(SelectionDiagnosticSchema),
  classification: Schema.Array(ClassificationDiagnosticSchema),
});

/**
 * Diagnostics returned with an evidence bundle.
 */
export type ResearchDiagnostics = Schema.Schema.Type<typeof ResearchDiagnosticsSchema>;

/**
 * The versioned public result of known-RFC or topic-only research.
 */
export const EvidenceBundleSchema = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  kind: Schema.Literal("evidence_bundle"),
  status: ResearchStatusSchema,
  question: Schema.NonEmptyString,
  rfc: Schema.NullOr(CatalogDocumentSchema),
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
    stage: Schema.Literals(["document", "selection", "relation", "citation"]),
    reason: Schema.String,
    attempts: Schema.optionalKey(Schema.Natural),
  },
) {}

/**
 * Configuration needed by a semantic RFC research pipeline.
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

const PassageInputSchema = Schema.Struct({
  id: Schema.NonEmptyString,
  section: Schema.NullOr(Schema.String),
  text: Schema.String,
});

const PassageBatchInputSchema = Schema.Struct({
  question: Schema.NonEmptyString,
  passages: Schema.Record(Schema.String, PassageInputSchema),
});

const DocumentInputSchema = Schema.Struct({
  identifier: Schema.NonEmptyString,
  title: Schema.String,
  abstract: Schema.String,
});

const DocumentBatchInputSchema = Schema.Struct({
  question: Schema.NonEmptyString,
  documents: Schema.Record(Schema.String, DocumentInputSchema),
});

type AtomicityResult = {
  readonly label: AtomicityLabel;
  readonly probabilities: Readonly<Record<string, number>>;
  readonly confidence: number | undefined;
};

type DocumentCandidate = {
  readonly document: CatalogDocument;
  readonly lexicalScore: number;
};

type DocumentSelectionResult = {
  readonly accepted: ReadonlyArray<{
    readonly document: CatalogDocument;
    readonly probability: number;
  }>;
  readonly atomicity: AtomicityResult;
  readonly diagnostics: ReadonlyArray<{
    readonly candidateId: string;
    readonly probability: number;
  }>;
  readonly usage: DecisionModel.DecisionUsage;
};

type SelectionResult = {
  readonly selected: ReadonlyArray<{ readonly block: SourceBlock; readonly probability: number }>;
  readonly atomicity: AtomicityResult | undefined;
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

type DecisionStage = "document" | "selection" | "relation";

const providerErrorTag = (error: unknown): string =>
  AiError.isAiError(error) ? error.reason._tag : "UnknownProviderError";

const retryDelayMilliseconds = (error: unknown, policy: ResearchPolicy): number => {
  if (!AiError.isAiError(error) || error.retryAfter === undefined) {
    return policy.providerDefaultRetryDelayMilliseconds;
  }

  const delay = Duration.toMillis(error.retryAfter);
  return Number.isFinite(delay) && delay >= 0
    ? delay
    : policy.providerDefaultRetryDelayMilliseconds;
};

const providerFailure = (
  stage: DecisionStage,
  error: unknown,
  attempts: number,
  exhausted: boolean,
): DecisionModelError =>
  new DecisionModelError({
    stage,
    reason: exhausted
      ? `DecisionModel retry budget exhausted after ${attempts} attempts (${providerErrorTag(error)})`
      : `DecisionModel provider failure (${providerErrorTag(error)})`,
    attempts,
  });

const decodeProbabilityMap = (
  stage: DecisionStage,
  candidateId: string,
  value: unknown,
  labels: ReadonlyArray<string>,
): Effect.Effect<Readonly<Record<string, number>>, DecisionModelError> =>
  Effect.try({
    try: () => {
      const probabilities = Schema.decodeUnknownSync(ProbabilityMapSchema)(value);
      const keys = Object.keys(probabilities);
      const total = labels.reduce((sum, label) => sum + (probabilities[label] ?? Number.NaN), 0);
      const hasExpectedLabels =
        keys.length === labels.length &&
        labels.every((label) => Object.prototype.hasOwnProperty.call(probabilities, label));
      const hasUnitValues = labels.every((label) => {
        const probability = probabilities[label];
        return probability !== undefined && probability >= 0 && probability <= 1;
      });
      if (!hasExpectedLabels || !hasUnitValues || Math.abs(total - 1) > 1e-6) {
        throw new Error("invalid probability distribution");
      }
      return probabilities;
    },
    catch: () =>
      new DecisionModelError({
        stage,
        reason: `Provider returned an invalid probability distribution for ${candidateId}`,
      }),
  });

const decodeConfidence = (
  stage: DecisionStage,
  candidateId: string,
  value: unknown,
): Effect.Effect<number | undefined, DecisionModelError> =>
  value === undefined
    ? Effect.succeed(undefined)
    : Effect.try({
        try: () => {
          const confidence = Schema.decodeUnknownSync(Schema.Finite)(value);
          if (confidence < 0 || confidence > 1) {
            throw new Error("invalid confidence");
          }
          return confidence;
        },
        catch: () =>
          new DecisionModelError({
            stage,
            reason: `Provider returned invalid confidence for ${candidateId}`,
          }),
      });

const decodeProbability = (
  stage: DecisionStage,
  candidateId: string,
  value: unknown,
): Effect.Effect<number, DecisionModelError> =>
  Effect.try({
    try: () => {
      const probability = Schema.decodeUnknownSync(Schema.Finite)(value);
      if (probability < 0 || probability > 1) {
        throw new Error("invalid probability");
      }
      return probability;
    },
    catch: () =>
      new DecisionModelError({
        stage,
        reason: `Provider returned an invalid probability for ${candidateId}`,
      }),
  });

const decodeUsage = (
  stage: DecisionStage,
  value: unknown,
): Effect.Effect<DecisionModel.DecisionUsage, DecisionModelError> =>
  Effect.try({
    try: () => {
      const usage = Schema.decodeUnknownSync(
        Schema.Struct({
          inputTokens: Schema.optionalKey(Schema.Finite),
          outputTokens: Schema.optionalKey(Schema.Finite),
        }),
      )(value);
      if (
        (usage.inputTokens !== undefined && usage.inputTokens < 0) ||
        (usage.outputTokens !== undefined && usage.outputTokens < 0)
      ) {
        throw new Error("invalid token usage");
      }
      return new DecisionModel.DecisionUsage(usage);
    },
    catch: () =>
      new DecisionModelError({
        stage,
        reason: "Provider returned invalid token usage",
      }),
  });

const providerAnswers = (
  stage: DecisionStage,
  response: unknown,
): Effect.Effect<Readonly<Record<string, unknown>>, DecisionModelError> =>
  Effect.try({
    try: () => {
      if (!Predicate.isObject(response) || !Predicate.isObject(response.answers)) {
        throw new Error("missing answers");
      }
      return response.answers;
    },
    catch: () =>
      new DecisionModelError({
        stage,
        reason: "Provider returned a response without answers",
      }),
  });

const decideWithRetry = Effect.fnUntraced(function* <A>(
  stage: DecisionStage,
  operation: () => Effect.Effect<A, AiError.AiError>,
  policy: ResearchPolicy,
): Effect.fn.Return<A, DecisionModelError> {
  const startedAt = yield* Clock.currentTimeMillis;
  let scheduledDelay = 0;

  for (let attempt = 1; attempt <= policy.providerMaxAttempts; attempt += 1) {
    const attemptStartedAt = yield* Clock.currentTimeMillis;
    const elapsedBeforeAttempt = Math.max(0, attemptStartedAt - startedAt, scheduledDelay);
    if (elapsedBeforeAttempt >= policy.providerMaxElapsedMilliseconds) {
      return yield* new DecisionModelError({
        stage,
        reason: `DecisionModel elapsed-time budget exhausted before attempt ${attempt}`,
        attempts: attempt - 1,
      });
    }

    const remainingTime = policy.providerMaxElapsedMilliseconds - elapsedBeforeAttempt;
    const result = yield* Effect.result(
      operation().pipe(Effect.timeout(Duration.millis(remainingTime))),
    );
    if (Result.isSuccess(result)) {
      const completedAt = yield* Clock.currentTimeMillis;
      const elapsedAtCompletion = Math.max(0, completedAt - startedAt, scheduledDelay);
      if (elapsedAtCompletion <= policy.providerMaxElapsedMilliseconds) {
        return result.success;
      }
      return yield* new DecisionModelError({
        stage,
        reason: `DecisionModel elapsed-time budget exhausted during attempt ${attempt}`,
        attempts: attempt,
      });
    }

    const error = result.failure;
    if (Cause.isTimeoutError(error)) {
      return yield* new DecisionModelError({
        stage,
        reason: `DecisionModel elapsed-time budget exhausted during attempt ${attempt}`,
        attempts: attempt,
      });
    }
    if (!AiError.isAiError(error) || !error.isRetryable) {
      return yield* providerFailure(stage, error, attempt, false);
    }

    const delay = retryDelayMilliseconds(error, policy);
    const now = yield* Clock.currentTimeMillis;
    const elapsedMs = Math.max(0, now - startedAt, scheduledDelay);
    if (
      attempt >= policy.providerMaxAttempts ||
      elapsedMs + delay > policy.providerMaxElapsedMilliseconds
    ) {
      return yield* providerFailure(stage, error, attempt, true);
    }

    yield* Effect.sleep(Duration.millis(delay));
    scheduledDelay += delay;
  }

  return yield* new DecisionModelError({
    stage,
    reason: "DecisionModel retry policy ended without a provider result",
    attempts: policy.providerMaxAttempts,
  });
});

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

const combineUsages = (
  usages: ReadonlyArray<DecisionModel.DecisionUsage>,
): { readonly inputTokens: number | undefined; readonly outputTokens: number | undefined } =>
  usages.reduce<{
    readonly inputTokens: number | undefined;
    readonly outputTokens: number | undefined;
  }>(
    (total, usage) => ({
      inputTokens: addUsage(total.inputTokens, usage.inputTokens),
      outputTokens: addUsage(total.outputTokens, usage.outputTokens),
    }),
    { inputTokens: undefined, outputTokens: undefined },
  );

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
      const boundedEnd = Math.min(section.end, start + size);
      const backedUpEnd = moveToUtf8Boundary(text, boundedEnd, "backward");
      const end =
        backedUpEnd > start
          ? backedUpEnd
          : Math.min(section.end, moveToUtf8Boundary(text, boundedEnd, "forward"));
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
      start = moveToUtf8Boundary(text, Math.max(start + 1, end - overlap), "forward");
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

const rankDocumentCandidates = (
  documents: ReadonlyArray<CatalogDocument>,
  question: string,
  limit: number = knownRfcPolicy.maxDocumentCandidates,
): ReadonlyArray<DocumentCandidate> => {
  if (documents.length === 0 || question.trim().length === 0 || limit <= 0) return [];

  const search = new MiniSearch<CatalogDocument>({
    fields: ["identifier", "title", "abstract"],
    storeFields: ["identifier", "title", "abstract"],
    searchOptions: {
      boost: { identifier: 3, title: 2, abstract: 1 },
      combineWith: "OR",
      prefix: true,
      fuzzy: 0.2,
    },
  });
  search.addAll(documents.map((document) => ({ ...document, id: document.identifier })));
  const byIdentifier = new Map(documents.map((document) => [document.identifier, document]));

  return search
    .search(question)
    .sort(
      (left, right) =>
        right.score - left.score ||
        Number(byIdentifier.get(String(left.id))?.rfcNumber ?? 0) -
          Number(byIdentifier.get(String(right.id))?.rfcNumber ?? 0),
    )
    .slice(0, limit)
    .flatMap((result) => {
      const document = byIdentifier.get(String(result.id));
      return document === undefined ? [] : [{ document, lexicalScore: result.score }];
    });
};

/**
 * Deterministically shortlist published catalog documents for topic discovery.
 *
 * @param documents Published RFC metadata from a fresh catalog.
 * @param question Atomic research question.
 * @param limit Maximum number of document candidates.
 * @returns Ranked, bounded published RFC documents.
 */
export const shortlistDocumentCandidates = (
  documents: ReadonlyArray<CatalogDocument>,
  question: string,
  limit: number = knownRfcPolicy.maxDocumentCandidates,
): ReadonlyArray<CatalogDocument> =>
  rankDocumentCandidates(documents, question, limit).map(({ document }) => document);

const isConfidentAtomic = (atomicity: AtomicityResult, policy: ResearchPolicy): boolean =>
  atomicity.label === "atomic" &&
  (atomicity.probabilities.atomic ?? 0) >= policy.relationConfidenceThreshold &&
  atomicity.confidence !== undefined &&
  atomicity.confidence >= policy.relationConfidenceThreshold;

const documentDecisionKey = (index: number): string => `document_${index}`;

const passageDecisionKey = (index: number): string => `passage_${index}`;

const documentDecision = (candidate: DocumentCandidate, index: number): Decision.Any => {
  const key = documentDecisionKey(index);
  const { document } = candidate;
  return Decision.probability({
    instructions: [
      `Evaluate only published RFC candidate ${key} at index ${index}.`,
      `The exact candidate is keyed as input.documents["${key}"], with identifier, title, and abstract fields.`,
      `Its identifier is ${document.identifier}, its title is ${document.title}, and its abstract is ${document.abstract}.`,
      "Ignore every other document candidate when answering this decision.",
    ].join(" "),
    criteria: {
      false: `Candidate ${key} (${document.identifier}) is not likely to contain evidence that answers the question.`,
      true: `Candidate ${key} (${document.identifier}) is likely to contain evidence that answers the question.`,
    },
  });
};

const passageSelectionDecision = (candidate: SourceBlock, index: number): Decision.Any => {
  const key = passageDecisionKey(index);
  return Decision.probability({
    instructions: [
      `Evaluate only exact RFC source block candidate ${key} at index ${index}.`,
      `The exact candidate is keyed as input.passages["${key}"], and its full passage content is input.passages["${key}"].text.`,
      `Its source-block identifier is ${candidate.id} and its section is ${candidate.section ?? "unknown"}.`,
      "Ignore every other passage candidate when answering this decision.",
    ].join(" "),
    criteria: {
      false: `Source block ${key} (${candidate.id}) does not contain evidence that answers the question.`,
      true: `Source block ${key} (${candidate.id}) contains evidence that answers the question.`,
    },
  });
};

const passageRelationDecision = (candidate: SourceBlock, index: number): Decision.Any => {
  const key = passageDecisionKey(index);
  return Decision.classify({
    instructions: [
      `Classify only exact RFC source block candidate ${key} at index ${index}.`,
      `The exact candidate is keyed as input.passages["${key}"], and its full passage content is input.passages["${key}"].text.`,
      `Its source-block identifier is ${candidate.id} and its section is ${candidate.section ?? "unknown"}.`,
      "Ignore every other passage candidate when answering this decision.",
    ].join(" "),
    criteria: Object.fromEntries(
      Object.entries(answerRelationCriteria).map(([label, description]) => [
        label,
        `Candidate ${key} (${candidate.id}): ${description}`,
      ]),
    ),
  });
};

const documentSelectionStage = Effect.fnUntraced(function* (
  question: string,
  candidates: ReadonlyArray<DocumentCandidate>,
  policy: ResearchPolicy,
): Effect.fn.Return<DocumentSelectionResult, DecisionModelError, DecisionModel.DecisionModel> {
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
      documentDecisionKey(index),
      documentDecision(candidate, index),
    ]),
  ]) as Record<string, Decision.Any>;
  const definition = Decision.make({ input: DocumentBatchInputSchema, decisions });
  const model = yield* DecisionModel.DecisionModel;
  const response = yield* decideWithRetry(
    "document",
    () =>
      model.decide(definition, {
        input: {
          question,
          documents: Object.fromEntries(
            candidates.map(({ document }, index) => [
              documentDecisionKey(index),
              {
                identifier: document.identifier,
                title: document.title,
                abstract: document.abstract,
              },
            ]),
          ),
        },
      }),
    policy,
  );
  const answers = yield* providerAnswers("document", response);
  const atomicityAnswer = answers.question_atomicity;
  if (!Predicate.isObject(atomicityAnswer)) {
    return yield* new DecisionModelError({
      stage: "document",
      reason: "Provider omitted the question atomicity answer",
    });
  }
  const label = atomicityAnswer.label;
  if (
    !Predicate.isString(label) ||
    !Object.prototype.hasOwnProperty.call(atomicityCriteria, label)
  ) {
    return yield* new DecisionModelError({
      stage: "document",
      reason: "Provider returned an unknown question atomicity label",
    });
  }
  const atomicity: AtomicityResult = {
    label: label as AtomicityLabel,
    probabilities: yield* decodeProbabilityMap(
      "document",
      "question_atomicity",
      atomicityAnswer.probabilities,
      Object.keys(atomicityCriteria),
    ),
    confidence: yield* decodeConfidence(
      "document",
      "question_atomicity",
      atomicityAnswer.confidence,
    ),
  };
  const diagnostics: Array<{ readonly candidateId: string; readonly probability: number }> = [];
  for (const [index, candidate] of candidates.entries()) {
    const candidateId = documentDecisionKey(index);
    const answer = answers[candidateId];
    if (!Predicate.isObject(answer)) {
      return yield* new DecisionModelError({
        stage: "document",
        reason: `Provider omitted the document probability for ${candidate.document.identifier}`,
      });
    }
    diagnostics.push({
      candidateId: candidate.document.identifier,
      probability: yield* decodeProbability(
        "document",
        candidate.document.identifier,
        answer.probability,
      ),
    });
  }
  const usage = yield* decodeUsage(
    "document",
    Predicate.isObject(response) ? response.usage : undefined,
  );
  const accepted = isConfidentAtomic(atomicity, policy)
    ? candidates
        .map((candidate, index) => ({
          document: candidate.document,
          lexicalScore: candidate.lexicalScore,
          probability: diagnostics[index]?.probability ?? 0,
        }))
        .filter(({ probability }) => probability >= policy.documentProbabilityThreshold)
        .sort(
          (left, right) =>
            right.probability - left.probability ||
            right.lexicalScore - left.lexicalScore ||
            left.document.rfcNumber - right.document.rfcNumber,
        )
        .slice(0, policy.maxAcceptedDocumentCandidates)
    : [];
  return { accepted, atomicity, diagnostics, usage };
});

const selectionStage = Effect.fnUntraced(function* (
  question: string,
  candidates: ReadonlyArray<SourceBlock>,
  policy: ResearchPolicy,
  includeAtomicity: boolean,
): Effect.fn.Return<SelectionResult, DecisionModelError, DecisionModel.DecisionModel> {
  const decisions = Object.fromEntries([
    ...(includeAtomicity
      ? [
          [
            "question_atomicity",
            Decision.classify({
              instructions:
                "Determine whether the request contains one atomic question or multiple questions.",
              criteria: atomicityCriteria,
            }),
          ],
        ]
      : []),
    ...candidates.map((candidate, index) => [
      passageDecisionKey(index),
      passageSelectionDecision(candidate, index),
    ]),
  ]) as Record<string, Decision.Any>;
  const definition = Decision.make({ input: PassageBatchInputSchema, decisions });
  const model = yield* DecisionModel.DecisionModel;
  const response = yield* decideWithRetry(
    "selection",
    () =>
      model.decide(definition, {
        input: {
          question,
          passages: Object.fromEntries(
            candidates.map((candidate, index) => [
              passageDecisionKey(index),
              {
                id: candidate.id,
                section: candidate.section,
                text: candidate.text,
              },
            ]),
          ),
        },
      }),
    policy,
  );
  const answers = yield* providerAnswers("selection", response);
  let atomicity: AtomicityResult | undefined;
  if (includeAtomicity) {
    const atomicityAnswer = answers.question_atomicity;
    if (!Predicate.isObject(atomicityAnswer)) {
      return yield* new DecisionModelError({
        stage: "selection",
        reason: "Provider omitted the question atomicity answer",
      });
    }
    const label = atomicityAnswer.label;
    if (
      !Predicate.isString(label) ||
      !Object.prototype.hasOwnProperty.call(atomicityCriteria, label)
    ) {
      return yield* new DecisionModelError({
        stage: "selection",
        reason: "Provider returned an unknown question atomicity label",
      });
    }
    atomicity = {
      label: label as AtomicityLabel,
      probabilities: yield* decodeProbabilityMap(
        "selection",
        "question_atomicity",
        atomicityAnswer.probabilities,
        Object.keys(atomicityCriteria),
      ),
      confidence: yield* decodeConfidence(
        "selection",
        "question_atomicity",
        atomicityAnswer.confidence,
      ),
    };
  }
  const diagnostics: Array<{ readonly candidateId: string; readonly probability: number }> = [];
  for (const [index, candidate] of candidates.entries()) {
    const candidateId = passageDecisionKey(index);
    const answer = answers[candidateId];
    if (!Predicate.isObject(answer)) {
      return yield* new DecisionModelError({
        stage: "selection",
        reason: `Provider omitted the passage probability for ${candidate.id}`,
      });
    }
    diagnostics.push({
      candidateId: candidate.id,
      probability: yield* decodeProbability("selection", candidate.id, answer.probability),
    });
  }
  const usage = yield* decodeUsage(
    "selection",
    Predicate.isObject(response) ? response.usage : undefined,
  );
  return {
    selected:
      atomicity === undefined || isConfidentAtomic(atomicity, policy)
        ? candidates.flatMap((candidate, index) => {
            const probability = diagnostics[index]?.probability ?? 0;
            return probability >= policy.selectionProbabilityThreshold
              ? [{ block: candidate, probability }]
              : [];
          })
        : [],
    atomicity,
    diagnostics,
    usage,
  };
});

const relationStage = Effect.fnUntraced(function* (
  question: string,
  selected: ReadonlyArray<{ readonly block: SourceBlock; readonly probability: number }>,
  policy: ResearchPolicy,
): Effect.fn.Return<RelationResult, DecisionModelError, DecisionModel.DecisionModel> {
  if (selected.length === 0) {
    return {
      answers: [],
      diagnostics: [],
      usage: new DecisionModel.DecisionUsage({ inputTokens: undefined, outputTokens: undefined }),
    };
  }
  const decisions = Object.fromEntries(
    selected.map(({ block }, index) => [
      passageDecisionKey(index),
      passageRelationDecision(block, index),
    ]),
  ) as Record<string, Decision.Any>;
  const definition = Decision.make({ input: PassageBatchInputSchema, decisions });
  const model = yield* DecisionModel.DecisionModel;
  const response = yield* decideWithRetry(
    "relation",
    () =>
      model.decide(definition, {
        input: {
          question,
          passages: Object.fromEntries(
            selected.map(({ block }, index) => [
              passageDecisionKey(index),
              {
                id: block.id,
                section: block.section,
                text: block.text,
              },
            ]),
          ),
        },
      }),
    policy,
  );
  const answers = yield* providerAnswers("relation", response);
  const decodedAnswers: Array<RelationResult["answers"][number]> = [];
  for (const [index, candidate] of selected.entries()) {
    const candidateId = passageDecisionKey(index);
    const answer = answers[candidateId];
    if (!Predicate.isObject(answer)) {
      return yield* new DecisionModelError({
        stage: "relation",
        reason: `Provider omitted the answer relation for ${candidate.block.id}`,
      });
    }
    const relation = answer.label;
    if (
      !Predicate.isString(relation) ||
      !Object.prototype.hasOwnProperty.call(answerRelationCriteria, relation)
    ) {
      return yield* new DecisionModelError({
        stage: "relation",
        reason: `Provider returned an unknown answer relation for ${candidate.block.id}`,
      });
    }
    decodedAnswers.push({
      block: candidate.block,
      selectionProbability: candidate.probability,
      relation: relation as AnswerRelation,
      probabilities: yield* decodeProbabilityMap(
        "relation",
        candidate.block.id,
        answer.probabilities,
        Object.keys(answerRelationCriteria),
      ),
      confidence: yield* decodeConfidence("relation", candidate.block.id, answer.confidence),
    });
  }
  const usage = yield* decodeUsage(
    "relation",
    Predicate.isObject(response) ? response.usage : undefined,
  );
  return {
    answers: decodedAnswers,
    diagnostics: decodedAnswers.map((answer) => ({
      candidateId: answer.block.id,
      relation: answer.relation,
      probabilities: answer.probabilities,
      confidence: answer.confidence ?? null,
    })),
    usage,
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
  atomicity: SelectionResult["atomicity"] | AtomicityResult | undefined,
  selectionDiagnostics: ReadonlyArray<SelectionResult["diagnostics"][number]>,
  policy: ResearchPolicy,
): ResearchStatus => {
  if (atomicity === undefined) return "needs_review";
  const atomicityConfident =
    atomicity.confidence !== undefined &&
    atomicity.confidence >= policy.relationConfidenceThreshold &&
    (atomicity.probabilities[atomicity.label] ?? 0) >= policy.relationConfidenceThreshold;
  if (atomicity.label === "compound" && atomicityConfident) {
    return "needs_split";
  }
  if (!atomicityConfident) return "needs_review";

  const accepted = answers.filter((answer) =>
    acceptedRelation(answer.relation, answer.probabilities, answer.confidence, policy),
  );
  const contradictory = answers.some((answer) => answer.relation === "contradictory");
  const uncertainAnswer = answers.some(
    (answer) =>
      !acceptedRelation(answer.relation, answer.probabilities, answer.confidence, policy) &&
      !confidentNegativeRelation(answer, policy),
  );
  const direct = accepted.some((answer) => answer.relation === "direct_answer");
  const partial = accepted.some((answer) => answer.relation === "partial_answer");
  if (contradictory || uncertainAnswer) return "needs_review";
  if (direct) return "answered";
  if (partial) return "partial";
  if (answers.length > 0 && answers.every((answer) => confidentNegativeRelation(answer, policy))) {
    return "unsupported";
  }
  if (
    answers.length === 0 &&
    selectionDiagnostics.length > 0 &&
    selectionDiagnostics.every(
      (candidate) => candidate.probability <= policy.unsupportedProbabilityThreshold,
    )
  ) {
    return "unsupported";
  }
  return "needs_review";
};

type PassageSource = {
  readonly document: CatalogDocument;
  readonly source: RfcSource;
};

const sourceDiagnostic = (source: RfcSource) => ({
  identifier: source.identifier,
  rfcNumber: source.rfcNumber,
  sourceUrl: source.sourceUrl,
  sourceHash: source.contentHash,
  fetchedAt: source.fetchedAt,
});

const evidenceFromRelations = (
  answers: ReadonlyArray<RelationResult["answers"][number]>,
  sources: ReadonlyMap<string, PassageSource>,
  policy: ResearchPolicy,
): ReadonlyArray<EvidencePassage> =>
  answers
    .filter((answer) =>
      acceptedRelation(answer.relation, answer.probabilities, answer.confidence, policy),
    )
    .flatMap((answer) => {
      const context = sources.get(answer.block.id);
      if (context === undefined) return [];
      const offsets = makeUtf8OffsetMap(context.source.text);
      const startOffset = offsets.byteOffsetAtCodeUnit(answer.block.startOffset);
      const endOffset = offsets.byteOffsetAtCodeUnit(answer.block.endOffset);
      if (startOffset === undefined || endOffset === undefined) return [];
      const quote = context.source.text.slice(answer.block.startOffset, answer.block.endOffset);
      return [
        {
          id: answer.block.id,
          quote,
          relation: answer.relation,
          selectionProbability: answer.selectionProbability,
          relationProbabilities: answer.probabilities,
          confidence: answer.confidence ?? null,
          provenance: {
            identifier: context.document.identifier,
            rfcNumber: context.document.rfcNumber,
            sourceUrl: context.source.sourceUrl,
            canonicalUrl: context.document.canonicalUrl,
            sourceHash: context.source.contentHash,
            offsetUnit: utf8OffsetUnit,
            startOffset,
            endOffset,
            section: answer.block.section,
            fetchedAt: context.source.fetchedAt,
          },
        } satisfies EvidencePassage,
      ];
    });

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
  const document = yield* Effect.try({
    try: () => resolveKnownRfc(options.catalog, hint),
    catch: (error) =>
      error instanceof RfcNotFoundError ? error : new RfcNotFoundError({ rfc: hint }),
  });
  const sourceStarted = yield* Clock.currentTimeMillis;
  const source = yield* loadRfcSource(document, options.sourceDirectory);
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
  const selection = yield* selectionStage(question, candidates, policy, true);
  const selectionFinished = yield* Clock.currentTimeMillis;
  if (selection.atomicity === undefined) {
    return yield* new DecisionModelError({
      stage: "selection",
      reason: "Provider response did not include atomicity diagnostics",
    });
  }
  const relationStarted = selectionFinished;
  const relation = yield* relationStage(question, selection.selected, policy);
  const relationFinished = yield* Clock.currentTimeMillis;
  const resolvedModel = yield* Ref.get(resolvedModelRef);
  const usage = combineUsage(selection.usage, relation.usage);
  const evidence = evidenceFromRelations(
    relation.answers,
    new Map(candidates.map((candidate) => [candidate.id, { document, source }] as const)),
    policy,
  );
  const status = statusFromRelations(
    relation.answers,
    selection.atomicity,
    selection.diagnostics,
    policy,
  );
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
      documentMs: undefined,
    },
    source: sourceDiagnostic(source),
    sources: undefined,
    catalog: options.catalogStatus,
    candidates: {
      sourceBlocks: blocks.length,
      passageCandidates: candidates.length,
      selectedPassages: selection.selected.length,
      catalogDocuments: undefined,
      documentCandidates: undefined,
      acceptedDocuments: undefined,
    },
    atomicity: {
      label: selection.atomicity.label,
      probabilities: selection.atomicity.probabilities,
      confidence: selection.atomicity.confidence ?? null,
    },
    documentSelection: undefined,
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

/**
 * Run topic-only RFC discovery, retrieval, and semantic evidence research.
 *
 * @param question Atomic research question without an RFC hint.
 * @param options Fresh catalog, cache, provider, and timing configuration.
 * @returns A versioned evidence bundle with exact provenance and discovery diagnostics.
 */
export const researchTopic = Effect.fnUntraced(function* (
  question: string,
  options: KnownRfcResearchOptions,
): Effect.fn.Return<
  EvidenceBundle,
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
  const documentLexicalStarted = yield* Clock.currentTimeMillis;
  const documentCandidates = rankDocumentCandidates(
    options.catalog.documents,
    question,
    policy.maxDocumentCandidates,
  );
  const documentLexicalFinished = yield* Clock.currentTimeMillis;
  const documentStarted = documentLexicalFinished;
  const documentSelection = yield* documentSelectionStage(question, documentCandidates, policy);
  const documentFinished = yield* Clock.currentTimeMillis;

  const makeEmptyDiagnostics = (
    finishedAt: number,
    resolvedModel: string,
  ): ResearchDiagnostics => ({
    schemaVersion: 1,
    policyVersion: policy.policyVersion,
    requestedModel: options.modelAlias,
    resolvedModel,
    usage: {
      inputTokens: documentSelection.usage.inputTokens ?? null,
      outputTokens: documentSelection.usage.outputTokens ?? null,
    },
    timings: {
      catalogMs: options.catalogMs,
      sourceMs: 0,
      lexicalMs: elapsed(documentLexicalStarted, documentLexicalFinished),
      selectionMs: 0,
      relationMs: 0,
      totalMs: elapsed(options.startedAt, finishedAt),
      documentMs: elapsed(documentStarted, documentFinished),
    },
    source: null,
    sources: [],
    catalog: options.catalogStatus,
    candidates: {
      catalogDocuments: options.catalog.documents.length,
      documentCandidates: documentCandidates.length,
      acceptedDocuments: 0,
      sourceBlocks: 0,
      passageCandidates: 0,
      selectedPassages: 0,
    },
    atomicity: {
      label: documentSelection.atomicity.label,
      probabilities: documentSelection.atomicity.probabilities,
      confidence: documentSelection.atomicity.confidence ?? null,
    },
    documentSelection: documentSelection.diagnostics,
    selection: [],
    classification: [],
  });

  if (documentSelection.accepted.length === 0) {
    const finishedAt = yield* Clock.currentTimeMillis;
    const status = statusFromRelations([], documentSelection.atomicity, [], policy);
    const resolvedModel = yield* Ref.get(resolvedModelRef);
    const diagnostics = makeEmptyDiagnostics(finishedAt, resolvedModel);
    return Schema.decodeUnknownSync(EvidenceBundleSchema)({
      schemaVersion: 1,
      kind: "evidence_bundle",
      status,
      question,
      rfc: null,
      evidence: [],
      diagnostics,
    });
  }

  const primaryDocument = documentSelection.accepted[0]?.document;
  if (primaryDocument === undefined) {
    return yield* new DecisionModelError({
      stage: "document",
      reason: "No accepted document was available for source research",
    });
  }

  const sourceStarted = yield* Clock.currentTimeMillis;
  const sourceContexts: Array<PassageSource> = [];
  for (const accepted of documentSelection.accepted) {
    sourceContexts.push({
      document: accepted.document,
      source: yield* loadRfcSource(accepted.document, options.sourceDirectory),
    });
  }
  const sourceFinished = yield* Clock.currentTimeMillis;
  const primarySource = sourceContexts[0];
  if (primarySource === undefined) {
    return yield* new DecisionModelError({
      stage: "document",
      reason: "No accepted document source was loaded",
    });
  }
  const allBlocks: Array<SourceBlock> = [];
  const blockSources = new Map<string, PassageSource>();
  for (const context of sourceContexts) {
    const blocks = parseSourceBlocks(
      context.source.text,
      policy.sourceBlockMaxCharacters,
      policy.sourceBlockOverlapCharacters,
    );
    for (const block of blocks) {
      const namespacedBlock = {
        ...block,
        id: `${context.document.identifier}:${block.id}`,
      };
      const decodedBlock = Schema.decodeUnknownSync(SourceBlockSchema)(namespacedBlock);
      allBlocks.push(decodedBlock);
      blockSources.set(decodedBlock.id, context);
    }
  }
  const candidates = shortlistPassageCandidates(allBlocks, question, policy.maxPassageCandidates);
  const lexicalFinished = yield* Clock.currentTimeMillis;
  const selectionStarted = lexicalFinished;
  const selection = yield* selectionStage(question, candidates, policy, false);
  const selectionFinished = yield* Clock.currentTimeMillis;
  const relationStarted = selectionFinished;
  const relation = yield* relationStage(question, selection.selected, policy);
  const relationFinished = yield* Clock.currentTimeMillis;
  const finishedAt = yield* Clock.currentTimeMillis;
  const resolvedModel = yield* Ref.get(resolvedModelRef);
  const usage = combineUsages([documentSelection.usage, selection.usage, relation.usage]);
  const evidence = evidenceFromRelations(relation.answers, blockSources, policy);
  const status = statusFromRelations(
    relation.answers,
    documentSelection.atomicity,
    selection.diagnostics,
    policy,
  );
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
      lexicalMs: elapsed(documentLexicalStarted, lexicalFinished),
      selectionMs: elapsed(selectionStarted, selectionFinished),
      relationMs: elapsed(relationStarted, relationFinished),
      totalMs: elapsed(options.startedAt, finishedAt),
      documentMs: elapsed(documentStarted, documentFinished),
    },
    source: sourceDiagnostic(primarySource.source),
    sources: sourceContexts.map((context) => sourceDiagnostic(context.source)),
    catalog: options.catalogStatus,
    candidates: {
      catalogDocuments: options.catalog.documents.length,
      documentCandidates: documentCandidates.length,
      acceptedDocuments: documentSelection.accepted.length,
      sourceBlocks: allBlocks.length,
      passageCandidates: candidates.length,
      selectedPassages: selection.selected.length,
    },
    atomicity: {
      label: documentSelection.atomicity.label,
      probabilities: documentSelection.atomicity.probabilities,
      confidence: documentSelection.atomicity.confidence ?? null,
    },
    documentSelection: documentSelection.diagnostics,
    selection: selection.diagnostics,
    classification: relation.diagnostics,
  } satisfies ResearchDiagnostics;

  return Schema.decodeUnknownSync(EvidenceBundleSchema)({
    schemaVersion: 1,
    kind: "evidence_bundle",
    status,
    question,
    rfc: primaryDocument,
    evidence,
    diagnostics,
  });
});
