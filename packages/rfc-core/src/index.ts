import { TypeSafeClient, TypeSafeDecisionModel } from "@effect/ai-typesafe";
import { NodeFileSystem, NodePath } from "@effect/platform-node";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  Clock,
  Context,
  Effect,
  FileSystem,
  Layer,
  ManagedRuntime,
  Option,
  Path,
  Redacted,
  Schema,
} from "effect";
import * as PlatformError from "effect/PlatformError";
import { FetchHttpClient } from "effect/unstable/http";

const catalogMaxAgeMilliseconds = 7 * 24 * 60 * 60 * 1000;
const defaultCacheDirectoryParts = [homedir(), ".cache", "rfc-evidence-engine"] as const;

/**
 * The version of the public JSON contracts exposed by the RFC evidence engine.
 */
export const schemaVersion = 1 as const;

/**
 * The default directory containing the local RFC metadata catalog.
 */
export const defaultCacheDirectory = join(...defaultCacheDirectoryParts);

/**
 * The lifecycle state of the local RFC metadata catalog.
 */
export type CatalogState = "missing" | "stale" | "fresh";

/**
 * Schema for catalog lifecycle states at the untrusted JSON boundary.
 */
export const CatalogStateSchema = Schema.Literals(["missing", "stale", "fresh"]);

/**
 * Schema for the public catalog status response.
 */
export const CatalogStatusSchema = Schema.Struct({
  schemaVersion: Schema.Literal(schemaVersion),
  kind: Schema.Literal("catalog_status"),
  state: CatalogStateSchema,
  catalogPath: Schema.String,
  refreshedAt: Schema.NullOr(Schema.String),
  ageMs: Schema.NullOr(Schema.Number),
});

/**
 * A decoded catalog status response.
 */
export interface CatalogStatus {
  readonly schemaVersion: typeof schemaVersion;
  readonly kind: "catalog_status";
  readonly state: CatalogState;
  readonly catalogPath: string;
  readonly refreshedAt: string | null;
  readonly ageMs: number | null;
}

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
}

/**
 * Signals that a catalog could not be inspected.
 */
export class CatalogReadError extends Schema.TaggedError<CatalogReadError>()("CatalogReadError", {
  catalogPath: Schema.String,
  reason: Schema.String,
}) {}

/**
 * Signals that a client method was called after the client was closed.
 */
export class RfcClientClosedError extends Schema.TaggedError<RfcClientClosedError>()(
  "RfcClientClosedError",
  {},
) {}

/**
 * Signals that a later research operation is not available in the bootstrap slice.
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
 * The operational errors currently exposed by the Promise facade.
 */
export type RfcCoreError =
  | CatalogReadError
  | RfcClientClosedError
  | ResearchUnavailableError
  | InvalidInputError
  | ConfigurationError;

/**
 * Stable machine-readable error codes emitted by the CLI boundary.
 */
export type ErrorCode =
  | "catalog_read_failed"
  | "client_closed"
  | "research_unavailable"
  | "invalid_input"
  | "configuration_error"
  | "internal_error";

const ErrorCodeSchema = Schema.Literals([
  "catalog_read_failed",
  "client_closed",
  "research_unavailable",
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
   * Reserve the research operation for the next implementation slice.
   */
  readonly research: (request: ResearchRequest) => Promise<never>;
  /**
   * Release the managed runtime and any resources it owns.
   */
  readonly close: () => Promise<void>;
  /**
   * Release the managed runtime through JavaScript's async-disposal protocol.
   */
  readonly [Symbol.asyncDispose]: () => Promise<void>;
}

type CatalogStoreService = {
  readonly status: (
    catalogPath: string,
  ) => Effect.Effect<CatalogStatus, CatalogReadError, FileSystem.FileSystem>;
};

class CatalogStore extends Context.Service<CatalogStore, CatalogStoreService>()(
  "rfc-core/CatalogStore",
) {}

const isNotFound = (error: PlatformError.PlatformError): boolean =>
  error.reason._tag === "NotFound";

const catalogStatus = Effect.fnUntraced(function* (catalogPath: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const fileInfo = yield* fileSystem.stat(catalogPath).pipe(
    Effect.catchTag("PlatformError", (error) => {
      if (isNotFound(error)) {
        return Effect.succeed(undefined);
      }

      return Effect.fail(
        new CatalogReadError({
          catalogPath,
          reason: error.message,
        }),
      );
    }),
  );

  if (fileInfo === undefined) {
    return Schema.decodeUnknownSync(CatalogStatusSchema)({
      schemaVersion,
      kind: "catalog_status",
      state: "missing",
      catalogPath,
      refreshedAt: null,
      ageMs: null,
    });
  }

  const modifiedAt = Option.getOrUndefined(fileInfo.mtime);
  if (modifiedAt === undefined) {
    return yield* Effect.fail(
      new CatalogReadError({
        catalogPath,
        reason: "The catalog filesystem did not provide a modification time",
      }),
    );
  }

  const now = yield* Clock.currentTimeMillis;
  const ageMs = Math.max(0, now - modifiedAt.getTime());
  const state: CatalogState = ageMs <= catalogMaxAgeMilliseconds ? "fresh" : "stale";

  return Schema.decodeUnknownSync(CatalogStatusSchema)({
    schemaVersion,
    kind: "catalog_status",
    state,
    catalogPath,
    refreshedAt: modifiedAt.toISOString(),
    ageMs,
  });
});

const catalogStoreLayer = Layer.succeed(
  CatalogStore,
  CatalogStore.of({
    status: catalogStatus,
  }),
);

const typeSafeDecisionModelLayer = (options: RfcClientOptions) =>
  TypeSafeDecisionModel.layer({ model: options.modelAlias ?? "jev-latest" }).pipe(
    Layer.provide(
      TypeSafeClient.layer({
        apiKey:
          options.typeSafeApiKey === undefined ? undefined : Redacted.make(options.typeSafeApiKey),
        apiUrl: options.typeSafeApiUrl,
      }),
    ),
    Layer.provide(FetchHttpClient.layer),
  );

const clientLayer = (options: RfcClientOptions) =>
  Layer.merge(catalogStoreLayer, typeSafeDecisionModelLayer(options)).pipe(
    Layer.provideMerge(Layer.mergeAll(NodeFileSystem.layer, NodePath.layer, FetchHttpClient.layer)),
  );

const resolveCatalogPath = Effect.fnUntraced(function* (options: RfcClientOptions) {
  const path = yield* Path.Path;
  const cacheDirectory = options.cacheDirectory ?? path.join(...defaultCacheDirectoryParts);
  return options.catalogPath ?? path.join(cacheDirectory, "catalog.json");
});

const statusProgram = (options: RfcClientOptions) =>
  Effect.gen(function* () {
    const store = yield* CatalogStore;
    const catalogPath = yield* resolveCatalogPath(options);
    return yield* store.status(catalogPath);
  });

const researchProgram = Effect.fnUntraced(function* (_request: ResearchRequest) {
  return yield* new ResearchUnavailableError({});
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
        message: "Research is not available in this bootstrap release",
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
  modelAlias: undefined,
  typeSafeApiKey: undefined,
  typeSafeApiUrl: undefined,
};

/**
 * Construct a Promise-based RFC evidence client backed by one managed Effect runtime.
 *
 * @param options Cache, catalog, and provider options used by the client.
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
      return runtime.runPromise(statusProgram(options));
    },
    research: async (request) => {
      assertOpen();
      return runtime.runPromise(researchProgram(request));
    },
    close,
    [Symbol.asyncDispose]: close,
  };
};
