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
import {
  CatalogReadError,
  CatalogRefreshError,
  CatalogStore,
  CatalogStaleError,
  CatalogWriteError,
  DatatrackerCatalogSource,
  catalogRefreshResultFromValue,
  catalogStoreLayer,
  defaultDatatrackerApiUrl,
  makeCatalog,
  makeCatalogSourceLayer,
  makeDefaultCatalogSourceLayer,
} from "./catalog";
import type { CatalogRefreshResult, CatalogSource, CatalogStatus } from "./catalog";
import {
  DecisionModelError,
  ResearchPolicyError,
  ResolvedModelName,
  RfcNotFoundError,
  researchKnownRfc,
} from "./research";
import type { EvidenceBundle } from "./research";
import {
  RfcSourceCacheError,
  RfcSourceFetchError,
  defaultRfcEditorBaseUrl,
  makeDefaultRfcSourceLayer,
  makeRfcSourceHttpLayer,
  makeRfcSourceLayer,
  rfcSourceStoreLayer,
} from "./source";
import type { RfcSourceFetcher } from "./source";

export * from "./catalog";
export * from "./research";
export * from "./source";

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
export const schemaVersion = 1 as const;

/**
 * The default directory containing the local RFC metadata catalog.
 */
export const defaultCacheDirectory = join(defaultCacheDirectoryRoot, "rfc-evidence-engine");

/**
 * The lifecycle state of the local RFC metadata catalog.
 */
export type CatalogState = CatalogStatus["state"];

/**
 * Options for constructing an RFC evidence client.
 */
export interface RfcClientOptions {
  /**
   * Directory containing the versioned metadata catalog.
   */
  readonly cacheDirectory: string | undefined;
  /**
   * Explicit catalog path, which takes precedence over `cacheDirectory`.
   */
  readonly catalogPath: string | undefined;
  /**
   * Datatracker API base URL used to refresh the catalog.
   */
  readonly datatrackerApiUrl?: string | undefined;
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
   * Optional normalized source used by deterministic tests instead of Datatracker.
   */
  readonly catalogSource?: CatalogSource | undefined;
  /**
   * Optional HTTP service used by deterministic catalog-source tests.
   */
  readonly catalogHttpClient?: HttpClient.HttpClient | undefined;
  /**
   * Optional fetch implementation used by deterministic redirect tests.
   */
  readonly catalogFetch?: typeof globalThis.fetch | undefined;
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
 * Signals that the CLI configuration could not be read after Varlock activation.
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
  | CatalogReadError
  | CatalogRefreshError
  | CatalogStaleError
  | CatalogWriteError
  | RfcSourceCacheError
  | RfcSourceFetchError
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
  | "catalog_read_failed"
  | "catalog_refresh_failed"
  | "catalog_stale"
  | "catalog_write_failed"
  | "source_cache_failed"
  | "source_fetch_failed"
  | "client_closed"
  | "research_unavailable"
  | "rfc_not_found"
  | "decision_model_failed"
  | "policy_error"
  | "invalid_input"
  | "configuration_error"
  | "internal_error";

const ErrorCodeSchema = Schema.Literals([
  "catalog_read_failed",
  "catalog_refresh_failed",
  "catalog_stale",
  "catalog_write_failed",
  "source_cache_failed",
  "source_fetch_failed",
  "client_closed",
  "research_unavailable",
  "rfc_not_found",
  "decision_model_failed",
  "policy_error",
  "invalid_input",
  "configuration_error",
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

/**
 * Schema for the versioned research request accepted by the CLI.
 */
export const ResearchRequestSchema = Schema.Struct({
  schemaVersion: Schema.Literal(schemaVersion),
  question: Schema.NonEmptyString,
  rfc: Schema.NullOr(Schema.String),
});

/**
 * A decoded research request accepted by the future research operation.
 */
export interface ResearchRequest {
  readonly schemaVersion: typeof schemaVersion;
  readonly question: string;
  readonly rfc: string | null;
}

/**
 * Decode unknown research input at the public JSON boundary.
 *
 * @param input The unknown value received from JSON or convenience flags.
 * @returns A validated version-one research request.
 * @throws InvalidInputError when the value does not satisfy the request schema.
 */
export const decodeResearchRequest = (input: unknown): ResearchRequest => {
  try {
    return Schema.decodeUnknownSync(ResearchRequestSchema)(input);
  } catch {
    throw new InvalidInputError({ reason: "Research input must use schema version 1" });
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
   * Return freshness information for the local metadata catalog.
   */
  readonly catalogStatus: () => Promise<CatalogStatus>;
  /**
   * Fetch, normalize, and atomically replace the local metadata catalog.
   */
  readonly catalogRefresh: () => Promise<CatalogRefreshResult>;
  /**
   * Research one known published RFC and return exact evidence.
   */
  readonly research: (request: ResearchRequest) => Promise<EvidenceBundle>;
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
      const resolvedModel = yield* Ref.make(options.modelAlias ?? "jev-latest");
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
            .pipe(Effect.tap((response) => Ref.set(resolvedModel, response.model))),
      };
      return Context.make(TypeSafeClientApi.TypeSafeClient, observedClient).pipe(
        Context.add(ResolvedModelName, resolvedModel),
      );
    }),
  ).pipe(
    Layer.provide(
      options.typeSafeHttpClient === undefined
        ? FetchHttpClient.layer
        : Layer.succeed(HttpClient.HttpClient, options.typeSafeHttpClient),
    ),
  );

  return TypeSafeDecisionModel.model(options.modelAlias ?? "jev-latest").pipe(
    Layer.provideMerge(observedClientLayer),
  );
};

const decisionModelLayer = (options: RfcClientOptions) =>
  options.decisionModel === undefined
    ? typeSafeDecisionModelLayer(options)
    : Layer.merge(
        Layer.succeed(DecisionModel.DecisionModel, options.decisionModel),
        Layer.succeed(ResolvedModelName, Ref.makeUnsafe(options.modelAlias ?? "jev-latest")),
      );

const platformLayer = (options: RfcClientOptions) => {
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

const clientLayer = (options: RfcClientOptions) => {
  const catalogSourceLayer =
    options.catalogSource === undefined
      ? makeDefaultCatalogSourceLayer(options.datatrackerApiUrl ?? defaultDatatrackerApiUrl)
      : makeCatalogSourceLayer(options.catalogSource);
  const rfcSourceLayer =
    options.rfcSourceFetcher !== undefined
      ? makeRfcSourceLayer(options.rfcSourceFetcher)
      : options.rfcSourceHttpClient === undefined
        ? makeDefaultRfcSourceLayer(defaultRfcEditorBaseUrl)
        : makeRfcSourceHttpLayer(options.rfcSourceHttpClient, defaultRfcEditorBaseUrl);
  const services = Layer.mergeAll(
    catalogStoreLayer,
    rfcSourceStoreLayer,
    catalogSourceLayer,
    rfcSourceLayer,
  ).pipe(Layer.provideMerge(platformLayer(options)));

  return Layer.merge(services, decisionModelLayer(options)).pipe(
    Layer.provideMerge(platformLayer(options)),
  );
};

const resolveCatalogPath = Effect.fnUntraced(function* (options: RfcClientOptions) {
  const path = yield* Path.Path;
  const cacheDirectory = options.cacheDirectory ?? defaultCacheDirectory;
  return options.catalogPath ?? path.join(cacheDirectory, "catalog.json");
});

const resolveSourceDirectory = Effect.fnUntraced(function* (options: RfcClientOptions) {
  const path = yield* Path.Path;
  const cacheDirectory = options.cacheDirectory ?? defaultCacheDirectory;
  return options.sourceDirectory ?? path.join(cacheDirectory, "sources");
});

const catalogStatusProgram = (options: RfcClientOptions) =>
  Effect.gen(function* () {
    const store = yield* CatalogStore;
    const catalogPath = yield* resolveCatalogPath(options);
    return yield* store.status(catalogPath);
  });

const catalogRefreshProgram = (options: RfcClientOptions) =>
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

const researchProgram = (options: RfcClientOptions, request: ResearchRequest) =>
  Effect.gen(function* () {
    const store = yield* CatalogStore;
    const startedAt = yield* Clock.currentTimeMillis;
    const catalogPath = yield* resolveCatalogPath(options);
    const initialStatus = yield* store.status(catalogPath);
    if (request.rfc === null) {
      if (initialStatus.state === "stale") {
        return yield* new CatalogStaleError({
          catalogPath,
          fetchedAt: initialStatus.refreshedAt ?? "",
          ageMs: initialStatus.ageMs ?? Number.POSITIVE_INFINITY,
        });
      }
      return yield* new ResearchUnavailableError({});
    }

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

    return yield* researchKnownRfc(request.question, request.rfc, {
      catalog,
      catalogStatus,
      sourceDirectory,
      policyPreset: options.policyPreset ?? "precision-v1",
      modelAlias: options.modelAlias ?? "jev-latest",
      catalogMs: Math.max(0, finishedAt - startedAt),
      startedAt,
    });
  });

/**
 * Convert an unknown boundary failure into the versioned CLI error envelope.
 *
 * @param error The rejected value from a core Promise operation.
 * @returns A safe, serializable error envelope.
 */
export const toErrorEnvelope = (error: unknown): ErrorEnvelope => {
  if (error instanceof CatalogReadError) {
    return {
      schemaVersion,
      kind: "error",
      error: {
        code: "catalog_read_failed",
        message: `Unable to inspect catalog: ${error.reason}`,
      },
    };
  }

  if (error instanceof CatalogRefreshError) {
    return {
      schemaVersion,
      kind: "error",
      error: {
        code: "catalog_refresh_failed",
        message: `Unable to refresh catalog: ${error.reason}`,
      },
    };
  }

  if (error instanceof CatalogStaleError) {
    return {
      schemaVersion,
      kind: "error",
      error: {
        code: "catalog_stale",
        message: "The RFC catalog is stale and must be refreshed before research",
      },
    };
  }

  if (error instanceof CatalogWriteError) {
    return {
      schemaVersion,
      kind: "error",
      error: {
        code: "catalog_write_failed",
        message: `Unable to write catalog: ${error.reason}`,
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

  if (error instanceof RfcNotFoundError) {
    return {
      schemaVersion,
      kind: "error",
      error: {
        code: "rfc_not_found",
        message: `RFC ${error.rfc} is not an exact published catalog entry`,
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
  catalogPath: undefined,
  datatrackerApiUrl: undefined,
  modelAlias: undefined,
  typeSafeApiKey: undefined,
  typeSafeApiUrl: undefined,
  typeSafeHttpClient: undefined,
  now: undefined,
  catalogSource: undefined,
  catalogHttpClient: undefined,
  catalogFetch: undefined,
  rfcSourceFetcher: undefined,
  rfcSourceHttpClient: undefined,
  sourceDirectory: undefined,
  policyPreset: undefined,
  decisionModel: undefined,
};

/**
 * Construct a Promise-based RFC evidence client backed by one managed Effect runtime.
 *
 * @param options Cache, catalog, clock, and provider options used by the client.
 * @returns A Promise for a client with explicit close and async-disposal methods.
 */
export const createRfcClient = async (
  options: RfcClientOptions = defaultClientOptions,
): Promise<RfcClient> => {
  const runtime = ManagedRuntime.make(clientLayer(options));
  let closed = false;

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

  return {
    catalogStatus: async () => {
      assertOpen();
      return runtime.runPromise(catalogStatusProgram(options));
    },
    catalogRefresh: async () => {
      assertOpen();
      return runtime.runPromise(catalogRefreshProgram(options));
    },
    research: async (request) => {
      assertOpen();
      const decodedRequest = decodeResearchRequest(request);
      return runtime.runPromise(researchProgram(options, decodedRequest));
    },
    close,
    [Symbol.asyncDispose]: close,
  };
};
