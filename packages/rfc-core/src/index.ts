import { TypeSafeClient as TypeSafeClientApi, TypeSafeDecisionModel } from "@effect/ai-typesafe";
import { NodeFileSystem, NodePath } from "@effect/platform-node";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  Clock,
  Context,
  Duration,
  Effect,
  Layer,
  ManagedRuntime,
  Path,
  Redacted,
  Ref,
  Result,
  Schema,
} from "effect";
import * as DecisionModel from "effect/unstable/ai/DecisionModel";
import { FetchHttpClient, HttpClient } from "effect/unstable/http";
import {
  RfcSourceRevalidationError,
  hasLiveRfcSourceCacheEntry,
  loadLiveRfcSource,
  makeDefaultLiveRfcSourceLayer,
  makeLiveRfcSourceHttpLayer,
  makeLiveRfcSourceLayer,
  removeLiveRfcSourceCacheEntry,
  type LiveRfcSourceResult,
} from "./live-source";
import {
  RfcDiscovery,
  RfcDiscoveryError,
  RfcIdentifierError,
  defaultDatatrackerApiUrl,
  makeRfcSearchConfig,
  datatrackerCurrencyContextLimit,
  datatrackerDocumentCandidateLimit,
  datatrackerSuccessorLimit,
  makeDefaultRfcDiscoveryLayer,
  makeRfcDiscoveryHttpLayer,
  type LiveRfcLookup,
  type LiveTopicDiscovery,
  type RfcMetadata,
} from "./discovery";
import {
  CitationOffsetMismatchError,
  CitationQuoteAmbiguousError,
  decodeCitationVerificationRequest,
  verifyCitation,
} from "./citation";
import type { CitationVerificationRequest, CitationVerificationResult } from "./citation";
import {
  DecisionModelError,
  ResearchResultSchema,
  ResolvedModelName,
  ResolvedModelNames,
  RfcNotFoundError,
  buildCandidatePool,
  researchQuestions,
  retrievalPolicy,
} from "./research";
import type { ResearchResult } from "./research";
import {
  RfcSourceCacheError,
  RfcSourceFetchError,
  defaultRfcEditorBaseUrl,
  makeRfcSourceUrl,
} from "./source";
import type { RfcSourceFetcher } from "./source";
import { estimateInputTokenCost } from "./pricing";
import {
  datatrackerTopicSearchTermLimit,
  datatrackerTopicSearchTermMaximumCharacters,
  schemaVersion,
} from "./protocol";

export {
  CitationOffsetMismatchError,
  CitationProvenanceSchema,
  CitationQuoteAmbiguousError,
  CitationVerificationDiagnosticsSchema,
  CitationVerificationRequestSchema,
  CitationVerificationResultSchema,
  CitationVerdictSchema,
  citationOffsetUnit,
  citationPolicy,
  decodeCitationVerificationRequest,
  type CitationOffsetUnit,
  type CitationProvenance,
  type CitationVerificationDiagnostics,
  type CitationVerificationRequest,
  type CitationVerificationResult,
  type CitationVerdict,
} from "./citation";
export { RfcDiscoveryError, RfcDocumentSchema, RfcIdentifierError } from "./discovery";
export {
  datatrackerTopicSearchTermLimit,
  datatrackerTopicSearchTermMaximumCharacters,
  schemaVersion,
} from "./protocol";
export type { LiveRetrievalTrace, RetrievalRequestTrace, RfcDocument } from "./discovery";
export { RfcSourceRevalidationError } from "./live-source";
export type { LiveSourceCacheOutcome, LiveRfcSourceResult } from "./live-source";
export * from "./offsets";
export { InputTokenCostSchema, estimateInputTokenCost, type InputTokenCost } from "./pricing";
export {
  DecisionModelError,
  HitRoleSchema,
  PassageProvenanceSchema,
  PassageSchema,
  ResearchAnswerSchema,
  ResearchDiagnosticsSchema,
  ResearchHitSchema,
  ResearchResultSchema,
  RfcCurrencyReportSchema,
  RfcNotFoundError,
  RfcRelationshipStepSchema,
  VerdictSchema,
  buildCandidatePool,
  resolveRfcCurrency,
  retrievalPolicy,
  type HitRole,
  type NamedRfcLookup,
  type Passage,
  type PassageProvenance,
  type PoolCandidate,
  type ResearchAnswer,
  type ResearchDiagnostics,
  type ResearchHit,
  type ResearchResult,
  type RetrievalPolicy,
  type RfcCurrencyReport,
  type RfcRelationshipStep,
  type Verdict,
} from "./research";
export {
  paragraphMaximumCharacters,
  parseRfcStructure,
  sectionAtOffset,
  type RfcParagraph,
  type RfcSection,
  type RfcStructure,
} from "./sections";
export {
  RfcSourceCacheError,
  RfcSourceFetchError,
  RfcSourceSchema,
  defaultRfcEditorBaseUrl,
  hashRfcSource,
  makeRfcSourceUrl,
  type RfcSource,
  type RfcSourceFetcher,
  type RfcSourcePayload,
} from "./source";

/**
 * Whole-operation ceiling for one research or citation call.
 *
 * Generous relative to the warm-cache latency targets, because it exists to
 * bound a pathological fan-out against a slow upstream rather than to enforce
 * the per-stage deadlines that already apply.
 */
export const operationBudgetMilliseconds = 120_000;

const defaultCacheDirectoryRoot = (() => {
  if (process.platform === "darwin") {
    return join(homedir(), "Library", "Caches");
  }

  if (process.platform === "win32") {
    return join(homedir(), "AppData", "Local");
  }

  return join(homedir(), ".cache");
})();

/**
 * The default directory containing cached canonical RFC sources.
 */
export const defaultCacheDirectory = join(defaultCacheDirectoryRoot, "rfc-evidence-engine");

/**
 * Options for constructing an RFC evidence client.
 */
export interface RfcClientOptions {
  /**
   * Directory containing cached canonical RFC sources.
   */
  readonly cacheDirectory: string | undefined;
  /**
   * Datatracker API base URL used for live discovery.
   */
  readonly datatrackerApiUrl?: string | undefined;
  /**
   * RFC full-text search API base URL used for topic discovery.
   *
   * Ignored unless {@link RfcClientOptions.rfcSearchApiKey} is also supplied.
   */
  readonly rfcSearchApiUrl?: string | undefined;
  /**
   * Search-only API key enabling full-text topic discovery.
   *
   * Topic discovery matches only RFC titles and abstracts through Datatracker
   * unless this is supplied. No key ships with this package: the search backend
   * belongs to the IETF and carries no contract for programmatic use, so
   * enabling it is the operator's decision and their credential to rotate.
   */
  readonly rfcSearchApiKey?: string | undefined;
  /**
   * Optional HTTP service used by deterministic live-discovery tests.
   *
   * It serves both the Datatracker and the RFC search origins, so a test that
   * injects it dispatches on the request URL.
   */
  readonly datatrackerHttpClient?: HttpClient.HttpClient | undefined;
  /**
   * Optional lower currency depth limit used with an injected Datatracker HTTP client.
   * Values above the production limit are clamped to its hard maximum.
   */
  readonly currencyTraversalDepthLimit?: number | undefined;
  /**
   * Optional lower whole-operation budget used by deterministic tests.
   * Values above the production ceiling are clamped to it.
   */
  readonly operationBudgetMilliseconds?: number | undefined;
  /**
   * TypeSafe model alias used to construct the official DecisionModel provider.
   */
  readonly modelAlias: string | undefined;
  /**
   * TypeSafe API key supplied by the CLI composition root.
   */
  readonly typeSafeApiKey: string | undefined;
  /**
   * Optional TypeSafe API URL override supplied by the CLI composition root.
   */
  readonly typeSafeApiUrl: string | undefined;
  /**
   * Optional HTTP client used by deterministic TypeSafe provider tests.
   */
  readonly typeSafeHttpClient?: HttpClient.HttpClient | undefined;
  /**
   * Optional clock service used by deterministic tests and embedded callers.
   */
  readonly clock?: Clock.Clock | undefined;
  /**
   * Optional clock function used by deterministic tests and embedded callers.
   * Ignored when `clock` is provided.
   */
  readonly now?: (() => number) | undefined;
  /**
   * Optional source fetcher used by deterministic source and provenance tests.
   */
  readonly rfcSourceFetcher?: RfcSourceFetcher | undefined;
  /**
   * Optional HTTP client used by deterministic RFC source tests.
   */
  readonly rfcSourceHttpClient?: HttpClient.HttpClient | undefined;
  /**
   * Optional source cache directory, defaulting below the configured cache directory.
   */
  readonly sourceDirectory?: string | undefined;
  /**
   * A deterministic DecisionModel replacement for tests and embedded callers.
   */
  readonly decisionModel?: DecisionModel.DecisionModel | undefined;
}

/**
 * Signals that a client method was called after the client was closed.
 */
export class RfcClientClosedError extends Schema.TaggedError<RfcClientClosedError>()(
  "RfcClientClosedError",
  {},
) {}

/**
 * Signals that a later research operation is not available in the current release.
 */
export class ResearchUnavailableError extends Schema.TaggedError<ResearchUnavailableError>()(
  "ResearchUnavailableError",
  {},
) {}

/**
 * Signals that canonical JSON input did not satisfy a public request schema.
 */
export class InvalidInputError extends Schema.TaggedError<InvalidInputError>()(
  "InvalidInputError",
  {
    reason: Schema.String,
  },
) {}

/**
 * Signals that the CLI's typed non-secret configuration could not be read.
 */
export class ConfigurationError extends Schema.TaggedError<ConfigurationError>()(
  "ConfigurationError",
  {
    reason: Schema.String,
  },
) {}

/**
 * Signals that one semantic operation exceeded its whole-operation budget.
 *
 * Every network and provider stage is individually bounded, but a known-RFC
 * request fans out across a bounded set of contexts and each stage restarts
 * its own budget. This is the ceiling across all of them.
 */
export class OperationTimeoutError extends Schema.TaggedError<OperationTimeoutError>()(
  "OperationTimeoutError",
  {
    milliseconds: Schema.Number,
  },
) {}

/**
 * The operational errors exposed by the Promise facade.
 */
export type RfcCoreError =
  | RfcDiscoveryError
  | RfcIdentifierError
  | RfcSourceCacheError
  | RfcSourceFetchError
  | RfcSourceRevalidationError
  | CitationQuoteAmbiguousError
  | CitationOffsetMismatchError
  | RfcClientClosedError
  | ResearchUnavailableError
  | RfcNotFoundError
  | DecisionModelError
  | InvalidInputError
  | ConfigurationError
  | OperationTimeoutError;

/**
 * Stable machine-readable error codes emitted by the CLI boundary.
 */
export type ErrorCode =
  | "discovery_failed"
  | "source_cache_failed"
  | "source_fetch_failed"
  | "source_revalidation_failed"
  | "citation_quote_ambiguous"
  | "citation_offset_mismatch"
  | "client_closed"
  | "research_unavailable"
  | "rfc_not_found"
  | "decision_model_failed"
  | "invalid_input"
  | "configuration_error"
  | "credential_missing"
  | "credential_store_unavailable"
  | "credential_access_denied"
  | "credential_storage_failed"
  | "credential_deletion_failed"
  | "operation_timeout"
  | "internal_error";

const ErrorCodeSchema = Schema.Literals([
  "discovery_failed",
  "source_cache_failed",
  "source_fetch_failed",
  "source_revalidation_failed",
  "citation_quote_ambiguous",
  "citation_offset_mismatch",
  "client_closed",
  "research_unavailable",
  "rfc_not_found",
  "decision_model_failed",
  "invalid_input",
  "configuration_error",
  "credential_missing",
  "credential_store_unavailable",
  "credential_access_denied",
  "credential_storage_failed",
  "credential_deletion_failed",
  "operation_timeout",
  "internal_error",
]);

/**
 * Schema for the stable machine-readable error envelope emitted by the CLI boundary.
 */
export const ErrorEnvelopeSchema = Schema.Struct({
  schemaVersion: Schema.Literal(schemaVersion),
  kind: Schema.Literal("error"),
  error: Schema.Struct({
    code: ErrorCodeSchema,
    message: Schema.String,
  }),
});

/**
 * A stable machine-readable error envelope emitted by the CLI boundary.
 */
export interface ErrorEnvelope {
  /**
   * Public protocol version.
   */
  readonly schemaVersion: typeof schemaVersion;
  /**
   * Identifies this value as an error response.
   */
  readonly kind: "error";
  /**
   * Stable error code and safe message.
   */
  readonly error: {
    readonly code: ErrorCode;
    readonly message: string;
  };
}

const TopicSearchTermSchema = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(datatrackerTopicSearchTermMaximumCharacters),
);

/**
 * Schema for version-three research requests.
 *
 * At least one of `rfcs` or `searchTerms` is required; both may be given, in
 * which case named RFCs and topic hits share one candidate pool.
 */
export const ResearchRequestSchema = Schema.Struct({
  schemaVersion: Schema.Literal(schemaVersion),
  questions: Schema.Array(Schema.NonEmptyString).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(retrievalPolicy.maxQuestions),
  ),
  rfcs: Schema.optionalKey(
    Schema.Array(Schema.NonEmptyString).check(
      Schema.isMinLength(1),
      Schema.isMaxLength(retrievalPolicy.maxRequestedRfcs),
    ),
  ),
  searchTerms: Schema.optionalKey(
    Schema.Array(TopicSearchTermSchema).check(
      Schema.isMinLength(1),
      Schema.isMaxLength(datatrackerTopicSearchTermLimit),
    ),
  ),
});

/**
 * A decoded schema-version-three research request.
 */
export interface ResearchRequest {
  /**
   * Public protocol version.
   */
  readonly schemaVersion: typeof schemaVersion;
  /**
   * One to four independently answered questions.
   */
  readonly questions: ReadonlyArray<string>;
  /**
   * One to four named RFC identifiers, each researched with its current successors.
   */
  readonly rfcs?: ReadonlyArray<string> | undefined;
  /**
   * One to four ordered topic-discovery terms sent verbatim to Datatracker.
   */
  readonly searchTerms?: ReadonlyArray<string> | undefined;
}

/**
 * Decode unknown research input at the public JSON boundary.
 *
 * @param input The unknown value received from JSON or convenience flags.
 * @returns A validated schema-version-three request.
 * @throws InvalidInputError when the value does not satisfy the version-three contract.
 */
export const decodeResearchRequest = (input: unknown): ResearchRequest => {
  let request: Schema.Schema.Type<typeof ResearchRequestSchema>;
  try {
    request = Schema.decodeUnknownSync(ResearchRequestSchema)(input);
  } catch {
    throw new InvalidInputError({
      reason: `Research input must use schema version ${schemaVersion} with one to four questions, up to four rfcs, and up to four bounded search terms`,
    });
  }
  if (request.rfcs === undefined && request.searchTerms === undefined) {
    throw new InvalidInputError({
      reason: "Research input must include rfcs, searchTerms, or both",
    });
  }
  return request;
};

/**
 * Schema for local-only status of one named RFC source-cache entry.
 */
export const RfcSourceCacheStatusSchema = Schema.Struct({
  schemaVersion: Schema.Literal(schemaVersion),
  kind: Schema.Literal("source_cache_status"),
  rfc: Schema.NonEmptyString,
  state: Schema.Literals(["hit", "miss"]),
});

/**
 * Local-only status for one named RFC source-cache entry.
 */
export type RfcSourceCacheStatus = Schema.Schema.Type<typeof RfcSourceCacheStatusSchema>;

/**
 * Schema for the result of removing one named RFC source-cache entry.
 */
export const RfcSourceCacheRemoveResultSchema = Schema.Struct({
  schemaVersion: Schema.Literal(schemaVersion),
  kind: Schema.Literal("source_cache_remove"),
  rfc: Schema.NonEmptyString,
  removed: Schema.Boolean,
});

/**
 * Result of removing one named RFC source-cache entry.
 */
export type RfcSourceCacheRemoveResult = Schema.Schema.Type<
  typeof RfcSourceCacheRemoveResultSchema
>;

/**
 * The public client boundary for RFC evidence operations.
 *
 * The interface intentionally contains Promise-returning methods and plain data
 * types only; Effect remains an implementation detail of the package.
 */
export interface RfcClient {
  /**
   * Inspect one named RFC source-cache entry without network access.
   */
  readonly sourceCacheStatus: (rfc: string) => Promise<RfcSourceCacheStatus>;
  /**
   * Remove one named RFC source-cache entry without network access.
   */
  readonly sourceCacheRemove: (rfc: string) => Promise<RfcSourceCacheRemoveResult>;
  /**
   * Research up to four questions against named RFCs, topic terms, or both.
   */
  readonly research: (request: ResearchRequest) => Promise<ResearchResult>;
  /**
   * Verify one factual claim against an exact quotation from a published RFC.
   */
  readonly verifyCitation: (
    request: CitationVerificationRequest,
  ) => Promise<CitationVerificationResult>;
  /**
   * Release the managed runtime and any resources it owns.
   */
  readonly close: () => Promise<void>;
  /**
   * Release the managed runtime through JavaScript's async-disposal protocol.
   */
  readonly [Symbol.asyncDispose]: () => Promise<void>;
}

const makeClock = (now: () => number): Clock.Clock => ({
  currentTimeMillisUnsafe: now,
  currentTimeMillis: Effect.sync(now),
  currentTimeNanosUnsafe: () => BigInt(now()) * 1_000_000n,
  currentTimeNanos: Effect.sync(() => BigInt(now()) * 1_000_000n),
  monotonicTimeNanosUnsafe: () => BigInt(now()) * 1_000_000n,
  monotonicTimeNanos: Effect.sync(() => BigInt(now()) * 1_000_000n),
  sleep: (duration) =>
    Effect.callback((resume, signal) => {
      const timer = setTimeout(() => resume(Effect.void), Duration.toMillis(duration));
      signal.addEventListener("abort", () => clearTimeout(timer), { once: true });
    }),
});

const typeSafeDecisionModelLayer = (options: RfcClientOptions) => {
  const observedClientLayer = Layer.fromBuildMemo(() =>
    Effect.gen(function* () {
      const resolvedModel = yield* Ref.make(options.modelAlias ?? retrievalPolicy.pinnedModel);
      const resolvedModels = yield* Ref.make<ReadonlyArray<string>>([]);
      const client = yield* TypeSafeClientApi.make({
        apiKey:
          options.typeSafeApiKey === undefined ? undefined : Redacted.make(options.typeSafeApiKey),
        apiUrl: options.typeSafeApiUrl,
      });
      const observedClient = {
        ...client,
        systemOne: (request: Parameters<typeof client.systemOne>[0]) =>
          client
            .systemOne(request)
            .pipe(
              Effect.tap((response) =>
                Effect.all([
                  Ref.set(resolvedModel, response.model),
                  Ref.update(resolvedModels, (models) => [...models, response.model]),
                ]),
              ),
            ),
      };
      return Context.make(TypeSafeClientApi.TypeSafeClient, observedClient).pipe(
        Context.add(ResolvedModelName, resolvedModel),
        Context.add(ResolvedModelNames, resolvedModels),
      );
    }),
  ).pipe(
    Layer.provide(
      options.typeSafeHttpClient === undefined
        ? FetchHttpClient.layer
        : Layer.succeed(HttpClient.HttpClient, options.typeSafeHttpClient),
    ),
  );

  return TypeSafeDecisionModel.model(options.modelAlias ?? retrievalPolicy.pinnedModel).pipe(
    Layer.provideMerge(observedClientLayer),
  );
};

const decisionModelLayer = (options: RfcClientOptions) =>
  options.decisionModel === undefined
    ? typeSafeDecisionModelLayer(options)
    : Layer.merge(
        Layer.succeed(DecisionModel.DecisionModel, options.decisionModel),
        Layer.merge(
          Layer.succeed(
            ResolvedModelName,
            Ref.makeUnsafe(options.modelAlias ?? retrievalPolicy.pinnedModel),
          ),
          Layer.succeed(ResolvedModelNames, Ref.makeUnsafe<ReadonlyArray<string>>([])),
        ),
      );

const platformLayer = (options: RfcClientOptions) => {
  const fetchOptions = Layer.succeed(FetchHttpClient.RequestInit, {
    redirect: "error" as const,
  });
  const base = Layer.mergeAll(
    NodeFileSystem.layer,
    NodePath.layer,
    FetchHttpClient.layer.pipe(Layer.provide(fetchOptions)),
  );
  if (options.clock !== undefined) {
    return Layer.merge(base, Layer.succeed(Clock.Clock, options.clock));
  }

  return options.now === undefined
    ? base
    : Layer.merge(base, Layer.succeed(Clock.Clock, makeClock(options.now)));
};

const clientLayer = (options: RfcClientOptions) => {
  const datatrackerBaseUrl = options.datatrackerApiUrl ?? defaultDatatrackerApiUrl;
  const rfcSearch = makeRfcSearchConfig(options.rfcSearchApiUrl, options.rfcSearchApiKey);
  // Sits beside the source cache under the same root so one cache directory
  // still describes everything this client retains.
  const metadataDirectory = join(options.cacheDirectory ?? defaultCacheDirectory, "metadata");
  const discoveryLayer =
    options.datatrackerHttpClient === undefined
      ? makeDefaultRfcDiscoveryLayer(datatrackerBaseUrl, metadataDirectory, rfcSearch)
      : makeRfcDiscoveryHttpLayer(
          options.datatrackerHttpClient,
          datatrackerBaseUrl,
          options.currencyTraversalDepthLimit,
          metadataDirectory,
          rfcSearch,
        );
  const liveRfcSourceLayer =
    options.rfcSourceFetcher !== undefined
      ? makeLiveRfcSourceLayer(options.rfcSourceFetcher)
      : options.rfcSourceHttpClient === undefined
        ? makeDefaultLiveRfcSourceLayer()
        : makeLiveRfcSourceHttpLayer(options.rfcSourceHttpClient);
  const services = Layer.merge(discoveryLayer, liveRfcSourceLayer).pipe(
    Layer.provideMerge(platformLayer(options)),
  );

  return Layer.merge(services, decisionModelLayer(options)).pipe(
    Layer.provideMerge(platformLayer(options)),
  );
};

const resolveSourceDirectory = Effect.fnUntraced(function* (options: RfcClientOptions) {
  const path = yield* Path.Path;
  const cacheDirectory = options.cacheDirectory ?? defaultCacheDirectory;
  return options.sourceDirectory ?? path.join(cacheDirectory, "sources");
});

const normalizeRfcCacheKey = (
  value: string,
): { readonly identifier: string; readonly rfcNumber: number } => {
  const match = /^(?:RFC)?([1-9]\d*)$/i.exec(value.trim());
  const rfcNumber = match === null ? Number.NaN : Number(match[1]);
  if (!Number.isSafeInteger(rfcNumber) || rfcNumber <= 0) {
    throw new InvalidInputError({ reason: "RFC source cache commands require a named RFC" });
  }
  return { identifier: `RFC${rfcNumber}`, rfcNumber };
};

const sourceCacheStatusProgram = (options: RfcClientOptions, rfc: string) =>
  Effect.gen(function* () {
    const key = normalizeRfcCacheKey(rfc);
    const sourceDirectory = yield* resolveSourceDirectory(options);
    const hit = yield* hasLiveRfcSourceCacheEntry(sourceDirectory, key.identifier, key.rfcNumber);
    return {
      schemaVersion,
      kind: "source_cache_status" as const,
      rfc: key.identifier,
      state: hit ? ("hit" as const) : ("miss" as const),
    };
  });

const sourceCacheRemoveProgram = (options: RfcClientOptions, rfc: string) =>
  Effect.gen(function* () {
    const key = normalizeRfcCacheKey(rfc);
    const sourceDirectory = yield* resolveSourceDirectory(options);
    const removed = yield* removeLiveRfcSourceCacheEntry(sourceDirectory, key.identifier);
    return {
      schemaVersion,
      kind: "source_cache_remove" as const,
      rfc: key.identifier,
      removed,
    };
  });

type LoadedLiveSource = {
  readonly document: RfcMetadata;
  /**
   * Successful load, or undefined when the attempt failed.
   */
  readonly result: LiveRfcSourceResult | undefined;
  readonly durationMs: number;
  /**
   * RFC Editor requests issued by this attempt, including rejected ones.
   */
  readonly attempts: number;
  /**
   * RFC Editor response status observed by a failed attempt, when one arrived.
   */
  readonly failureStatus: number | undefined;
};

const cacheOutcomeFor = (loads: ReadonlyArray<LoadedLiveSource>, identifier: string | undefined) =>
  (identifier === undefined
    ? loads[0]?.result?.outcome
    : loads.find(({ document }) => document.identifier === identifier)?.result?.outcome) ??
  "not_requested";

const sourceRequestTraces = (loads: ReadonlyArray<LoadedLiveSource>) =>
  loads
    .filter(({ attempts }) => attempts > 0)
    .map(({ document, durationMs, result, attempts, failureStatus }) => {
      const status = result?.status ?? failureStatus;
      return {
        kind: "source" as const,
        url: makeRfcSourceUrl(defaultRfcEditorBaseUrl, document.rfcNumber),
        attempts,
        status: status ?? null,
        statuses: status === undefined ? [] : [status],
        durationMs,
      };
    });

/**
 * RFC Editor requests a failed source load is known to have issued.
 *
 * Cache reads and decodes happen before any network access, so they report no
 * attempt. A cache write only runs after a successful fetch, so a persistence
 * failure must still be counted; reporting zero there would understate the
 * traffic the request actually produced. Fetch and revalidation failures each
 * represent at least one upstream attempt.
 */
const failedSourceAttempts = (error: unknown): number =>
  error instanceof RfcSourceCacheError && error.stage !== "write" ? 0 : 1;

/**
 * RFC Editor response status a failed source load observed, when one arrived.
 */
const failedSourceStatus = (error: unknown): number | undefined =>
  error instanceof RfcSourceFetchError || error instanceof RfcSourceRevalidationError
    ? error.status
    : undefined;

const makeLiveSourceLoader = (sourceDirectory: string, loads: Array<LoadedLiveSource>) =>
  Effect.fnUntraced(function* (document: RfcMetadata) {
    const startedAt = yield* Clock.currentTimeMillis;
    const outcome = yield* Effect.result(loadLiveRfcSource(document, sourceDirectory));
    const finishedAt = yield* Clock.currentTimeMillis;
    const durationMs = Math.max(0, finishedAt - startedAt);
    if (Result.isFailure(outcome)) {
      // A partial result must still account for the attempt it made.
      loads.push({
        document,
        result: undefined,
        durationMs,
        attempts: failedSourceAttempts(outcome.failure),
        failureStatus: failedSourceStatus(outcome.failure),
      });
      return yield* outcome.failure;
    }
    loads.push({
      document,
      result: outcome.success,
      durationMs,
      attempts: outcome.success.requestCount,
      failureStatus: undefined,
    });
    return outcome.success.source;
  });

/**
 * Diagnostics describing a topic search that degraded to Datatracker.
 *
 * Reported only when it happened, so a caller can tell a term that genuinely
 * matches nothing from one that went unmatched because discovery was running
 * on titles and abstracts alone.
 */
const topicSearchFallbackDiagnostics = (discovered: {
  readonly searchFallbackReason: string | undefined;
}): Record<string, unknown> =>
  discovered.searchFallbackReason === undefined
    ? {}
    : {
        topicSearchFallback: true,
        topicSearchFallbackReason: discovered.searchFallbackReason.slice(0, 512),
      };

const topicTrace = (discovered: LiveTopicDiscovery | undefined, poolSize: number) =>
  discovered === undefined
    ? {}
    : {
        upstreamRows: discovered.upstreamRows,
        uniqueCandidates: discovered.uniqueCandidates,
        mergeLimit: datatrackerDocumentCandidateLimit,
        semanticCandidates: poolSize,
        topicTruncated: discovered.truncated,
        ...topicSearchFallbackDiagnostics(discovered),
      };

const traversalTrace = (lookups: ReadonlyArray<LiveRfcLookup>) =>
  lookups.length === 0
    ? {}
    : {
        traversalComplete: lookups.every(({ traversalComplete }) => traversalComplete),
        traversalContexts: lookups.reduce((total, lookup) => total + lookup.traversalContexts, 0),
        traversalDepth: Math.max(...lookups.map(({ traversalDepth }) => traversalDepth)),
        successorRows: lookups.reduce((total, lookup) => total + lookup.successorRows, 0),
        boundedExits: [...new Set(lookups.flatMap(({ boundedExits }) => boundedExits))],
        contextLimit: datatrackerCurrencyContextLimit,
        depthLimit: Math.max(...lookups.map(({ depthLimit }) => depthLimit)),
        relationshipLimit: datatrackerSuccessorLimit,
      };

const uniqueRfcHints = (rfcs: ReadonlyArray<string>): ReadonlyArray<string> => [
  ...new Map(rfcs.map((rfc) => [rfc.trim().toUpperCase().replace(/\s+/g, ""), rfc])).values(),
];

const researchProgram = Effect.fnUntraced(function* (
  options: RfcClientOptions,
  request: ResearchRequest,
) {
  const startedAt = yield* Clock.currentTimeMillis;
  const discovery = yield* RfcDiscovery;
  const [lookups, discovered] = yield* Effect.all(
    [
      Effect.forEach(uniqueRfcHints(request.rfcs ?? []), (rfc) => discovery.lookupKnownRfc(rfc), {
        concurrency: "unbounded",
      }),
      request.searchTerms === undefined
        ? Effect.succeed(undefined)
        : discovery.discoverTopic(request.searchTerms),
    ],
    { concurrency: "unbounded" },
  );
  const metadataFinished = yield* Clock.currentTimeMillis;
  const { pool, currency } = buildCandidatePool(lookups, discovered?.documents ?? []);

  const sourceDirectory = yield* resolveSourceDirectory(options);
  const sourceLoads: Array<LoadedLiveSource> = [];
  const result = yield* researchQuestions({
    questions: request.questions,
    pool,
    sourceLoader: makeLiveSourceLoader(sourceDirectory, sourceLoads),
  });
  const finishedAt = yield* Clock.currentTimeMillis;

  const fallbackResolvedModel = yield* Ref.get(yield* ResolvedModelName);
  const observedResolvedModels = yield* Ref.get(yield* ResolvedModelNames);
  const resolvedModels =
    observedResolvedModels.length === 0
      ? [fallbackResolvedModel]
      : [...new Set(observedResolvedModels)];
  const metadataRequests = [
    ...lookups.flatMap(({ requests }) => requests),
    ...(discovered?.requests ?? []),
  ];
  const sourceRequests = sourceRequestTraces(sourceLoads);
  const requests = [...metadataRequests, ...sourceRequests];
  const metadataMs = Math.max(0, metadataFinished - startedAt);
  const inputTokens = result.usage.inputTokens ?? null;

  return Schema.decodeUnknownSync(ResearchResultSchema)({
    schemaVersion,
    kind: "research_result",
    answers: result.answers,
    ...(lookups.length === 0 ? {} : { currency }),
    diagnostics: {
      policyVersion: retrievalPolicy.policyVersion,
      requestedModel: options.modelAlias ?? retrievalPolicy.pinnedModel,
      resolvedModels,
      usage: { inputTokens, outputTokens: result.usage.outputTokens ?? null },
      inputCost: estimateInputTokenCost(inputTokens, resolvedModels),
      timings: {
        metadataMs,
        ...result.timings,
        totalMs: Math.max(0, finishedAt - startedAt),
      },
      retrieval: {
        schemaVersion,
        requestCount: requests.length,
        datatrackerRequestCount: metadataRequests.length,
        sourceRequestCount: sourceRequests.length,
        metadataMs,
        sourceMs: result.timings.sourceMs,
        sourceCacheOutcome: cacheOutcomeFor(sourceLoads, undefined),
        selectedSources: sourceLoads.length,
        ...topicTrace(discovered, pool.length),
        ...traversalTrace(lookups),
        requests,
      },
      candidates: { pool: pool.length, ranked: result.rankedCount },
    },
  });
});

const citationProgram = (options: RfcClientOptions, request: CitationVerificationRequest) =>
  Effect.gen(function* () {
    const startedAt = yield* Clock.currentTimeMillis;
    const discovery = yield* RfcDiscovery;
    const lookup = yield* discovery.lookupExactRfc(request.rfc);
    const sourceDirectory = yield* resolveSourceDirectory(options);
    const sourceLoads: Array<LoadedLiveSource> = [];
    const loadSource = makeLiveSourceLoader(sourceDirectory, sourceLoads);
    return yield* verifyCitation(request, {
      document: lookup.document,
      sourceLoader: (document) =>
        Effect.gen(function* () {
          const source = yield* loadSource(document);
          const sourceMs = sourceLoads.reduce((total, load) => total + load.durationMs, 0);
          const sourceRequests = sourceRequestTraces(sourceLoads);
          const requests = [...lookup.requests, ...sourceRequests];
          return {
            source,
            retrieval: {
              schemaVersion,
              requestCount: requests.length,
              datatrackerRequestCount: lookup.requests.length,
              sourceRequestCount: sourceRequests.length,
              metadataMs: lookup.metadataMs,
              sourceMs,
              sourceCacheOutcome: cacheOutcomeFor(sourceLoads, document.identifier),
              requests,
            },
          };
        }),
      modelAlias: options.modelAlias ?? retrievalPolicy.pinnedModel,
      metadataMs: lookup.metadataMs,
      startedAt,
    });
  });

const resetModelTrackingProgram = (options: RfcClientOptions) =>
  Effect.gen(function* () {
    const resolvedModel = yield* ResolvedModelName;
    const resolvedModels = yield* ResolvedModelNames;
    yield* Ref.set(resolvedModel, options.modelAlias ?? retrievalPolicy.pinnedModel);
    yield* Ref.set(resolvedModels, []);
  });

/**
 * Maximum characters of an upstream failure description carried into a public
 * error envelope.
 */
const errorEnvelopeReasonMaximumCharacters = 200;

/**
 * Bound an upstream failure description before it enters a public envelope.
 *
 * A typed error's reason originates in a provider, platform, or HTTP layer and
 * can embed a response body of unknown size and content. The envelope is
 * documented as safe and is written to standard error and to MCP tool errors,
 * so the description is collapsed to a single bounded line.
 *
 * @param reason The upstream failure description.
 * @returns A single-line description no longer than the bound.
 */
const boundedReason = (reason: string): string => {
  const collapsed = reason.replace(/\s+/g, " ").trim();
  return collapsed.length <= errorEnvelopeReasonMaximumCharacters
    ? collapsed
    : `${collapsed.slice(0, errorEnvelopeReasonMaximumCharacters - 1)}…`;
};

/**
 * Convert an unknown boundary failure into the versioned CLI error envelope.
 *
 * @param error The rejected value from a core Promise operation.
 * @returns A safe, serializable error envelope.
 */
export const toErrorEnvelope = (error: unknown): ErrorEnvelope => {
  if (error instanceof RfcIdentifierError) {
    return {
      schemaVersion,
      kind: "error",
      error: {
        code: "invalid_input",
        message: boundedReason(error.reason),
      },
    };
  }

  if (error instanceof RfcDiscoveryError) {
    return {
      schemaVersion,
      kind: "error",
      error: {
        code: "discovery_failed",
        message: `Unable to retrieve live RFC metadata from ${error.url}: ${boundedReason(error.reason)}`,
      },
    };
  }

  if (error instanceof RfcSourceCacheError) {
    return {
      schemaVersion,
      kind: "error",
      error: {
        code: "source_cache_failed",
        message: `Unable to read RFC source cache: ${boundedReason(error.reason)}`,
      },
    };
  }

  if (error instanceof RfcSourceFetchError) {
    return {
      schemaVersion,
      kind: "error",
      error: {
        code: "source_fetch_failed",
        message: `Unable to fetch RFC source from ${error.url}: ${boundedReason(error.reason)}`,
      },
    };
  }

  if (error instanceof RfcSourceRevalidationError) {
    return {
      schemaVersion,
      kind: "error",
      error: {
        code: "source_revalidation_failed",
        message: `Unable to revalidate stale RFC source from ${error.url}: ${boundedReason(error.reason)}`,
      },
    };
  }

  if (error instanceof CitationQuoteAmbiguousError) {
    return {
      schemaVersion,
      kind: "error",
      error: {
        code: "citation_quote_ambiguous",
        message: `The quotation occurs ${error.occurrences} times in RFC ${error.rfc}; provide an exact offset`,
      },
    };
  }

  if (error instanceof CitationOffsetMismatchError) {
    return {
      schemaVersion,
      kind: "error",
      error: {
        code: "citation_offset_mismatch",
        message: `The supplied offset does not identify the exact quotation in RFC ${error.rfc}`,
      },
    };
  }

  if (error instanceof RfcNotFoundError) {
    return {
      schemaVersion,
      kind: "error",
      error: {
        code: "rfc_not_found",
        message: `RFC ${error.rfc} is not an exact published RFC`,
      },
    };
  }

  if (error instanceof DecisionModelError) {
    return {
      schemaVersion,
      kind: "error",
      error: {
        code: "decision_model_failed",
        message: `DecisionModel ${error.stage} failed: ${boundedReason(error.reason)}`,
      },
    };
  }

  if (error instanceof RfcClientClosedError) {
    return {
      schemaVersion,
      kind: "error",
      error: {
        code: "client_closed",
        message: "The RFC client is already closed",
      },
    };
  }

  if (error instanceof ResearchUnavailableError) {
    return {
      schemaVersion,
      kind: "error",
      error: {
        code: "research_unavailable",
        message: "Topic-only research is not available in this release",
      },
    };
  }

  if (error instanceof InvalidInputError) {
    return {
      schemaVersion,
      kind: "error",
      error: {
        code: "invalid_input",
        message: boundedReason(error.reason),
      },
    };
  }

  if (error instanceof OperationTimeoutError) {
    return {
      schemaVersion,
      kind: "error",
      error: {
        code: "operation_timeout",
        message: `The operation exceeded its ${error.milliseconds} ms budget`,
      },
    };
  }

  if (error instanceof ConfigurationError) {
    return {
      schemaVersion,
      kind: "error",
      error: {
        code: "configuration_error",
        message: `Unable to load CLI configuration: ${boundedReason(error.reason)}`,
      },
    };
  }

  return {
    schemaVersion,
    kind: "error",
    error: {
      code: "internal_error",
      message: "The RFC evidence engine failed unexpectedly",
    },
  };
};

const defaultClientOptions: RfcClientOptions = {
  operationBudgetMilliseconds: undefined,
  cacheDirectory: undefined,
  datatrackerApiUrl: undefined,
  datatrackerHttpClient: undefined,
  modelAlias: undefined,
  typeSafeApiKey: undefined,
  typeSafeApiUrl: undefined,
  typeSafeHttpClient: undefined,
  now: undefined,
  rfcSourceFetcher: undefined,
  rfcSourceHttpClient: undefined,
  sourceDirectory: undefined,
  decisionModel: undefined,
};

/**
 * Construct a Promise-based RFC evidence client backed by one managed Effect runtime.
 *
 * @param options Cache, discovery, clock, and provider options used by the client.
 * @returns A Promise for a client with explicit close and async-disposal methods.
 */
export const createRfcClient = async (
  options: RfcClientOptions = defaultClientOptions,
): Promise<RfcClient> => {
  const runtime = ManagedRuntime.make(clientLayer(options));
  let closed = false;
  // The provider layer is client-scoped, so model-backed boundaries are
  // serialized and reset before/after each operation to prevent cross-request
  // model observations from entering public diagnostics.
  let modelOperationTail: Promise<void> = Promise.resolve();

  const assertOpen = (): void => {
    if (closed) {
      throw new RfcClientClosedError({});
    }
  };

  let closing: Promise<void> | undefined;

  const close = async (): Promise<void> => {
    closed = true;
    // Disposing the runtime out from under a running operation tears away the
    // provider layer it is still using, so the caller's pending promise fails
    // with a runtime error instead of returning its own result. Every model
    // operation carries an overall budget, so this wait is bounded, and the
    // tail never rejects. A second close awaits the same completion rather
    // than returning while disposal is still in flight.
    closing ??= modelOperationTail.then(() => runtime.dispose());
    return closing;
  };

  const operationBudget = Math.min(
    options.operationBudgetMilliseconds ?? operationBudgetMilliseconds,
    operationBudgetMilliseconds,
  );

  const runModelOperation = <A>(program: Effect.Effect<A, any, any>): Promise<A> => {
    const operation = modelOperationTail.then(async () => {
      await runtime.runPromise(resetModelTrackingProgram(options));
      try {
        // Every retrieval and provider stage carries its own deadline, but a
        // request fans out across a bounded set of contexts and each stage
        // restarts that deadline. Without a ceiling across all of them, a
        // slow-but-responsive upstream can hold a call open for minutes.
        return await runtime.runPromise(
          Effect.timeoutOrElse(program, {
            duration: Duration.millis(operationBudget),
            orElse: () => Effect.fail(new OperationTimeoutError({ milliseconds: operationBudget })),
          }),
        );
      } finally {
        await runtime.runPromise(resetModelTrackingProgram(options));
      }
    });
    modelOperationTail = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  };

  const client: RfcClient = {
    sourceCacheStatus: async (rfc) => {
      assertOpen();
      return runtime.runPromise(sourceCacheStatusProgram(options, rfc));
    },
    sourceCacheRemove: async (rfc) => {
      assertOpen();
      return runtime.runPromise(sourceCacheRemoveProgram(options, rfc));
    },
    research: async (request) => {
      assertOpen();
      const decodedRequest = decodeResearchRequest(request);
      return runModelOperation(researchProgram(options, decodedRequest));
    },
    verifyCitation: async (request) => {
      assertOpen();
      let decodedRequest: CitationVerificationRequest;
      try {
        decodedRequest = decodeCitationVerificationRequest(request);
      } catch {
        throw new InvalidInputError({
          reason: "Citation input must use schema version 2",
        });
      }
      return runModelOperation(citationProgram(options, decodedRequest));
    },
    close,
    [Symbol.asyncDispose]: close,
  };

  return client;
};
