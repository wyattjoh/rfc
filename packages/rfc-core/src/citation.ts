import { Cause, Clock, Duration, Effect, FileSystem, Ref, Result, Schema } from "effect";
import * as AiError from "effect/unstable/ai/AiError";
import * as Decision from "effect/unstable/ai/Decision";
import * as DecisionModel from "effect/unstable/ai/DecisionModel";
import {
  CatalogDocumentSchema,
  CatalogStatusSchema,
  type CatalogDocument,
  type CatalogStatus,
  type RfcCatalog,
} from "./catalog";
import { makeUtf8OffsetMap, utf8OffsetUnit } from "./offsets";
import {
  DecisionModelError,
  ResolvedModelName,
  ResolvedModelNames,
  RfcNotFoundError,
  parseSourceBlocks,
  summarizeResolvedModels,
  resolveKnownRfc,
} from "./research";
import {
  RfcSourceCacheError,
  RfcSourceFetchError,
  RfcSourceServiceTag,
  RfcSourceStore,
  loadRfcSource,
  type RfcSource,
} from "./source";

/**
 * The verdicts a present RFC quotation can receive during citation verification.
 */
export const CitationVerdictSchema = Schema.Literals([
  "verified",
  "unsupported",
  "contradicted",
  "fabricated",
]);

/**
 * A citation verdict returned by the evidence engine.
 */
export type CitationVerdict = Schema.Schema.Type<typeof CitationVerdictSchema>;

/**
 * The canonical unit for citation offsets.
 */
export const citationOffsetUnit = utf8OffsetUnit;

/**
 * Schema for the canonical citation offset unit.
 */
export const CitationOffsetUnitSchema = Schema.Literal(citationOffsetUnit);

/**
 * The canonical unit for citation offsets against the hashed RFC source.
 */
export type CitationOffsetUnit = Schema.Schema.Type<typeof CitationOffsetUnitSchema>;

/**
 * Schema for canonical citation verification input.
 *
 * The optional offset is an absolute UTF-8 byte offset from the beginning of
 * the exact source text identified by the returned source hash. It is nullable
 * so callers can explicitly request deterministic single-occurrence lookup
 * while still accepting the omitted convenience form.
 */
export const CitationVerificationRequestSchema = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  rfc: Schema.NonEmptyString,
  claim: Schema.NonEmptyString,
  quote: Schema.NonEmptyString,
  offset: Schema.optionalKey(Schema.NullOr(Schema.Natural)),
});

type DecodedCitationVerificationRequest = Schema.Schema.Type<
  typeof CitationVerificationRequestSchema
>;

/**
 * A decoded request to verify one factual claim against one exact RFC quote.
 */
export interface CitationVerificationRequest {
  readonly schemaVersion: 1;
  readonly rfc: string;
  readonly claim: string;
  readonly quote: string;
  /**
   * Absolute UTF-8 byte offset into the exact authoritative source, or null
   * when the quotation occurs only once or should be rejected as ambiguous.
   */
  readonly offset: number | null;
}

/**
 * Decode unknown citation input at the public JSON boundary.
 *
 * @param input The unknown value received from JSON or convenience flags.
 * @returns A normalized version-one citation verification request.
 * @throws Error when the value does not satisfy the request schema.
 */
export const decodeCitationVerificationRequest = (input: unknown): CitationVerificationRequest => {
  const decoded: DecodedCitationVerificationRequest = Schema.decodeUnknownSync(
    CitationVerificationRequestSchema,
  )(input);
  return {
    ...decoded,
    offset: decoded.offset ?? null,
  };
};

/**
 * Exact source identity and range metadata for a citation under review.
 *
 * The start and end offsets are UTF-8 byte offsets into the exact source text
 * represented by sourceHash, never JavaScript UTF-16 string indices.
 */
export const CitationProvenanceSchema = Schema.Struct({
  identifier: Schema.NonEmptyString,
  rfcNumber: Schema.Natural,
  sourceUrl: Schema.NonEmptyString,
  canonicalUrl: Schema.NonEmptyString,
  sourceHash: Schema.NonEmptyString,
  offsetUnit: CitationOffsetUnitSchema,
  startOffset: Schema.NullOr(Schema.Natural),
  endOffset: Schema.NullOr(Schema.Natural),
  section: Schema.NullOr(Schema.String),
  fetchedAt: Schema.String,
});

/**
 * Provenance for the exact quote supplied to citation verification.
 */
export type CitationProvenance = Schema.Schema.Type<typeof CitationProvenanceSchema>;

const CitationUsageSchema = Schema.Struct({
  inputTokens: Schema.NullOr(Schema.Finite),
  outputTokens: Schema.NullOr(Schema.Finite),
});

const CitationTimingsSchema = Schema.Struct({
  catalogMs: Schema.Finite,
  sourceMs: Schema.Finite,
  verificationMs: Schema.Finite,
  totalMs: Schema.Finite,
});

/**
 * Bounded diagnostics for one citation verification operation.
 */
export const CitationVerificationDiagnosticsSchema = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  policyVersion: Schema.NonEmptyString,
  requestedModel: Schema.NonEmptyString,
  resolvedModel: Schema.NonEmptyString,
  resolvedModels: Schema.Array(Schema.NonEmptyString),
  usage: CitationUsageSchema,
  timings: CitationTimingsSchema,
  catalog: CatalogStatusSchema,
  probabilities: Schema.Record(Schema.String, Schema.Finite),
  confidence: Schema.NullOr(Schema.Finite),
});

/**
 * Diagnostics returned alongside a citation verdict.
 */
export type CitationVerificationDiagnostics = Schema.Schema.Type<
  typeof CitationVerificationDiagnosticsSchema
>;

/**
 * The versioned result of checking a factual claim against an RFC quotation.
 */
export const CitationVerificationResultSchema = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  kind: Schema.Literal("citation_verification"),
  verdict: CitationVerdictSchema,
  rfc: CatalogDocumentSchema,
  claim: Schema.NonEmptyString,
  quote: Schema.NonEmptyString,
  provenance: CitationProvenanceSchema,
  probabilities: Schema.Record(Schema.String, Schema.Finite),
  confidence: Schema.NullOr(Schema.Finite),
  diagnostics: CitationVerificationDiagnosticsSchema,
});

/**
 * A versioned citation verdict with exact RFC provenance.
 */
export type CitationVerificationResult = Schema.Schema.Type<
  typeof CitationVerificationResultSchema
>;

/**
 * Citation verification policy values used for bounded context and retries.
 */
export const citationPolicy = {
  policyVersion: "citation-v1",
  contextBeforeCharacters: 2_000,
  contextAfterCharacters: 2_000,
  confidenceThreshold: 0.65,
  verdictProbabilityThreshold: 0.65,
  maxAttempts: 3,
  maxElapsedMilliseconds: 5_000,
  initialRetryDelayMilliseconds: 50,
} as const;

/**
 * A repeated quotation cannot be judged without selecting one source occurrence.
 */
export class CitationQuoteAmbiguousError extends Schema.TaggedError<CitationQuoteAmbiguousError>()(
  "CitationQuoteAmbiguousError",
  {
    rfc: Schema.String,
    occurrences: Schema.Natural,
  },
) {}

/**
 * The caller supplied an offset that does not identify the exact quotation.
 */
export class CitationOffsetMismatchError extends Schema.TaggedError<CitationOffsetMismatchError>()(
  "CitationOffsetMismatchError",
  {
    rfc: Schema.String,
    offset: Schema.Natural,
  },
) {}

/**
 * Inputs and dependencies for the citation verification pipeline.
 */
export interface CitationVerificationOptions {
  /**
   * Fresh published RFC metadata.
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

const citationCriteria = {
  verified:
    "The exact RFC quotation supports the factual claim as written, including its conditions and qualifications.",
  unsupported:
    "The quotation is topical or related but does not establish the factual claim as written, including when it omits a material qualification.",
  contradicted:
    "The quotation or its surrounding RFC context directly conflicts with the factual claim as written.",
} as const;

const CitationDecisionInputSchema = Schema.Struct({
  claim: Schema.NonEmptyString,
  quote: Schema.NonEmptyString,
  context: Schema.String,
  section: Schema.NullOr(Schema.String),
});

const citationDecision = Decision.make({
  input: CitationDecisionInputSchema,
  decisions: {
    citation_verdict: Decision.classify({
      instructions:
        "Judge the factual claim against the exact quotation and bounded surrounding RFC context.",
      criteria: citationCriteria,
    }),
  },
});

type CitationDecisionResponse = DecisionModel.DecideResponse<typeof citationDecision.decisions>;

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : "The citation DecisionModel request failed";

const retryDelay = (error: AiError.AiError, attempt: number): number => {
  if (error.retryAfter !== undefined) return Math.max(0, Duration.toMillis(error.retryAfter));
  return citationPolicy.initialRetryDelayMilliseconds * 2 ** attempt;
};

const retryDecision = Effect.fnUntraced(function* (
  operation: Effect.Effect<CitationDecisionResponse, AiError.AiError, DecisionModel.DecisionModel>,
  startedAt: number,
): Effect.fn.Return<CitationDecisionResponse, DecisionModelError, DecisionModel.DecisionModel> {
  let scheduledDelay = 0;

  for (let attempt = 0; attempt < citationPolicy.maxAttempts; attempt += 1) {
    const attemptStartedAt = yield* Clock.currentTimeMillis;
    const elapsedBeforeAttempt = Math.max(0, attemptStartedAt - startedAt, scheduledDelay);
    if (elapsedBeforeAttempt >= citationPolicy.maxElapsedMilliseconds) {
      return yield* new DecisionModelError({
        stage: "citation",
        reason: `The citation DecisionModel elapsed-time budget was exhausted before attempt ${attempt + 1}`,
        attempts: attempt,
      });
    }

    const remainingTime = citationPolicy.maxElapsedMilliseconds - elapsedBeforeAttempt;
    const result = yield* Effect.result(
      operation.pipe(Effect.timeout(Duration.millis(remainingTime))),
    );
    if (Result.isSuccess(result)) {
      const completedAt = yield* Clock.currentTimeMillis;
      const elapsedAtCompletion = Math.max(0, completedAt - startedAt, scheduledDelay);
      if (elapsedAtCompletion <= citationPolicy.maxElapsedMilliseconds) {
        return result.success;
      }
      return yield* new DecisionModelError({
        stage: "citation",
        reason: `The citation DecisionModel elapsed-time budget was exhausted during attempt ${attempt + 1}`,
        attempts: attempt + 1,
      });
    }

    const error = result.failure;
    if (Cause.isTimeoutError(error)) {
      return yield* new DecisionModelError({
        stage: "citation",
        reason: `The citation DecisionModel elapsed-time budget was exhausted during attempt ${attempt + 1}`,
        attempts: attempt + 1,
      });
    }
    if (!AiError.isAiError(error) || !error.isRetryable) {
      return yield* new DecisionModelError({
        stage: "citation",
        reason: errorMessage(error),
        attempts: attempt + 1,
      });
    }

    const delay = retryDelay(error, attempt);
    const now = yield* Clock.currentTimeMillis;
    const elapsed = Math.max(0, now - startedAt, scheduledDelay);
    if (
      attempt + 1 >= citationPolicy.maxAttempts ||
      elapsed + delay > citationPolicy.maxElapsedMilliseconds
    ) {
      return yield* new DecisionModelError({
        stage: "citation",
        reason: errorMessage(error),
        attempts: attempt + 1,
      });
    }
    yield* Effect.sleep(Duration.millis(delay));
    scheduledDelay += delay;
  }

  return yield* new DecisionModelError({
    stage: "citation",
    reason: "The citation DecisionModel retry budget was exhausted",
    attempts: citationPolicy.maxAttempts,
  });
});

const normalizeProbabilities = (
  probabilities: Readonly<Record<string, number>>,
): Readonly<Record<string, number>> =>
  Object.fromEntries(
    (Object.keys(citationCriteria) as ReadonlyArray<keyof typeof citationCriteria>).map((label) => [
      label,
      probabilities[label] ?? 0,
    ]),
  );

const PresentCitationVerdictSchema = Schema.Literals(["verified", "unsupported", "contradicted"]);

const citationAnswerSchema = Schema.Struct({
  label: PresentCitationVerdictSchema,
  probabilities: Schema.Struct({
    verified: Schema.Finite,
    unsupported: Schema.Finite,
    contradicted: Schema.Finite,
  }),
  confidence: Schema.optionalKey(Schema.Finite),
});

const citationStage = Effect.fnUntraced(function* (
  claim: string,
  quote: string,
  context: string,
  section: string | null,
  startedAt: number,
): Effect.fn.Return<
  {
    readonly verdict: Exclude<CitationVerdict, "fabricated">;
    readonly probabilities: Readonly<Record<string, number>>;
    readonly confidence: number | null;
    readonly usage: DecisionModel.DecisionUsage;
  },
  DecisionModelError,
  DecisionModel.DecisionModel
> {
  const response = yield* retryDecision(
    DecisionModel.decide(citationDecision, {
      input: { claim, quote, context, section },
    }),
    startedAt,
  );
  const answer = yield* Effect.try({
    try: () => Schema.decodeUnknownSync(citationAnswerSchema)(response.answers.citation_verdict),
    catch: (error) =>
      new DecisionModelError({
        stage: "citation",
        reason: errorMessage(error),
      }),
  });
  const probabilities = normalizeProbabilities(answer.probabilities);
  const probabilityValues = Object.values(probabilities);
  const probabilitySum = probabilityValues.reduce((sum, value) => sum + value, 0);
  if (
    probabilityValues.some((value) => value < 0 || value > 1) ||
    Math.abs(probabilitySum - 1) > 1e-6
  ) {
    return yield* new DecisionModelError({
      stage: "citation",
      reason: "The citation DecisionModel returned an invalid probability distribution",
    });
  }
  if (answer.confidence !== undefined && (answer.confidence < 0 || answer.confidence > 1)) {
    return yield* new DecisionModelError({
      stage: "citation",
      reason: "The citation DecisionModel returned invalid confidence",
    });
  }
  return {
    verdict: answer.label,
    probabilities,
    confidence: answer.confidence ?? null,
    usage: response.usage,
  };
});

interface CitationOccurrence {
  readonly startCodeUnitOffset: number;
  readonly endCodeUnitOffset: number;
  readonly startOffset: number;
  readonly endOffset: number;
}

const findOccurrences = (
  text: string,
  quote: string,
  offsets: ReturnType<typeof makeUtf8OffsetMap>,
): ReadonlyArray<CitationOccurrence> => {
  const occurrences: Array<CitationOccurrence> = [];
  let searchFrom = 0;
  while (searchFrom <= text.length - quote.length) {
    const startCodeUnitOffset = text.indexOf(quote, searchFrom);
    if (startCodeUnitOffset === -1) break;
    const endCodeUnitOffset = startCodeUnitOffset + quote.length;
    const startOffset = offsets.byteOffsetAtCodeUnit(startCodeUnitOffset);
    const endOffset = offsets.byteOffsetAtCodeUnit(endCodeUnitOffset);
    if (startOffset !== undefined && endOffset !== undefined) {
      occurrences.push({
        startCodeUnitOffset,
        endCodeUnitOffset,
        startOffset,
        endOffset,
      });
    }
    searchFrom = startCodeUnitOffset + 1;
  }
  return occurrences;
};

const sectionAtOffset = (text: string, codeUnitOffset: number): string | null => {
  const block = parseSourceBlocks(text).find(
    (candidate) => candidate.startOffset <= codeUnitOffset && codeUnitOffset < candidate.endOffset,
  );
  return block?.section ?? null;
};

const contextAround = (
  text: string,
  startCodeUnitOffset: number,
  endCodeUnitOffset: number,
): string =>
  text.slice(
    Math.max(0, startCodeUnitOffset - citationPolicy.contextBeforeCharacters),
    Math.min(text.length, endCodeUnitOffset + citationPolicy.contextAfterCharacters),
  );

const usageValue = (value: number | undefined): number | null => value ?? null;

interface CitationResultInput {
  readonly request: CitationVerificationRequest;
  readonly document: CatalogDocument;
  readonly source: RfcSource;
  readonly catalogStatus: CatalogStatus;
  readonly modelAlias: string;
  readonly resolvedModel: string;
  readonly resolvedModels: ReadonlyArray<string>;
  readonly timings: {
    readonly catalogMs: number;
    readonly sourceMs: number;
    readonly verificationMs: number;
    readonly totalMs: number;
  };
  readonly verdict: CitationVerdict;
  readonly probabilities: Readonly<Record<string, number>>;
  readonly confidence: number | null;
  readonly usage: { readonly inputTokens: number | null; readonly outputTokens: number | null };
  readonly startOffset: number | null;
  readonly endOffset: number | null;
  readonly section: string | null;
}

const resultFrom = ({
  request,
  document,
  source,
  catalogStatus,
  modelAlias,
  resolvedModel,
  resolvedModels,
  timings,
  verdict,
  probabilities,
  confidence,
  usage,
  startOffset,
  endOffset,
  section,
}: CitationResultInput): CitationVerificationResult => {
  const provenance = {
    identifier: source.identifier,
    rfcNumber: source.rfcNumber,
    sourceUrl: source.sourceUrl,
    canonicalUrl: document.canonicalUrl,
    sourceHash: source.contentHash,
    offsetUnit: citationOffsetUnit,
    startOffset,
    endOffset,
    section,
    fetchedAt: source.fetchedAt,
  } satisfies CitationProvenance;
  const diagnostics = {
    schemaVersion: 1 as const,
    policyVersion: citationPolicy.policyVersion,
    requestedModel: modelAlias,
    resolvedModel,
    resolvedModels,
    usage,
    timings,
    catalog: catalogStatus,
    probabilities,
    confidence,
  } satisfies CitationVerificationDiagnostics;

  return Schema.decodeUnknownSync(CitationVerificationResultSchema)({
    schemaVersion: 1,
    kind: "citation_verification",
    verdict,
    rfc: document,
    claim: request.claim,
    quote: request.quote,
    provenance,
    probabilities,
    confidence,
    diagnostics,
  });
};

/**
 * Verify a factual claim against an exact quotation from one published RFC.
 *
 * Quote lookup is deterministic and happens before the DecisionModel. A missing
 * quote is therefore returned as fabricated without delegating source existence
 * to a model.
 *
 * @param request Decoded claim, RFC identifier, quotation, and optional UTF-8 byte offset.
 * @param options Catalog, source cache, provider, and timing configuration.
 * @returns A versioned citation verdict with exact source provenance.
 */
export const verifyCitation = Effect.fnUntraced(function* (
  request: CitationVerificationRequest,
  options: CitationVerificationOptions,
): Effect.fn.Return<
  CitationVerificationResult,
  | CitationQuoteAmbiguousError
  | CitationOffsetMismatchError
  | RfcSourceCacheError
  | RfcSourceFetchError
  | DecisionModelError
  | RfcNotFoundError,
  | FileSystem.FileSystem
  | RfcSourceStore
  | RfcSourceServiceTag
  | DecisionModel.DecisionModel
  | ResolvedModelName
  | ResolvedModelNames
> {
  const resolvedModelRef = yield* ResolvedModelName;
  const resolvedModelsRef = yield* ResolvedModelNames;
  const document = yield* Effect.try({
    try: () => resolveKnownRfc(options.catalog, request.rfc),
    catch: (error) =>
      error instanceof RfcNotFoundError ? error : new RfcNotFoundError({ rfc: request.rfc }),
  });
  const sourceStarted = yield* Clock.currentTimeMillis;
  const source = yield* loadRfcSource(document, options.sourceDirectory);
  const sourceFinished = yield* Clock.currentTimeMillis;
  const offsets = makeUtf8OffsetMap(source.text);
  const occurrences = findOccurrences(source.text, request.quote, offsets);
  const resolvedModelBeforeJudgment = yield* Ref.get(resolvedModelRef);
  const sourceMs = Math.max(0, sourceFinished - sourceStarted);

  if (occurrences.length === 0) {
    const finishedAt = yield* Clock.currentTimeMillis;
    return resultFrom({
      request,
      document,
      source,
      catalogStatus: options.catalogStatus,
      modelAlias: options.modelAlias,
      resolvedModel: resolvedModelBeforeJudgment,
      resolvedModels: [],
      timings: {
        catalogMs: options.catalogMs,
        sourceMs,
        verificationMs: 0,
        totalMs: Math.max(0, finishedAt - options.startedAt),
      },
      verdict: "fabricated",
      probabilities: { fabricated: 1 },
      confidence: null,
      usage: { inputTokens: null, outputTokens: null },
      startOffset: null,
      endOffset: null,
      section: null,
    });
  }

  const occurrence =
    request.offset === null
      ? occurrences.length === 1
        ? occurrences[0]
        : undefined
      : occurrences.find((candidate) => candidate.startOffset === request.offset);
  if (occurrence === undefined) {
    if (request.offset === null) {
      return yield* new CitationQuoteAmbiguousError({
        rfc: request.rfc,
        occurrences: occurrences.length,
      });
    }
    return yield* new CitationOffsetMismatchError({ rfc: request.rfc, offset: request.offset });
  }

  const exactQuote = source.text.slice(
    occurrence.startCodeUnitOffset,
    occurrence.endCodeUnitOffset,
  );
  const exactRequest = { ...request, quote: exactQuote };
  const section = sectionAtOffset(source.text, occurrence.startCodeUnitOffset);
  const context = contextAround(
    source.text,
    occurrence.startCodeUnitOffset,
    occurrence.endCodeUnitOffset,
  );
  const verificationStarted = yield* Clock.currentTimeMillis;
  const judgment = yield* citationStage(
    exactRequest.claim,
    exactQuote,
    context,
    section,
    verificationStarted,
  );
  const verificationFinished = yield* Clock.currentTimeMillis;
  const confidence = judgment.confidence;
  const accepted =
    confidence !== null &&
    confidence >= citationPolicy.confidenceThreshold &&
    (judgment.probabilities[judgment.verdict] ?? 0) >= citationPolicy.verdictProbabilityThreshold;
  const verdict = accepted ? judgment.verdict : "unsupported";
  const fallbackResolvedModel = yield* Ref.get(resolvedModelRef);
  const observedResolvedModels = yield* Ref.get(resolvedModelsRef);
  const resolvedModel = summarizeResolvedModels(fallbackResolvedModel, observedResolvedModels);
  const resolvedModels =
    observedResolvedModels.length === 0 ? [fallbackResolvedModel] : observedResolvedModels;
  const finishedAt = yield* Clock.currentTimeMillis;

  return resultFrom({
    request: exactRequest,
    document,
    source,
    catalogStatus: options.catalogStatus,
    modelAlias: options.modelAlias,
    resolvedModel,
    resolvedModels,
    timings: {
      catalogMs: options.catalogMs,
      sourceMs,
      verificationMs: Math.max(0, verificationFinished - verificationStarted),
      totalMs: Math.max(0, finishedAt - options.startedAt),
    },
    verdict,
    probabilities: judgment.probabilities,
    confidence,
    usage: {
      inputTokens: usageValue(judgment.usage.inputTokens),
      outputTokens: usageValue(judgment.usage.outputTokens),
    },
    startOffset: occurrence.startOffset,
    endOffset: occurrence.endOffset,
    section,
  });
});
