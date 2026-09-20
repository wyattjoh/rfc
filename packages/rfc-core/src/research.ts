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
import { LiveRetrievalTraceSchema } from "./discovery";
import { LiveRfcSource, RfcSourceRevalidationError } from "./live-source";
import { makeUtf8OffsetMap, moveToUtf8Boundary, utf8OffsetUnit } from "./offsets";
import { isAutomaticAnswerActivation, type AutomaticAnswerActivation } from "./activation";
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
 * Provider-resolved model identifiers observed across every semantic call.
 */
export class ResolvedModelNames extends Context.Service<
  ResolvedModelNames,
  Ref.Ref<ReadonlyArray<string>>
>()("@wyattjoh/rfc/ResolvedModelNames") {}

/**
 * Collapse provider observations into one safe public model identity.
 *
 * @param fallback The configured or last observed model identifier.
 * @param observed Model identifiers returned by provider calls.
 * @returns The sole observed model or `mixed` when providers disagree.
 */
export const summarizeResolvedModels = (
  fallback: string,
  observed: ReadonlyArray<string>,
): string => {
  const models = [...new Set(observed)];
  return models.length === 0 ? fallback : models.length === 1 ? (models[0] ?? fallback) : "mixed";
};

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
 * The role of an RFC in a currency-aware research result.
 */
export const RfcContextRoleSchema = Schema.Literals(["requested", "current"]);

/**
 * The role of an RFC in a currency-aware research result.
 */
export type RfcContextRole = Schema.Schema.Type<typeof RfcContextRoleSchema>;

/**
 * One directed catalog relationship followed while resolving RFC currency.
 */
export const RfcRelationshipStepSchema = Schema.Struct({
  from: Schema.NonEmptyString,
  to: Schema.NonEmptyString,
  relationship: Schema.Literals(["updates", "obsoletes"]),
});

/**
 * One directed relationship in the path from a requested RFC to a current RFC.
 */
export type RfcRelationshipStep = Schema.Schema.Type<typeof RfcRelationshipStepSchema>;

/**
 * A known RFC context returned with an evidence bundle.
 */
export const RfcResearchContextSchema = Schema.Struct({
  role: RfcContextRoleSchema,
  document: CatalogDocumentSchema,
  relationshipPath: Schema.Array(RfcRelationshipStepSchema),
  isCurrent: Schema.Boolean,
  state: Schema.Literals(["researched", "unavailable"]),
});

/**
 * A requested or current RFC context included in a research result.
 */
export type RfcResearchContext = Schema.Schema.Type<typeof RfcResearchContextSchema>;

/**
 * The bounded failure modes recorded while resolving RFC currency.
 */
export const RfcCurrencyIssueSchema = Schema.Literals([
  "missing_successor",
  "malformed_relationship",
  "cycle_detected",
  "traversal_limit",
  "missing_current_context",
  "missing_current_source",
]);

/**
 * A bounded issue reported by RFC relationship traversal or current-context research.
 */
export type RfcCurrencyIssue = Schema.Schema.Type<typeof RfcCurrencyIssueSchema>;

/**
 * The deterministic compatibility judgment between requested and current evidence.
 */
export const RfcCurrencyCompatibilitySchema = Schema.Struct({
  requested: Schema.NonEmptyString,
  current: Schema.NonEmptyString,
  outcome: Schema.Literals(["compatible", "conflicting", "uncertain"]),
});

/**
 * A compatibility judgment recorded for one current RFC context.
 */
export type RfcCurrencyCompatibility = Schema.Schema.Type<typeof RfcCurrencyCompatibilitySchema>;

const RfcCurrencyPathSchema = Schema.Struct({
  identifier: Schema.NonEmptyString,
  path: Schema.Array(RfcRelationshipStepSchema),
});

/**
 * The deterministic requested-to-current RFC relationship report.
 */
export const RfcCurrencyReportSchema = Schema.Struct({
  requested: Schema.NonEmptyString,
  current: Schema.Array(Schema.NonEmptyString),
  paths: Schema.Array(RfcCurrencyPathSchema),
  complete: Schema.Boolean,
  issues: Schema.Array(RfcCurrencyIssueSchema),
  unresolved: Schema.Array(Schema.NonEmptyString),
  compatibility: Schema.Array(RfcCurrencyCompatibilitySchema),
});

/**
 * A relationship traversal report included in a research result.
 */
export type RfcCurrencyReport = Schema.Schema.Type<typeof RfcCurrencyReportSchema>;

/**
 * Versioned policy values for known-RFC research.
 */
export const knownRfcPolicy = {
  policyVersion: "precision-v1",
  maxDocumentCandidates: 8,
  maxAcceptedDocumentCandidates: 3,
  // Round-5 calibration showed relevant candidates at or above 0.35; retain
  // the bounded top-three shortlist and let passage/relation gates decide.
  documentProbabilityThreshold: 0.35,
  maxPassageCandidates: 8,
  sourceBlockMaxCharacters: 4_000,
  sourceBlockOverlapCharacters: 200,
  maxCurrencyTraversalDepth: 16,
  maxCurrencyContexts: 8,
  currencyCompatibilityOverlapThreshold: 0.6,
  // The live model placed relevant source blocks at 0.45–0.49. Including
  // those blocks is safe because relation acceptance remains independently
  // gated below; excluding them made valid answers impossible to judge.
  selectionProbabilityThreshold: 0.45,
  unsupportedProbabilityThreshold: 0.35,
  relationConfidenceThreshold: 0.65,
  providerMaxAttempts: 3,
  providerMaxElapsedMilliseconds: 10_000,
  providerDefaultRetryDelayMilliseconds: 100,
  directAnswerProbabilityThreshold: 0.65,
  partialAnswerProbabilityThreshold: 0.6,
  contradictoryProbabilityThreshold: 0.65,
  // Calibration gates are part of the named policy so that a threshold,
  // retry budget, or latency target cannot drift independently of evaluation.
  minimumSupportedClaimPrecision: 0.98,
  maxKnownRfcP95LatencyMilliseconds: 2_000,
  maxTopicP95LatencyMilliseconds: 3_000,
  evaluationModelAlias: "jev-latest",
  pinnedModel: "jev-1.13.0",
  // Release commits must explicitly activate automatic answers only after the
  // committed evaluation gate has passed; the composition proof is absent by default.
  automaticAnswerActivation: undefined,
} as const;

/**
 * The calibrated precision-first policy used by research and evaluation.
 */
export const precisionPolicy = knownRfcPolicy;

/**
 * The acceptance and uncertainty rules for one research policy preset.
 */
export type ResearchPolicy = Omit<typeof knownRfcPolicy, "automaticAnswerActivation"> & {
  readonly automaticAnswerActivation: AutomaticAnswerActivation | undefined;
};

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
  context: RfcContextRoleSchema,
  relationshipPath: Schema.Array(RfcRelationshipStepSchema),
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
  context: RfcContextRoleSchema,
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

const ContextSourceDiagnosticSchema = Schema.Struct({
  context: RfcContextRoleSchema,
  source: SourceDiagnosticSchema,
});

const ContextDiagnosticsSchema = Schema.Struct({
  context: RfcContextRoleSchema,
  identifier: Schema.NonEmptyString,
  relationshipPath: Schema.Array(RfcRelationshipStepSchema),
  state: Schema.Literals(["researched", "unavailable"]),
  status: Schema.NullOr(ResearchStatusSchema),
  source: Schema.NullOr(SourceDiagnosticSchema),
  usage: TokenUsageSchema,
  timings: TimingSchema,
  candidates: CandidateCountsSchema,
  atomicity: Schema.NullOr(AtomicityDiagnosticSchema),
  selection: Schema.Array(SelectionDiagnosticSchema),
  classification: Schema.Array(ClassificationDiagnosticSchema),
});

/**
 * Bounded diagnostics for one semantic research operation.
 */
export const ResearchDiagnosticsSchema = Schema.Struct({
  schemaVersion: Schema.Literals([1, 2]),
  policyVersion: Schema.NonEmptyString,
  requestedModel: Schema.NonEmptyString,
  resolvedModel: Schema.NonEmptyString,
  resolvedModels: Schema.Array(Schema.NonEmptyString),
  usage: TokenUsageSchema,
  timings: TimingSchema,
  source: Schema.NullOr(SourceDiagnosticSchema),
  sources: Schema.Union([
    Schema.Array(SourceDiagnosticSchema),
    Schema.Array(ContextSourceDiagnosticSchema),
    Schema.Undefined,
  ]),
  catalog: Schema.optionalKey(CatalogStatusSchema),
  retrieval: Schema.optionalKey(LiveRetrievalTraceSchema),
  currency: Schema.optionalKey(RfcCurrencyReportSchema),
  candidates: CandidateCountsSchema,
  atomicity: AtomicityDiagnosticSchema,
  documentSelection: Schema.Union([Schema.Array(SelectionDiagnosticSchema), Schema.Undefined]),
  selection: Schema.Array(SelectionDiagnosticSchema),
  classification: Schema.Array(ClassificationDiagnosticSchema),
  contexts: Schema.optionalKey(Schema.Array(ContextDiagnosticsSchema)),
});

/**
 * Diagnostics returned with an evidence bundle.
 */
export type ResearchDiagnostics = Schema.Schema.Type<typeof ResearchDiagnosticsSchema>;

/**
 * The versioned public result of known-RFC research.
 */
export const EvidenceBundleSchema = Schema.Struct({
  schemaVersion: Schema.Literals([1, 2]),
  kind: Schema.Literal("evidence_bundle"),
  status: ResearchStatusSchema,
  question: Schema.NonEmptyString,
  rfc: Schema.NullOr(CatalogDocumentSchema),
  contexts: Schema.optionalKey(Schema.Array(RfcResearchContextSchema)),
  currency: Schema.optionalKey(RfcCurrencyReportSchema),
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
   * Opaque proof supplied by the composition root for automatic answered statuses.
   */
  readonly automaticAnswerActivation: AutomaticAnswerActivation | undefined;
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
  /**
   * Optional request-local source loader used by schema-version-two research.
   */
  readonly sourceLoader?:
    | ((
        document: CatalogDocument,
      ) => Effect.Effect<
        RfcSource,
        RfcSourceCacheError | RfcSourceFetchError | RfcSourceRevalidationError,
        FileSystem.FileSystem | LiveRfcSource
      >)
    | undefined;
  /**
   * Optional preordered live-discovery candidates for topic research.
   */
  readonly documentCandidates?: ReadonlyArray<CatalogDocument> | undefined;
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

type PlannedRfcContext = {
  readonly role: RfcContextRole;
  readonly document: CatalogDocument;
  readonly relationshipPath: ReadonlyArray<RfcRelationshipStep>;
  readonly isCurrent: boolean;
};

/**
 * The resolved RFC contexts and relationship report used by research.
 */
export interface RfcCurrencyResolution {
  /**
   * The requested RFC and the applicable current RFC contexts.
   */
  readonly contexts: ReadonlyArray<RfcResearchContext>;
  /**
   * The deterministic relationship report for those contexts.
   */
  readonly report: RfcCurrencyReport;
}

type SuccessorEdge = {
  readonly document: CatalogDocument;
  readonly relationship: RfcRelationshipStep["relationship"];
};

type SuccessorLookup = {
  readonly edges: ReadonlyArray<SuccessorEdge>;
  readonly issues: ReadonlyArray<RfcCurrencyIssue>;
  readonly unresolved: ReadonlyArray<string>;
  readonly hasSuccessorMetadata: boolean;
};

const normalizedRfcIdentifier = (value: string): string | undefined => {
  const match = /^RFC([1-9]\d*)$/i.exec(value.trim());
  if (match === null) return undefined;
  const number = Number(match[1]);
  return Number.isSafeInteger(number) && number > 0 ? `RFC${number}` : undefined;
};

const currencyIdentifier = (document: CatalogDocument): string =>
  normalizedRfcIdentifier(document.identifier) ?? document.identifier.toUpperCase();

const compareRfcDocuments = (left: CatalogDocument, right: CatalogDocument): number =>
  left.rfcNumber - right.rfcNumber || left.identifier.localeCompare(right.identifier);

const uniqueCurrencyIssues = (
  issues: ReadonlyArray<RfcCurrencyIssue>,
): ReadonlyArray<RfcCurrencyIssue> => [...new Set(issues)];

const uniqueIdentifiers = (identifiers: ReadonlyArray<string>): ReadonlyArray<string> => [
  ...new Set(identifiers),
];

const successorLookup = (catalog: RfcCatalog, document: CatalogDocument): SuccessorLookup => {
  const documentsByIdentifier = new Map<string, CatalogDocument>();
  for (const candidate of catalog.documents) {
    documentsByIdentifier.set(currencyIdentifier(candidate), candidate);
    documentsByIdentifier.set(candidate.identifier.toUpperCase(), candidate);
  }

  const edges = new Map<string, SuccessorEdge>();
  const issues: Array<RfcCurrencyIssue> = [];
  const unresolved: Array<string> = [];
  let hasSuccessorMetadata = false;

  const addEdge = (identifier: string, relationship: RfcRelationshipStep["relationship"]): void => {
    const normalized = normalizedRfcIdentifier(identifier);
    if (normalized === undefined) {
      issues.push("malformed_relationship");
      return;
    }
    const successor = documentsByIdentifier.get(normalized);
    if (successor === undefined) {
      issues.push("missing_successor");
      unresolved.push(normalized);
      return;
    }
    const key = `${relationship}:${currencyIdentifier(successor)}`;
    edges.set(key, { document: successor, relationship });
  };

  for (const identifier of document.updatedBy) {
    hasSuccessorMetadata = true;
    addEdge(identifier, "updates");
  }
  for (const identifier of document.obsoletedBy) {
    hasSuccessorMetadata = true;
    addEdge(identifier, "obsoletes");
  }

  for (const candidate of catalog.documents) {
    for (const identifier of candidate.updates) {
      const normalized = normalizedRfcIdentifier(identifier);
      if (normalized === undefined) continue;
      if (normalized === currencyIdentifier(document)) {
        hasSuccessorMetadata = true;
        addEdge(candidate.identifier, "updates");
      }
    }
    for (const identifier of candidate.obsoletes) {
      const normalized = normalizedRfcIdentifier(identifier);
      if (normalized === undefined) continue;
      if (normalized === currencyIdentifier(document)) {
        hasSuccessorMetadata = true;
        addEdge(candidate.identifier, "obsoletes");
      }
    }
  }

  const sortedEdges = [...edges.values()].sort(
    (left, right) =>
      compareRfcDocuments(left.document, right.document) ||
      left.relationship.localeCompare(right.relationship),
  );
  return {
    edges: sortedEdges,
    issues: uniqueCurrencyIssues(issues),
    unresolved: uniqueIdentifiers(unresolved),
    hasSuccessorMetadata,
  };
};

const resolveRfcCurrencyFromDocument = (
  catalog: RfcCatalog,
  requested: CatalogDocument,
  maxDepth: number = knownRfcPolicy.maxCurrencyTraversalDepth,
  maxContexts: number = knownRfcPolicy.maxCurrencyContexts,
): RfcCurrencyResolution => {
  const requestedContext: PlannedRfcContext = {
    role: "requested",
    document: requested,
    relationshipPath: [],
    isCurrent: false,
  };
  const expanded = new Set<string>();
  const activePath = new Set<string>();
  const successorLookups = new Map<string, SuccessorLookup>();
  const currentContexts: Array<PlannedRfcContext> = [];
  const issues: Array<RfcCurrencyIssue> = [];
  const unresolved: Array<string> = [];
  let hasSuccessorMetadata = false;
  const contextLimit = Math.max(1, maxContexts);
  const depthLimit = Math.max(0, maxDepth);

  const lookupSuccessors = (document: CatalogDocument): SuccessorLookup => {
    const identifier = currencyIdentifier(document);
    const cached = successorLookups.get(identifier);
    if (cached !== undefined) return cached;
    const lookup = successorLookup(catalog, document);
    successorLookups.set(identifier, lookup);
    return lookup;
  };

  const visit = (
    document: CatalogDocument,
    relationshipPath: ReadonlyArray<RfcRelationshipStep>,
    depth: number,
  ): void => {
    const documentIdentifier = currencyIdentifier(document);
    activePath.add(documentIdentifier);
    const lookup = lookupSuccessors(document);
    issues.push(...lookup.issues);
    unresolved.push(...lookup.unresolved);
    hasSuccessorMetadata ||= lookup.hasSuccessorMetadata;

    if (lookup.edges.length === 0) {
      if (document !== requested && lookup.unresolved.length === 0) {
        currentContexts.push({
          role: "current",
          document,
          relationshipPath,
          isCurrent: true,
        });
      }
      activePath.delete(documentIdentifier);
      expanded.add(documentIdentifier);
      return;
    }

    for (const edge of lookup.edges) {
      const edgePath: RfcRelationshipStep = {
        from: document.identifier,
        to: edge.document.identifier,
        relationship: edge.relationship,
      };
      const successorIdentifier = currencyIdentifier(edge.document);
      if (activePath.has(successorIdentifier)) {
        issues.push("cycle_detected");
        continue;
      }
      if (depth >= depthLimit) {
        issues.push("traversal_limit");
        continue;
      }
      if (expanded.has(successorIdentifier)) continue;
      if (expanded.size >= contextLimit) {
        issues.push("traversal_limit");
        continue;
      }

      expanded.add(successorIdentifier);
      visit(edge.document, [...relationshipPath, edgePath], depth + 1);
    }

    activePath.delete(documentIdentifier);
  };

  const requestedIdentifier = currencyIdentifier(requested);
  expanded.add(requestedIdentifier);
  visit(requested, [], 0);

  const sortedCurrentContexts = currentContexts
    .sort((left, right) => compareRfcDocuments(left.document, right.document))
    .slice(0, Math.max(1, maxContexts));
  if (hasSuccessorMetadata && sortedCurrentContexts.length === 0) {
    issues.push("missing_current_context");
  }

  const currentIdentifiers =
    hasSuccessorMetadata && sortedCurrentContexts.length > 0
      ? sortedCurrentContexts.map(({ document }) => document.identifier)
      : hasSuccessorMetadata
        ? []
        : [requested.identifier];
  const contexts = [requestedContext, ...sortedCurrentContexts].map((context) => ({
    ...context,
    isCurrent: hasSuccessorMetadata ? context.role === "current" : context.role === "requested",
    state: "researched" as const,
  }));
  const report: RfcCurrencyReport = {
    requested: requested.identifier,
    current: currentIdentifiers,
    paths: contexts.map((context) => ({
      identifier: context.document.identifier,
      path: context.relationshipPath,
    })),
    complete: uniqueCurrencyIssues(issues).length === 0,
    issues: uniqueCurrencyIssues(issues),
    unresolved: uniqueIdentifiers(unresolved),
    compatibility: [],
  };
  return { contexts, report };
};

/**
 * Resolve the requested RFC and its bounded current RFC contexts.
 *
 * @param catalog Fresh published RFC metadata.
 * @param hint RFC identifier or number supplied by the caller.
 * @returns Requested and current contexts plus their relationship report.
 * @throws RfcNotFoundError when the hint is not an exact catalog entry.
 */
export const resolveRfcCurrency = (catalog: RfcCatalog, hint: string): RfcCurrencyResolution =>
  resolveRfcCurrencyFromDocument(catalog, resolveKnownRfc(catalog, hint));

/**
 * Resolve current contexts from an already resolved requested RFC.
 *
 * @param catalog Fresh published RFC metadata.
 * @param requested Requested RFC document from the same catalog.
 * @returns Requested and current contexts plus their relationship report.
 */
export const resolveRfcContexts = (
  catalog: RfcCatalog,
  requested: CatalogDocument,
): RfcCurrencyResolution => resolveRfcCurrencyFromDocument(catalog, requested);

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
  // Once one or more passages pass the relation gates, rejected distractors
  // are not evidence and must not suppress an otherwise accepted answer. A
  // contradictory label remains disqualifying above, so this relaxation does
  // not permit conflicting evidence to become automatic.
  const uncertainAnswer =
    accepted.length === 0 &&
    answers.some(
      (answer) =>
        !acceptedRelation(answer.relation, answer.probabilities, answer.confidence, policy) &&
        !confidentNegativeRelation(answer, policy),
    );
  const direct = accepted.some((answer) => answer.relation === "direct_answer");
  const partial = accepted.some((answer) => answer.relation === "partial_answer");
  if (contradictory || uncertainAnswer) return "needs_review";
  if (direct && isAutomaticAnswerActivation(policy.automaticAnswerActivation)) return "answered";
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

type ContextResearchResult = {
  readonly context: RfcResearchContext;
  readonly source: RfcSource;
  readonly status: ResearchStatus;
  readonly evidence: ReadonlyArray<EvidencePassage>;
  readonly diagnostics: Schema.Schema.Type<typeof ContextDiagnosticsSchema>;
  readonly usage: {
    readonly inputTokens: number | undefined;
    readonly outputTokens: number | undefined;
  };
  readonly timings: Schema.Schema.Type<typeof TimingSchema>;
};

type UnavailableContextResult = {
  readonly context: RfcResearchContext;
  readonly diagnostics: Schema.Schema.Type<typeof ContextDiagnosticsSchema>;
};

type PassageSource = {
  readonly document: CatalogDocument;
  readonly source: RfcSource;
  readonly context: RfcContextRole;
  readonly relationshipPath: ReadonlyArray<RfcRelationshipStep>;
};

const sourceDiagnostic = (
  source: RfcSource,
): Schema.Schema.Type<typeof SourceDiagnosticSchema> => ({
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
          context: context.context,
          quote,
          relation: answer.relation,
          selectionProbability: answer.selectionProbability,
          relationProbabilities: answer.probabilities,
          confidence: answer.confidence ?? null,
          provenance: {
            identifier: context.document.identifier,
            rfcNumber: context.document.rfcNumber,
            context: context.context,
            relationshipPath: context.relationshipPath,
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

const zeroUsage = (): Schema.Schema.Type<typeof TokenUsageSchema> => ({
  inputTokens: null,
  outputTokens: null,
});

const zeroTimings = (): Schema.Schema.Type<typeof TimingSchema> => ({
  catalogMs: 0,
  sourceMs: 0,
  lexicalMs: 0,
  selectionMs: 0,
  relationMs: 0,
  totalMs: 0,
  documentMs: undefined,
});

const emptyCandidates = (): Schema.Schema.Type<typeof CandidateCountsSchema> => ({
  sourceBlocks: 0,
  passageCandidates: 0,
  selectedPassages: 0,
  catalogDocuments: undefined,
  documentCandidates: undefined,
  acceptedDocuments: undefined,
});

const researchContext = Effect.fnUntraced(function* (
  question: string,
  plannedContext: PlannedRfcContext,
  options: KnownRfcResearchOptions,
  policy: ResearchPolicy,
): Effect.fn.Return<
  ContextResearchResult,
  RfcSourceCacheError | RfcSourceFetchError | RfcSourceRevalidationError | DecisionModelError,
  | FileSystem.FileSystem
  | RfcSourceStore
  | RfcSourceServiceTag
  | LiveRfcSource
  | DecisionModel.DecisionModel
> {
  const sourceStarted = yield* Clock.currentTimeMillis;
  const source = yield* options.sourceLoader === undefined
    ? loadRfcSource(plannedContext.document, options.sourceDirectory)
    : options.sourceLoader(plannedContext.document);
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
  const status = statusFromRelations(
    relation.answers,
    selection.atomicity,
    selection.diagnostics,
    policy,
  );
  const usage = combineUsage(selection.usage, relation.usage);
  const timings = {
    catalogMs: 0,
    sourceMs: elapsed(sourceStarted, sourceFinished),
    lexicalMs: elapsed(lexicalStarted, lexicalFinished),
    selectionMs: elapsed(selectionStarted, selectionFinished),
    relationMs: elapsed(relationStarted, relationFinished),
    totalMs: elapsed(sourceStarted, relationFinished),
    documentMs: undefined,
  } satisfies Schema.Schema.Type<typeof TimingSchema>;
  const context: RfcResearchContext = {
    ...plannedContext,
    state: "researched",
  };
  const offsets = makeUtf8OffsetMap(source.text);
  const evidence: Array<EvidencePassage> = [];
  for (const answer of relation.answers.filter((candidate) =>
    acceptedRelation(candidate.relation, candidate.probabilities, candidate.confidence, policy),
  )) {
    const startOffset = offsets.byteOffsetAtCodeUnit(answer.block.startOffset);
    const endOffset = offsets.byteOffsetAtCodeUnit(answer.block.endOffset);
    if (startOffset === undefined || endOffset === undefined) {
      return yield* new DecisionModelError({
        stage: "relation",
        reason: "The accepted evidence range is not a UTF-8 source boundary",
      });
    }
    const quote = source.text.slice(answer.block.startOffset, answer.block.endOffset);
    evidence.push({
      id: answer.block.id,
      context: plannedContext.role,
      quote,
      relation: answer.relation,
      selectionProbability: answer.selectionProbability,
      relationProbabilities: answer.probabilities,
      confidence: answer.confidence ?? null,
      provenance: {
        identifier: plannedContext.document.identifier,
        rfcNumber: plannedContext.document.rfcNumber,
        context: plannedContext.role,
        relationshipPath: plannedContext.relationshipPath,
        sourceUrl: source.sourceUrl,
        canonicalUrl: plannedContext.document.canonicalUrl,
        sourceHash: source.contentHash,
        offsetUnit: utf8OffsetUnit,
        startOffset,
        endOffset,
        section: answer.block.section,
        fetchedAt: source.fetchedAt,
      },
    });
  }
  const diagnostics = {
    context: plannedContext.role,
    identifier: plannedContext.document.identifier,
    relationshipPath: plannedContext.relationshipPath,
    state: "researched" as const,
    status,
    source: sourceDiagnostic(source),
    usage: {
      inputTokens: usage.inputTokens ?? null,
      outputTokens: usage.outputTokens ?? null,
    },
    timings,
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
    selection: selection.diagnostics,
    classification: relation.diagnostics,
  } satisfies Schema.Schema.Type<typeof ContextDiagnosticsSchema>;
  return { context, source, status, evidence, diagnostics, usage, timings };
});

const unavailableContext = (plannedContext: PlannedRfcContext): UnavailableContextResult => {
  const context: RfcResearchContext = {
    ...plannedContext,
    state: "unavailable",
  };
  return {
    context,
    diagnostics: {
      context: plannedContext.role,
      identifier: plannedContext.document.identifier,
      relationshipPath: plannedContext.relationshipPath,
      state: "unavailable",
      status: null,
      source: null,
      usage: zeroUsage(),
      timings: zeroTimings(),
      candidates: emptyCandidates(),
      atomicity: null,
      selection: [],
      classification: [],
    },
  };
};

const addNumbers = (left: number, right: number): number => left + right;

const sumUsage = (
  results: ReadonlyArray<ContextResearchResult>,
): { readonly inputTokens: number | undefined; readonly outputTokens: number | undefined } =>
  results.reduce<{
    readonly inputTokens: number | undefined;
    readonly outputTokens: number | undefined;
  }>(
    (usage, result) => ({
      inputTokens: addUsage(usage.inputTokens, result.usage.inputTokens),
      outputTokens: addUsage(usage.outputTokens, result.usage.outputTokens),
    }),
    { inputTokens: undefined, outputTokens: undefined },
  );

const sumTimings = (
  results: ReadonlyArray<ContextResearchResult>,
): Schema.Schema.Type<typeof TimingSchema> =>
  results.reduce(
    (timings, result) => ({
      catalogMs: timings.catalogMs,
      sourceMs: addNumbers(timings.sourceMs, result.timings.sourceMs),
      lexicalMs: addNumbers(timings.lexicalMs, result.timings.lexicalMs),
      selectionMs: addNumbers(timings.selectionMs, result.timings.selectionMs),
      relationMs: addNumbers(timings.relationMs, result.timings.relationMs),
      totalMs: addNumbers(timings.totalMs, result.timings.totalMs),
      documentMs: undefined,
    }),
    zeroTimings(),
  );

const compatibilityStatements = (quote: string): ReadonlyArray<string> => {
  const statements = quote
    .split(/(?:\r?\n+|(?<=[.!?])\s+)/)
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
  const normative = statements.filter((statement) =>
    /\b(?:must|shall|should|may|required|prohibited)\b/i.test(statement),
  );
  return normative.length > 0 ? normative : statements;
};

type CompatibilityStatement = {
  readonly tokens: ReadonlyArray<string>;
  readonly tokenSet: ReadonlySet<string>;
};

const compatibilityTokens = (statement: string): CompatibilityStatement => {
  const normalized = statement
    .toLowerCase()
    .replace(/\brequest\s+for\s+comments\s*:?\s*\d+\b/g, " ")
    .replace(/\brfc\s*\d+\b/g, " ")
    .replace(/\b(?:is|are)\s+(?:required|obligated)\s+to\b/g, " must ")
    .replace(/\b(?:must|shall)\s+not\b/g, " must_not ")
    .replace(/\b(?:must|shall)\b/g, " must ")
    .replace(/\bshould\s+not\b/g, " should_not ")
    .replace(/\bshould\b/g, " should ")
    .replace(/\bmay\s+not\b/g, " may_not ")
    .replace(/\bmay\b/g, " may ")
    .replace(/\b(?:the|a|an|of|to|that|which|is|are|be|as|for)\b/g, " ")
    .replace(/[^a-z0-9_]+/g, " ");
  const tokens = normalized.split(/\s+/).filter((token) => token.length > 0);
  return { tokens, tokenSet: new Set(tokens) };
};

const tokenOverlap = (left: ReadonlySet<string>, right: ReadonlySet<string>): number => {
  if (left.size === 0 || right.size === 0) return 0;
  let intersection = 0;
  for (const token of left) {
    if (right.has(token)) intersection += 1;
  }
  return intersection / new Set([...left, ...right]).size;
};

const requirementModal = (tokens: ReadonlySet<string>): string | undefined =>
  ["must", "must_not", "should", "should_not", "may", "may_not"].find((token) => tokens.has(token));

const hasOpposingRequirement = (left: ReadonlySet<string>, right: ReadonlySet<string>): boolean => {
  const leftModal = requirementModal(left);
  const rightModal = requirementModal(right);
  if (leftModal === undefined || rightModal === undefined || leftModal === rightModal) {
    return false;
  }
  const shared = [...left].filter((token) => !token.endsWith("_not") && right.has(token));
  return shared.length >= 2;
};

const sameTokens = (left: ReadonlyArray<string>, right: ReadonlyArray<string>): boolean =>
  left.length === right.length && left.every((token, index) => token === right[index]);

const compareCurrencyQuotes = (
  requestedQuote: string,
  currentQuote: string,
  threshold: number,
): RfcCurrencyCompatibility["outcome"] => {
  const requestedStatements = compatibilityStatements(requestedQuote).map(compatibilityTokens);
  const currentStatements = compatibilityStatements(currentQuote).map(compatibilityTokens);
  for (const requestedStatement of requestedStatements) {
    for (const currentStatement of currentStatements) {
      const overlap = tokenOverlap(requestedStatement.tokenSet, currentStatement.tokenSet);
      if (
        hasOpposingRequirement(requestedStatement.tokenSet, currentStatement.tokenSet) &&
        overlap >= 0.3
      ) {
        return "conflicting";
      }
    }
  }
  const requestedStatementsMatch = requestedStatements.every((requestedStatement) =>
    currentStatements.some(
      (currentStatement) =>
        sameTokens(requestedStatement.tokens, currentStatement.tokens) &&
        tokenOverlap(requestedStatement.tokenSet, currentStatement.tokenSet) >= threshold,
    ),
  );
  const currentStatementsMatch = currentStatements.every((currentStatement) =>
    requestedStatements.some(
      (requestedStatement) =>
        sameTokens(requestedStatement.tokens, currentStatement.tokens) &&
        tokenOverlap(requestedStatement.tokenSet, currentStatement.tokenSet) >= threshold,
    ),
  );
  return requestedStatementsMatch && currentStatementsMatch ? "compatible" : "uncertain";
};

const currencyCompatibility = (
  requested: ContextResearchResult,
  current: ReadonlyArray<ContextResearchResult>,
  policy: ResearchPolicy,
): ReadonlyArray<RfcCurrencyCompatibility> => {
  if (requested.status !== "answered") return [];
  const requestedEvidence = requested.evidence.filter(
    (passage) => passage.relation === "direct_answer",
  );
  if (requestedEvidence.length === 0) return [];

  return current.flatMap((currentContext) => {
    if (currentContext.status !== "answered") return [];
    const currentEvidence = currentContext.evidence.filter(
      (passage) => passage.relation === "direct_answer",
    );
    if (currentEvidence.length === 0) return [];
    let outcome: RfcCurrencyCompatibility["outcome"] = "compatible";
    let comparedPairs = 0;
    for (const requestedPassage of requestedEvidence) {
      for (const currentPassage of currentEvidence) {
        comparedPairs += 1;
        const comparison = compareCurrencyQuotes(
          requestedPassage.quote,
          currentPassage.quote,
          policy.currencyCompatibilityOverlapThreshold,
        );
        if (comparison === "conflicting") {
          outcome = comparison;
          break;
        }
        if (comparison === "uncertain") outcome = comparison;
      }
      if (outcome === "conflicting") break;
    }
    if (comparedPairs === 0) outcome = "uncertain";
    return [
      {
        requested: requested.context.document.identifier,
        current: currentContext.context.document.identifier,
        outcome,
      },
    ];
  });
};

const combinedCurrencyStatus = (
  requested: ContextResearchResult,
  current: ReadonlyArray<ContextResearchResult>,
  unavailable: ReadonlyArray<UnavailableContextResult>,
  report: RfcCurrencyReport,
): ResearchStatus => {
  const contextResults = [requested, ...current];
  const statuses = contextResults.map(({ status }) => status);
  if (statuses.includes("needs_split")) return "needs_split";
  const unsafeIssues = report.issues.some((issue) =>
    ["malformed_relationship", "cycle_detected", "traversal_limit"].includes(issue),
  );
  const contradictoryContext = contextResults.some(({ diagnostics }) =>
    diagnostics.classification.some(({ relation }) => relation === "contradictory"),
  );
  const compatibilityNeedsReview = report.compatibility.some((comparison) => {
    if (comparison.outcome === "compatible" || comparison.outcome === "conflicting") {
      return comparison.outcome === "conflicting";
    }
    const requestedContext = contextResults.find(
      ({ context }) => context.document.identifier === comparison.requested,
    );
    const currentContext = contextResults.find(
      ({ context }) => context.document.identifier === comparison.current,
    );
    // If one side has no accepted evidence, an uncertain overlap is a
    // coverage gap and is represented as partial below. If both sides have
    // accepted evidence, uncertainty still fails closed.
    return (
      (requestedContext?.evidence.length ?? 0) > 0 && (currentContext?.evidence.length ?? 0) > 0
    );
  });
  if (unsafeIssues || contradictoryContext || compatibilityNeedsReview) {
    return "needs_review";
  }
  // An ambiguous requested/current context alongside accepted evidence is a
  // bounded partial result, not an automatic answer. Preserve review for an
  // operation with no accepted context at all.
  const hasAcceptedContext = statuses.some(
    (status) => status === "answered" || status === "partial",
  );
  if (statuses.includes("needs_review") && !hasAcceptedContext) return "needs_review";
  const incomplete = !report.complete || unavailable.length > 0;
  if (incomplete) return "partial";
  if (statuses.every((status) => status === "answered")) return "answered";
  if (statuses.every((status) => status === "unsupported")) return "unsupported";
  if (statuses.some((status) => status === "answered" || status === "partial")) return "partial";
  return "needs_review";
};

const updateCurrencyReport = (
  report: RfcCurrencyReport,
  unavailable: ReadonlyArray<UnavailableContextResult>,
): RfcCurrencyReport => {
  if (unavailable.length === 0) return report;
  return {
    ...report,
    complete: false,
    issues: uniqueCurrencyIssues([...report.issues, "missing_current_source"]),
  };
};

/**
 * Run the complete known-RFC retrieval and semantic evidence pipeline.
 *
 * @param question Atomic research question.
 * @param hint Exact RFC identifier or number.
 * @param options Fresh catalog, cache, provider, and timing configuration.
 * @returns A versioned evidence bundle with exact provenance for requested and current contexts.
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
  | RfcSourceRevalidationError
  | DecisionModelError
  | ResearchPolicyError
  | import("./catalog").CatalogReadError
  | import("./catalog").CatalogStaleError,
  | FileSystem.FileSystem
  | RfcSourceStore
  | RfcSourceServiceTag
  | LiveRfcSource
  | DecisionModel.DecisionModel
  | ResolvedModelName
  | ResolvedModelNames
> {
  const policyPreset = yield* policyFor(options.policyPreset);
  const policy: ResearchPolicy = {
    ...policyPreset,
    automaticAnswerActivation: options.automaticAnswerActivation,
  };
  const resolvedModelRef = yield* ResolvedModelName;
  const resolvedModelsRef = yield* ResolvedModelNames;
  const requested = resolveKnownRfc(options.catalog, hint);
  const resolution = resolveRfcCurrencyFromDocument(options.catalog, requested);
  const plannedContexts: Array<PlannedRfcContext> = resolution.contexts.map((context) => ({
    role: context.role,
    document: context.document,
    relationshipPath: context.relationshipPath,
    isCurrent: context.isCurrent,
  }));
  const requestedContext = plannedContexts[0];
  if (requestedContext === undefined) {
    return yield* new RfcNotFoundError({ rfc: hint });
  }

  const requestedResult = yield* researchContext(question, requestedContext, options, policy);
  const currentResults: Array<ContextResearchResult> = [];
  const unavailableResults: Array<UnavailableContextResult> = [];
  for (const plannedContext of plannedContexts.slice(1)) {
    const currentResult = yield* Effect.result(
      researchContext(question, plannedContext, options, policy),
    );
    if (Result.isSuccess(currentResult)) {
      currentResults.push(currentResult.success);
      continue;
    }
    const currentError = currentResult.failure;
    if (
      currentError instanceof RfcSourceCacheError ||
      currentError instanceof RfcSourceFetchError
    ) {
      unavailableResults.push(unavailableContext(plannedContext));
      continue;
    }
    return yield* Effect.fail(currentError);
  }

  const allResults = [requestedResult, ...currentResults];
  const compatibility = currencyCompatibility(requestedResult, currentResults, policy);
  const report = {
    ...updateCurrencyReport(resolution.report, unavailableResults),
    compatibility,
  } satisfies RfcCurrencyReport;
  const status = combinedCurrencyStatus(
    requestedResult,
    currentResults,
    unavailableResults,
    report,
  );
  const finishedAt = yield* Clock.currentTimeMillis;
  const usage = sumUsage(allResults);
  const timings = sumTimings(allResults);
  const requestedSource = sourceDiagnostic(requestedResult.source);
  const contexts = [
    ...allResults.map(({ context }) => context),
    ...unavailableResults.map(({ context }) => context),
  ];
  const contextDiagnostics = [
    ...allResults.map(({ diagnostics }) => diagnostics),
    ...unavailableResults.map(({ diagnostics }) => diagnostics),
  ];
  const multiContext = plannedContexts.length > 1;
  const evidence = allResults.flatMap(({ evidence: passages }) =>
    passages.map((passage) =>
      multiContext ? { ...passage, id: `${passage.provenance.identifier}:${passage.id}` } : passage,
    ),
  );
  const sourceDiagnostics = allResults.map((result) => ({
    context: result.context.role,
    source: sourceDiagnostic(result.source),
  }));
  const candidates = allResults.reduce(
    (counts, result) => ({
      sourceBlocks: counts.sourceBlocks + result.diagnostics.candidates.sourceBlocks,
      passageCandidates: counts.passageCandidates + result.diagnostics.candidates.passageCandidates,
      selectedPassages: counts.selectedPassages + result.diagnostics.candidates.selectedPassages,
      catalogDocuments: undefined,
      documentCandidates: undefined,
      acceptedDocuments: undefined,
    }),
    emptyCandidates(),
  );
  const selection = allResults.flatMap((result) =>
    result.diagnostics.selection.map((candidate) => ({
      ...candidate,
      candidateId: multiContext
        ? `${result.context.document.identifier}:${candidate.candidateId}`
        : candidate.candidateId,
    })),
  );
  const classification = allResults.flatMap((result) =>
    result.diagnostics.classification.map((candidate) => ({
      ...candidate,
      candidateId: multiContext
        ? `${result.context.document.identifier}:${candidate.candidateId}`
        : candidate.candidateId,
    })),
  );
  const requestedDiagnostics = requestedResult.diagnostics;
  const requestedAtomicity = requestedDiagnostics.atomicity;
  if (requestedAtomicity === null) {
    return yield* new DecisionModelError({
      stage: "selection",
      reason: "The requested RFC context did not produce atomicity diagnostics",
    });
  }
  const fallbackResolvedModel = yield* Ref.get(resolvedModelRef);
  const observedResolvedModels = yield* Ref.get(resolvedModelsRef);
  const resolvedModel = summarizeResolvedModels(fallbackResolvedModel, observedResolvedModels);
  const resolvedModels =
    observedResolvedModels.length === 0 ? [fallbackResolvedModel] : observedResolvedModels;
  const diagnostics = {
    schemaVersion: 1 as const,
    policyVersion: policy.policyVersion,
    requestedModel: options.modelAlias,
    resolvedModel,
    resolvedModels,
    usage: {
      inputTokens: usage.inputTokens ?? null,
      outputTokens: usage.outputTokens ?? null,
    },
    timings: {
      ...timings,
      catalogMs: options.catalogMs,
      totalMs: elapsed(options.startedAt, finishedAt),
    },
    source: requestedSource,
    sources: sourceDiagnostics,
    catalog: options.catalogStatus,
    currency: report,
    candidates,
    atomicity: requestedAtomicity,
    documentSelection: undefined,
    selection,
    classification,
    contexts: contextDiagnostics,
  } satisfies ResearchDiagnostics;

  return Schema.decodeUnknownSync(EvidenceBundleSchema)({
    schemaVersion: 1,
    kind: "evidence_bundle",
    status,
    question,
    rfc: requested,
    contexts,
    currency: report,
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
  | RfcSourceRevalidationError
  | DecisionModelError
  | ResearchPolicyError
  | import("./catalog").CatalogReadError
  | import("./catalog").CatalogStaleError,
  | FileSystem.FileSystem
  | RfcSourceStore
  | RfcSourceServiceTag
  | LiveRfcSource
  | DecisionModel.DecisionModel
  | ResolvedModelName
  | ResolvedModelNames
> {
  const policyPreset = yield* policyFor(options.policyPreset);
  const policy: ResearchPolicy = {
    ...policyPreset,
    automaticAnswerActivation: options.automaticAnswerActivation,
  };
  const resolvedModelRef = yield* ResolvedModelName;
  const resolvedModelsRef = yield* ResolvedModelNames;
  const documentLexicalStarted = yield* Clock.currentTimeMillis;
  const documentCandidates =
    options.documentCandidates === undefined
      ? rankDocumentCandidates(options.catalog.documents, question, policy.maxDocumentCandidates)
      : options.documentCandidates.map((document, index, documents) => ({
          document,
          lexicalScore: documents.length - index,
        }));
  const documentLexicalFinished = yield* Clock.currentTimeMillis;
  const documentStarted = documentLexicalFinished;
  const documentSelection = yield* documentSelectionStage(question, documentCandidates, policy);
  const documentFinished = yield* Clock.currentTimeMillis;

  const makeEmptyDiagnostics = (
    finishedAt: number,
    resolvedModel: string,
    resolvedModels: ReadonlyArray<string>,
  ): ResearchDiagnostics => ({
    schemaVersion: 1,
    policyVersion: policy.policyVersion,
    requestedModel: options.modelAlias,
    resolvedModel,
    resolvedModels,
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
    const fallbackResolvedModel = yield* Ref.get(resolvedModelRef);
    const observedResolvedModels = yield* Ref.get(resolvedModelsRef);
    const resolvedModel = summarizeResolvedModels(fallbackResolvedModel, observedResolvedModels);
    const resolvedModels =
      observedResolvedModels.length === 0 ? [fallbackResolvedModel] : observedResolvedModels;
    const diagnostics = makeEmptyDiagnostics(finishedAt, resolvedModel, resolvedModels);
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
      source: yield* options.sourceLoader === undefined
        ? loadRfcSource(accepted.document, options.sourceDirectory)
        : options.sourceLoader(accepted.document),
      context: "requested",
      relationshipPath: [],
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
  const fallbackResolvedModel = yield* Ref.get(resolvedModelRef);
  const observedResolvedModels = yield* Ref.get(resolvedModelsRef);
  const resolvedModel = summarizeResolvedModels(fallbackResolvedModel, observedResolvedModels);
  const resolvedModels =
    observedResolvedModels.length === 0 ? [fallbackResolvedModel] : observedResolvedModels;
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
    resolvedModels,
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
