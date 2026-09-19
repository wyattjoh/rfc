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
  Schema,
} from "effect";
import * as DecisionModel from "effect/unstable/ai/DecisionModel";
import { FetchHttpClient, HttpClient } from "effect/unstable/http";
import { isAcceptedEvaluationReport } from "./evaluation";
import {
  RfcSourceRevalidationError,
  loadLiveRfcSource,
  makeDefaultLiveRfcSourceLayer,
  makeLiveRfcSourceHttpLayer,
  makeLiveRfcSourceLayer,
  type LiveRfcSourceResult,
} from "./live-source";
import {
  calibrationAnswerActivation,
  makeArtifactActivation,
  type AutomaticAnswerActivation,
} from "./activation";
import {
  CatalogRefreshError,
  CatalogStore,
  CatalogStaleError,
  DatatrackerCatalogSource,
  catalogRefreshResultFromValue,
  catalogStatusFromValue,
  catalogStoreLayer,
  defaultDatatrackerApiUrl,
  makeCatalog,
  makeCatalogSourceLayer,
  makeDefaultCatalogSourceLayer,
} from "./catalog";
import type { CatalogSource } from "./catalog";
import { registerCalibrationOperations } from "./internal-client";
import {
  RfcDiscovery,
  RfcDiscoveryError,
  datatrackerCurrencyContextLimit,
  datatrackerCurrencyDepthLimit,
  datatrackerSuccessorLimit,
  makeDefaultRfcDiscoveryLayer,
  makeRfcDiscoveryHttpLayer,
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
  EvidenceBundleSchema,
  precisionPolicy,
  ResearchPolicyError,
  ResolvedModelName,
  ResolvedModelNames,
  RfcNotFoundError,
  researchKnownRfc,
  researchTopic,
} from "./research";
import type { EvidenceBundle } from "./research";
import {
  RfcSourceCacheError,
  RfcSourceFetchError,
  defaultRfcEditorBaseUrl,
  loadRfcSource,
  makeRfcSourceUrl,
  makeDefaultRfcSourceLayer,
  makeRfcSourceHttpLayer,
  makeRfcSourceLayer,
  rfcSourceStoreLayer,
} from "./source";
import type { RfcSourceFetcher } from "./source";

export * from "./citation";
export * from "./discovery";
export * from "./evaluation";
export * from "./live-source";
export * from "./offsets";
export * from "./research";
export * from "./source";

export type { AutomaticAnswerActivation } from "./activation";

/**
 * Decode a locally accepted calibration artifact into an activation proof.
 *
 * @param input Unknown report data from the local calibration artifact.
 * @returns An activation proof when every current release gate passes.
 */
export const automaticAnswerActivationFromReport = (
  input: unknown,
): AutomaticAnswerActivation | undefined =>
  isAcceptedEvaluationReport(input) ? makeArtifactActivation() : undefined;

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
 * The version of the public JSON contracts exposed by the RFC evidence engine.
 */
export const schemaVersion = 2 as const;

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
   * Optional HTTP service used by deterministic live-discovery tests.
   */
  readonly datatrackerHttpClient?: HttpClient.HttpClient | undefined;
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
   * Named policy preset recorded in research diagnostics.
   */
  readonly policyPreset?: string | undefined;
  /**
   * Opaque activation proof supplied by the validated composition root.
   */
  readonly automaticAnswerActivation: AutomaticAnswerActivation | undefined;
  /**
   * A deterministic DecisionModel replacement for tests and embedded callers.
   */
  readonly decisionModel?: DecisionModel.DecisionModel | undefined;
}

interface RuntimeClientOptions extends RfcClientOptions {
  readonly catalogPath?: string | undefined;
  readonly catalogSource?: CatalogSource | undefined;
  readonly catalogHttpClient?: HttpClient.HttpClient | undefined;
  readonly catalogFetch?: typeof globalThis.fetch | undefined;
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
 * The operational errors exposed by the Promise facade.
 */
export type RfcCoreError =
  | RfcDiscoveryError
  | RfcSourceCacheError
  | RfcSourceFetchError
  | RfcSourceRevalidationError
  | CitationQuoteAmbiguousError
  | CitationOffsetMismatchError
  | RfcClientClosedError
  | ResearchUnavailableError
  | RfcNotFoundError
  | DecisionModelError
  | ResearchPolicyError
  | InvalidInputError
  | ConfigurationError;

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
  | "policy_error"
  | "invalid_input"
  | "configuration_error"
  | "credential_missing"
  | "credential_store_unavailable"
  | "credential_access_denied"
  | "credential_storage_failed"
  | "credential_deletion_failed"
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
  "policy_error",
  "invalid_input",
  "configuration_error",
  "credential_missing",
  "credential_store_unavailable",
  "credential_access_denied",
  "credential_storage_failed",
  "credential_deletion_failed",
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

const LegacyResearchRequestSchema = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  question: Schema.NonEmptyString,
  rfc: Schema.NullOr(Schema.String),
});

type LegacyResearchRequest = Schema.Schema.Type<typeof LegacyResearchRequestSchema>;

const KnownRfcResearchRequestInputSchema = Schema.Struct({
  schemaVersion: Schema.Literal(schemaVersion),
  question: Schema.NonEmptyString,
  rfc: Schema.NonEmptyString,
  searchTerms: Schema.optionalKey(Schema.Undefined),
});

const TopicSearchTermSchema = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200));

const TopicResearchRequestInputSchema = Schema.Struct({
  schemaVersion: Schema.Literal(schemaVersion),
  question: Schema.NonEmptyString,
  rfc: Schema.Null,
  searchTerms: Schema.Array(TopicSearchTermSchema).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(4),
  ),
});

/**
 * Schema for version-two known-RFC and topic research requests.
 */
export const ResearchRequestSchema = Schema.Union([
  KnownRfcResearchRequestInputSchema,
  TopicResearchRequestInputSchema,
]);

/**
 * A schema-version-two request for exact known-RFC research.
 */
export interface LiveKnownRfcResearchRequest {
  readonly schemaVersion: typeof schemaVersion;
  readonly question: string;
  readonly rfc: string;
  readonly searchTerms: undefined;
}

/**
 * A schema-version-two request for bounded topic discovery.
 */
export interface LiveTopicResearchRequest {
  readonly schemaVersion: typeof schemaVersion;
  readonly question: string;
  readonly rfc: null;
  readonly searchTerms: ReadonlyArray<string>;
}

/**
 * A decoded schema-version-two research request.
 */
export type ResearchRequest = LiveKnownRfcResearchRequest | LiveTopicResearchRequest;

/**
 * Decode unknown research input at the public JSON boundary.
 *
 * @param input The unknown value received from JSON or convenience flags.
 * @returns A validated schema-version-two known-RFC or topic request.
 * @throws InvalidInputError when the value does not satisfy the version-two contract.
 */
const decodeLegacyResearchRequest = (input: unknown): LegacyResearchRequest =>
  Schema.decodeUnknownSync(LegacyResearchRequestSchema)(input);

export const decodeResearchRequest = (input: unknown): ResearchRequest => {
  try {
    const request = Schema.decodeUnknownSync(KnownRfcResearchRequestInputSchema)(input);
    if (request.searchTerms !== undefined) {
      throw new InvalidInputError({
        reason: "Known-RFC research must not include topic search terms",
      });
    }
    return { ...request, searchTerms: undefined };
  } catch (error) {
    if (error instanceof InvalidInputError) throw error;
  }

  try {
    const request = Schema.decodeUnknownSync(TopicResearchRequestInputSchema)(input);
    if (
      request.searchTerms.length < 1 ||
      request.searchTerms.length > 4 ||
      request.searchTerms.some((term) => term.length === 0 || term.length > 200)
    ) {
      throw new Error("invalid search terms");
    }
    return request;
  } catch {
    throw new InvalidInputError({
      reason:
        "Research input must use schema version 2 with an RFC or one to four bounded search terms",
    });
  }
};

/**
 * The public client boundary for RFC evidence operations.
 *
 * The interface intentionally contains Promise-returning methods and plain data
 * types only; Effect remains an implementation detail of the package.
 */
export interface RfcClient {
  /**
   * Research one topic or known published RFC and return exact evidence.
   */
  readonly research: (request: ResearchRequest) => Promise<EvidenceBundle>;
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
      const resolvedModel = yield* Ref.make(options.modelAlias ?? precisionPolicy.pinnedModel);
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

  return TypeSafeDecisionModel.model(options.modelAlias ?? precisionPolicy.pinnedModel).pipe(
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
            Ref.makeUnsafe(options.modelAlias ?? precisionPolicy.pinnedModel),
          ),
          Layer.succeed(ResolvedModelNames, Ref.makeUnsafe<ReadonlyArray<string>>([])),
        ),
      );

const platformLayer = (options: RuntimeClientOptions) => {
  const fetchOptions = Layer.succeed(FetchHttpClient.RequestInit, {
    redirect: "error" as const,
  });
  const fetchLayer =
    options.catalogFetch === undefined
      ? FetchHttpClient.layer.pipe(Layer.provide(fetchOptions))
      : FetchHttpClient.layer.pipe(
          Layer.provide(
            Layer.merge(fetchOptions, Layer.succeed(FetchHttpClient.Fetch, options.catalogFetch)),
          ),
        );
  const httpLayer =
    options.catalogHttpClient === undefined
      ? fetchLayer
      : Layer.succeed(HttpClient.HttpClient, options.catalogHttpClient);
  const base = Layer.mergeAll(NodeFileSystem.layer, NodePath.layer, httpLayer);
  if (options.clock !== undefined) {
    return Layer.merge(base, Layer.succeed(Clock.Clock, options.clock));
  }

  return options.now === undefined
    ? base
    : Layer.merge(base, Layer.succeed(Clock.Clock, makeClock(options.now)));
};

const clientLayer = (options: RuntimeClientOptions) => {
  const datatrackerBaseUrl = options.datatrackerApiUrl ?? defaultDatatrackerApiUrl;
  const catalogSourceLayer =
    options.catalogSource === undefined
      ? makeDefaultCatalogSourceLayer(datatrackerBaseUrl)
      : makeCatalogSourceLayer(options.catalogSource);
  const discoveryLayer =
    options.datatrackerHttpClient === undefined
      ? makeDefaultRfcDiscoveryLayer(datatrackerBaseUrl)
      : makeRfcDiscoveryHttpLayer(options.datatrackerHttpClient, datatrackerBaseUrl);
  const rfcSourceLayer =
    options.rfcSourceFetcher !== undefined
      ? makeRfcSourceLayer(options.rfcSourceFetcher)
      : options.rfcSourceHttpClient === undefined
        ? makeDefaultRfcSourceLayer(defaultRfcEditorBaseUrl)
        : makeRfcSourceHttpLayer(options.rfcSourceHttpClient, defaultRfcEditorBaseUrl);
  const liveRfcSourceLayer =
    options.rfcSourceFetcher !== undefined
      ? makeLiveRfcSourceLayer(options.rfcSourceFetcher)
      : options.rfcSourceHttpClient === undefined
        ? makeDefaultLiveRfcSourceLayer()
        : makeLiveRfcSourceHttpLayer(options.rfcSourceHttpClient);
  const services = Layer.mergeAll(
    catalogStoreLayer,
    rfcSourceStoreLayer,
    catalogSourceLayer,
    discoveryLayer,
    rfcSourceLayer,
    liveRfcSourceLayer,
  ).pipe(Layer.provideMerge(platformLayer(options)));

  return Layer.merge(services, decisionModelLayer(options)).pipe(
    Layer.provideMerge(platformLayer(options)),
  );
};

const resolveCatalogPath = Effect.fnUntraced(function* (options: RuntimeClientOptions) {
  const path = yield* Path.Path;
  const cacheDirectory = options.cacheDirectory ?? defaultCacheDirectory;
  return options.catalogPath ?? path.join(cacheDirectory, "catalog.json");
});

const resolveSourceDirectory = Effect.fnUntraced(function* (options: RuntimeClientOptions) {
  const path = yield* Path.Path;
  const cacheDirectory = options.cacheDirectory ?? defaultCacheDirectory;
  return options.sourceDirectory ?? path.join(cacheDirectory, "sources");
});

const catalogStatusProgram = (options: RuntimeClientOptions) =>
  Effect.gen(function* () {
    const store = yield* CatalogStore;
    const catalogPath = yield* resolveCatalogPath(options);
    return yield* store.status(catalogPath);
  });

const catalogRefreshProgram = (options: RuntimeClientOptions) =>
  Effect.gen(function* () {
    const store = yield* CatalogStore;
    const source = yield* DatatrackerCatalogSource;
    const catalogPath = yield* resolveCatalogPath(options);
    const documents = yield* source.refresh();
    const now = yield* Clock.currentTimeMillis;
    const catalog = makeCatalog(documents, now);
    yield* store.write(catalogPath, catalog).pipe(
      Effect.mapError(
        (error) =>
          new CatalogRefreshError({
            stage: "write",
            url: catalogPath,
            reason: error.reason,
          }),
      ),
    );
    return catalogRefreshResultFromValue(catalogPath, catalog, now);
  });

const knownCatalogProgram = (options: RuntimeClientOptions) =>
  Effect.gen(function* () {
    const store = yield* CatalogStore;
    const startedAt = yield* Clock.currentTimeMillis;
    const catalogPath = yield* resolveCatalogPath(options);
    const initialStatus = yield* store.status(catalogPath);
    if (initialStatus.state !== "fresh") {
      yield* catalogRefreshProgram(options);
    }
    const catalogStatus = yield* store.status(catalogPath);
    const catalog = yield* store.read(catalogPath);
    if (catalog === undefined) {
      return yield* new CatalogStaleError({
        catalogPath,
        fetchedAt: catalogStatus.refreshedAt ?? "",
        ageMs: catalogStatus.ageMs ?? Number.POSITIVE_INFINITY,
      });
    }
    const sourceDirectory = yield* resolveSourceDirectory(options);
    const finishedAt = yield* Clock.currentTimeMillis;

    return {
      catalog,
      catalogStatus,
      sourceDirectory,
      catalogMs: Math.max(0, finishedAt - startedAt),
      startedAt,
    };
  });

const prefetchSourcesProgram = (
  options: RuntimeClientOptions,
  identifiers: ReadonlyArray<string>,
) =>
  Effect.gen(function* () {
    const context = yield* knownCatalogProgram(options);
    for (const identifier of identifiers) {
      const document = context.catalog.documents.find(
        (candidate) => candidate.identifier === identifier,
      );
      if (document === undefined) {
        return yield* new RfcNotFoundError({ rfc: identifier });
      }
      yield* loadRfcSource(document, context.sourceDirectory);
    }
  });

type LoadedLiveSource = {
  readonly document: import("./catalog").CatalogDocument;
  readonly result: LiveRfcSourceResult;
};

const cacheOutcomeFor = (loads: ReadonlyArray<LoadedLiveSource>, identifier: string | undefined) =>
  (identifier === undefined
    ? loads[0]?.result.outcome
    : loads.find(({ document }) => document.identifier === identifier)?.result.outcome) ??
  "not_requested";

const sourceRequestTraces = (loads: ReadonlyArray<LoadedLiveSource>, sourceMs: number) =>
  loads.map(({ document, result }) => ({
    kind: "source" as const,
    url: makeRfcSourceUrl(defaultRfcEditorBaseUrl, document.rfcNumber),
    attempts: result.requestCount,
    status: result.status ?? null,
    statuses: result.status === undefined ? [] : [result.status],
    durationMs: loads.length === 0 ? 0 : sourceMs / loads.length,
  }));

const liveKnownResearchProgram = Effect.fnUntraced(function* (
  options: RfcClientOptions,
  request: LiveKnownRfcResearchRequest,
) {
  const startedAt = yield* Clock.currentTimeMillis;
  const discovery = yield* RfcDiscovery;
  const lookup = yield* discovery.lookupKnownRfc(request.rfc);
  const sourceDirectory = yield* resolveSourceDirectory(options);
  const sourceLoads: Array<LoadedLiveSource> = [];
  const sourceLoader = (document: import("./catalog").CatalogDocument) =>
    loadLiveRfcSource(document, sourceDirectory).pipe(
      Effect.tap((result) =>
        Effect.sync(() => {
          sourceLoads.push({ document, result });
        }),
      ),
      Effect.map(({ source }) => source),
    );
  const now = yield* Clock.currentTimeMillis;
  const requestLocalMetadata = makeCatalog(lookup.documents, now);
  const result = yield* researchKnownRfc(request.question, request.rfc, {
    catalog: requestLocalMetadata,
    catalogStatus: catalogStatusFromValue(
      "request-local://rfc-discovery",
      requestLocalMetadata,
      now,
    ),
    sourceDirectory,
    sourceLoader,
    policyPreset: options.policyPreset ?? "precision-v1",
    // Live discovery is not covered by the precision-v1 release attestation.
    // Ticket 07 introduces the precision-v2 activation gate.
    automaticAnswerActivation: undefined,
    modelAlias: options.modelAlias ?? precisionPolicy.pinnedModel,
    catalogMs: lookup.metadataMs,
    startedAt,
  });
  const sourceRequestCount = sourceLoads.reduce(
    (count, load) => count + load.result.requestCount,
    0,
  );
  const datatrackerRequestCount = lookup.requests.reduce(
    (count, trace) => count + trace.attempts,
    0,
  );
  const retrieval = {
    schemaVersion: 2 as const,
    requestCount: datatrackerRequestCount + sourceRequestCount,
    datatrackerRequestCount,
    sourceRequestCount,
    metadataMs: lookup.metadataMs,
    sourceMs: result.diagnostics.timings.sourceMs,
    sourceCacheOutcome: cacheOutcomeFor(sourceLoads, lookup.document.identifier),
    traversalComplete: lookup.traversalComplete,
    traversalContexts: lookup.traversalContexts,
    traversalDepth: lookup.traversalDepth,
    successorRows: lookup.successorRows,
    contextLimit: datatrackerCurrencyContextLimit,
    depthLimit: datatrackerCurrencyDepthLimit,
    relationshipLimit: datatrackerSuccessorLimit,
    requests: [
      ...lookup.requests,
      ...sourceRequestTraces(sourceLoads, result.diagnostics.timings.sourceMs),
    ],
  };
  const { catalog: _catalog, ...legacyDiagnostics } = result.diagnostics;
  const currency =
    lookup.traversalComplete || result.currency === undefined
      ? result.currency
      : {
          ...result.currency,
          complete: false,
          issues: [...new Set([...result.currency.issues, "traversal_limit" as const])],
        };

  return Schema.decodeUnknownSync(EvidenceBundleSchema)({
    ...result,
    schemaVersion: 2,
    status: lookup.traversalComplete ? result.status : "needs_review",
    currency,
    diagnostics: {
      ...legacyDiagnostics,
      schemaVersion: 2,
      currency,
      retrieval,
    },
  });
});

const liveTopicResearchProgram = Effect.fnUntraced(function* (
  options: RfcClientOptions,
  request: LiveTopicResearchRequest,
) {
  const startedAt = yield* Clock.currentTimeMillis;
  const discovery = yield* RfcDiscovery;
  const discovered = yield* discovery.discoverTopic(request.searchTerms);
  const sourceDirectory = yield* resolveSourceDirectory(options);
  const sourceLoads: Array<LoadedLiveSource> = [];
  const sourceLoader = (document: import("./catalog").CatalogDocument) =>
    loadLiveRfcSource(document, sourceDirectory).pipe(
      Effect.tap((result) =>
        Effect.sync(() => {
          sourceLoads.push({ document, result });
        }),
      ),
      Effect.map(({ source }) => source),
    );
  const now = yield* Clock.currentTimeMillis;
  const requestLocalMetadata = makeCatalog(discovered.documents, now);
  const result = yield* researchTopic(request.question, {
    catalog: requestLocalMetadata,
    catalogStatus: catalogStatusFromValue(
      "request-local://rfc-discovery",
      requestLocalMetadata,
      now,
    ),
    documentCandidates: discovered.documents,
    sourceDirectory,
    sourceLoader,
    policyPreset: options.policyPreset ?? "precision-v1",
    automaticAnswerActivation: undefined,
    modelAlias: options.modelAlias ?? precisionPolicy.pinnedModel,
    catalogMs: discovered.metadataMs,
    startedAt,
  });
  const sourceRequestCount = sourceLoads.reduce(
    (count, load) => count + load.result.requestCount,
    0,
  );
  const datatrackerRequestCount = discovered.requests.reduce(
    (count, trace) => count + trace.attempts,
    0,
  );
  const retrieval = {
    schemaVersion: 2 as const,
    requestCount: datatrackerRequestCount + sourceRequestCount,
    datatrackerRequestCount,
    sourceRequestCount,
    metadataMs: discovered.metadataMs,
    sourceMs: result.diagnostics.timings.sourceMs,
    sourceCacheOutcome: cacheOutcomeFor(sourceLoads, result.rfc?.identifier),
    upstreamRows: discovered.upstreamRows,
    uniqueCandidates: discovered.documents.length,
    requests: [
      ...discovered.requests,
      ...sourceRequestTraces(sourceLoads, result.diagnostics.timings.sourceMs),
    ],
  };
  const { catalog: _catalog, ...legacyDiagnostics } = result.diagnostics;

  return Schema.decodeUnknownSync(EvidenceBundleSchema)({
    ...result,
    schemaVersion: 2,
    status: discovered.documents.length === 0 ? "needs_review" : result.status,
    diagnostics: {
      ...legacyDiagnostics,
      schemaVersion: 2,
      retrieval,
    },
  });
});

const legacyResearchProgram = (options: RuntimeClientOptions, request: LegacyResearchRequest) =>
  Effect.gen(function* () {
    const context = yield* knownCatalogProgram(options);
    const researchOptions = {
      ...context,
      policyPreset: options.policyPreset ?? "precision-v1",
      automaticAnswerActivation: options.automaticAnswerActivation,
      modelAlias: options.modelAlias ?? precisionPolicy.pinnedModel,
    };
    return request.rfc === null
      ? yield* researchTopic(request.question, researchOptions)
      : yield* researchKnownRfc(request.question, request.rfc, researchOptions);
  });

const researchProgram = (options: RfcClientOptions, request: ResearchRequest) =>
  request.rfc === null
    ? liveTopicResearchProgram(options, request)
    : liveKnownResearchProgram(options, request);

const citationProgram = (options: RuntimeClientOptions, request: CitationVerificationRequest) =>
  Effect.gen(function* () {
    const context = yield* knownCatalogProgram(options);
    return yield* verifyCitation(request, {
      ...context,
      modelAlias: options.modelAlias ?? precisionPolicy.pinnedModel,
    });
  });

const resetModelTrackingProgram = (options: RfcClientOptions) =>
  Effect.gen(function* () {
    const resolvedModel = yield* ResolvedModelName;
    const resolvedModels = yield* ResolvedModelNames;
    yield* Ref.set(resolvedModel, options.modelAlias ?? precisionPolicy.pinnedModel);
    yield* Ref.set(resolvedModels, []);
  });

/**
 * Convert an unknown boundary failure into the versioned CLI error envelope.
 *
 * @param error The rejected value from a core Promise operation.
 * @returns A safe, serializable error envelope.
 */
export const toErrorEnvelope = (error: unknown): ErrorEnvelope => {
  if (error instanceof RfcDiscoveryError) {
    return {
      schemaVersion,
      kind: "error",
      error: {
        code: "discovery_failed",
        message: `Unable to retrieve live RFC metadata from ${error.url}: ${error.reason}`,
      },
    };
  }

  if (error instanceof RfcSourceCacheError) {
    return {
      schemaVersion,
      kind: "error",
      error: {
        code: "source_cache_failed",
        message: `Unable to read RFC source cache: ${error.reason}`,
      },
    };
  }

  if (error instanceof RfcSourceFetchError) {
    return {
      schemaVersion,
      kind: "error",
      error: {
        code: "source_fetch_failed",
        message: `Unable to fetch RFC source: ${error.reason}`,
      },
    };
  }

  if (error instanceof RfcSourceRevalidationError) {
    return {
      schemaVersion,
      kind: "error",
      error: {
        code: "source_revalidation_failed",
        message: `Unable to revalidate stale RFC source from ${error.url}: ${error.reason}`,
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
        message: `DecisionModel ${error.stage} failed: ${error.reason}`,
      },
    };
  }

  if (error instanceof ResearchPolicyError) {
    return {
      schemaVersion,
      kind: "error",
      error: {
        code: "policy_error",
        message: `Unknown research policy preset: ${error.policyPreset}`,
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
        message: error.reason,
      },
    };
  }

  if (error instanceof ConfigurationError) {
    return {
      schemaVersion,
      kind: "error",
      error: {
        code: "configuration_error",
        message: `Unable to load CLI configuration: ${error.reason}`,
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
  policyPreset: undefined,
  automaticAnswerActivation: undefined,
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
  const runtimeOptions: RuntimeClientOptions = options;
  const runtime = ManagedRuntime.make(clientLayer(runtimeOptions));
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

  const close = async (): Promise<void> => {
    if (closed) {
      return;
    }
    closed = true;
    await runtime.dispose();
  };

  const runModelOperation = <A>(program: Effect.Effect<A, any, any>): Promise<A> => {
    const operation = modelOperationTail.then(async () => {
      await runtime.runPromise(resetModelTrackingProgram(runtimeOptions));
      try {
        return await runtime.runPromise(program);
      } finally {
        await runtime.runPromise(resetModelTrackingProgram(runtimeOptions));
      }
    });
    modelOperationTail = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  };

  const client: RfcClient = {
    research: async (request) => {
      assertOpen();
      const decodedRequest = decodeResearchRequest(request);
      return runModelOperation(researchProgram(runtimeOptions, decodedRequest));
    },
    verifyCitation: async (request) => {
      assertOpen();
      let decodedRequest: CitationVerificationRequest;
      try {
        decodedRequest = decodeCitationVerificationRequest(request);
      } catch {
        throw new InvalidInputError({
          reason: "Citation input must use schema version 1",
        });
      }
      return runModelOperation(citationProgram(runtimeOptions, decodedRequest));
    },
    close,
    [Symbol.asyncDispose]: close,
  };

  if (runtimeOptions.automaticAnswerActivation === calibrationAnswerActivation) {
    registerCalibrationOperations(client, {
      catalogStatus: async () => {
        assertOpen();
        return runtime.runPromise(catalogStatusProgram(runtimeOptions));
      },
      catalogRefresh: async () => {
        assertOpen();
        return runtime.runPromise(catalogRefreshProgram(runtimeOptions));
      },
      prefetchSources: async (rfcs: ReadonlyArray<string>) => {
        assertOpen();
        return runtime.runPromise(prefetchSourcesProgram(runtimeOptions, rfcs));
      },
      researchLegacy: async (request) => {
        assertOpen();
        const decodedRequest = decodeLegacyResearchRequest(request);
        return runModelOperation(legacyResearchProgram(runtimeOptions, decodedRequest));
      },
    });
  }

  return client;
};
