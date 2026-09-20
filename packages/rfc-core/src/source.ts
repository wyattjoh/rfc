import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { Clock, Context, Effect, FileSystem, Layer, Option, Schema } from "effect";
import * as PlatformError from "effect/PlatformError";
import { Headers, HttpClient, HttpClientResponse } from "effect/unstable/http";
import type { CatalogDocument } from "./catalog";

/**
 * The version of the RFC source cache format.
 */
export const rfcSourceCacheVersion = 1 as const;

/**
 * The default RFC Editor plain-text base URL.
 */
export const defaultRfcEditorBaseUrl = "https://www.rfc-editor.org/rfc/";

/**
 * The directory below the user cache that stores RFC source entries.
 */
export const rfcSourceCacheDirectoryName = "sources";

/**
 * A source fetched from the authoritative RFC Editor plain-text endpoint.
 */
export const RfcSourceSchema = Schema.Struct({
  identifier: Schema.NonEmptyString,
  rfcNumber: Schema.Natural,
  sourceUrl: Schema.NonEmptyString,
  text: Schema.String,
  contentHash: Schema.NonEmptyString,
  fetchedAt: Schema.String,
});

/**
 * A decoded authoritative RFC source.
 */
export type RfcSource = Schema.Schema.Type<typeof RfcSourceSchema>;

const RfcSourceCacheIndexSchema = Schema.Struct({
  schemaVersion: Schema.Literal(rfcSourceCacheVersion),
  kind: Schema.Literal("rfc_source_index"),
  identifier: Schema.NonEmptyString,
  rfcNumber: Schema.Natural,
  sourceUrl: Schema.NonEmptyString,
  contentHash: Schema.NonEmptyString,
  fetchedAt: Schema.String,
});

type RfcSourceCacheIndex = Schema.Schema.Type<typeof RfcSourceCacheIndexSchema>;

const RfcSourceCacheContentSchema = Schema.Struct({
  schemaVersion: Schema.Literal(rfcSourceCacheVersion),
  kind: Schema.Literal("rfc_source_content"),
  contentHash: Schema.NonEmptyString,
  text: Schema.String,
});

type RfcSourceCacheContent = Schema.Schema.Type<typeof RfcSourceCacheContentSchema>;

/**
 * Failure while fetching authoritative RFC text.
 */
export class RfcSourceFetchError extends Schema.TaggedError<RfcSourceFetchError>()(
  "RfcSourceFetchError",
  {
    stage: Schema.Literals(["request", "decode"]),
    url: Schema.String,
    reason: Schema.String,
    /**
     * RFC Editor response status, when one was received.
     */
    status: Schema.optionalKey(Schema.Number),
  },
) {}

/**
 * Failure while reading, validating, or writing an RFC source cache entry.
 */
export class RfcSourceCacheError extends Schema.TaggedError<RfcSourceCacheError>()(
  "RfcSourceCacheError",
  {
    stage: Schema.Literals(["read", "decode", "write"]),
    sourcePath: Schema.String,
    reason: Schema.String,
  },
) {}

/**
 * A plain-text source payload supplied by a deterministic test or embedded caller.
 */
export interface RfcSourcePayload {
  /**
   * The authoritative source URL represented by the payload.
   */
  readonly sourceUrl: string | undefined;
  /**
   * The exact RFC Editor plain-text body.
   */
  readonly text: string;
}

/**
 * A Promise-returning source replacement used by deterministic tests.
 */
export type RfcSourceFetcher = (document: CatalogDocument) => Promise<RfcSourcePayload | string>;

/**
 * The source service used by known-RFC research.
 */
export interface RfcSourceService {
  readonly fetch: (
    document: CatalogDocument,
  ) => Effect.Effect<RfcSourcePayload, RfcSourceFetchError>;
}

/**
 * Effect service tag for authoritative RFC source retrieval.
 */
export class RfcSourceServiceTag extends Context.Service<RfcSourceServiceTag, RfcSourceService>()(
  "rfc-core/RfcSourceService",
) {}

/**
 * The local source cache service.
 */
export interface RfcSourceStoreService {
  readonly read: (
    sourceDirectory: string,
    identifier: string,
  ) => Effect.Effect<RfcSource | undefined, RfcSourceCacheError, FileSystem.FileSystem>;
  readonly write: (
    sourceDirectory: string,
    source: RfcSource,
  ) => Effect.Effect<void, RfcSourceCacheError, FileSystem.FileSystem>;
}

/**
 * Effect service tag for the content-addressed RFC source cache.
 */
export class RfcSourceStore extends Context.Service<RfcSourceStore, RfcSourceStoreService>()(
  "rfc-core/RfcSourceStore",
) {}

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : "The upstream operation failed";

const isNotFound = (error: PlatformError.PlatformError): boolean =>
  error.reason._tag === "NotFound";

const sourceIdentifier = (document: CatalogDocument): string => document.identifier;

/**
 * Calculate the stable SHA-256 identity for an RFC source body.
 *
 * @param text Exact source text encoded as UTF-8.
 * @returns A lowercase hexadecimal SHA-256 digest.
 */
export const hashRfcSource = (text: string): string =>
  createHash("sha256").update(text, "utf8").digest("hex");

/**
 * Build the authoritative RFC Editor plain-text URL for a published RFC.
 *
 * @param baseUrl RFC Editor base URL.
 * @param rfcNumber Published RFC number.
 * @returns The plain-text source URL derived from the configured base URL.
 * @throws Error when the configured base URL is invalid.
 */
export const makeRfcSourceUrl = (baseUrl: string, rfcNumber: number): string => {
  const base = new URL(baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);
  return new URL(`rfc${rfcNumber}.txt`, base).toString();
};

const decodeSource = (value: unknown, sourcePath: string): RfcSource => {
  try {
    const source = Schema.decodeUnknownSync(RfcSourceSchema)(value);
    if (
      source.rfcNumber <= 0 ||
      source.text.length === 0 ||
      !Number.isFinite(Date.parse(source.fetchedAt))
    ) {
      throw new Error("RFC source metadata is invalid");
    }
    if (hashRfcSource(source.text) !== source.contentHash) {
      throw new Error("RFC source content hash does not match its text");
    }
    return source;
  } catch {
    throw new RfcSourceCacheError({
      stage: "decode",
      sourcePath,
      reason: "The RFC source cache entry is malformed or has a mismatched content hash",
    });
  }
};

const decodeIndex = (value: unknown, sourcePath: string): RfcSourceCacheIndex => {
  try {
    const index = Schema.decodeUnknownSync(RfcSourceCacheIndexSchema)(value);
    if (
      index.rfcNumber <= 0 ||
      !Number.isFinite(Date.parse(index.fetchedAt)) ||
      !/^[a-f0-9]{64}$/.test(index.contentHash)
    ) {
      throw new Error("RFC source cache index metadata is invalid");
    }
    return index;
  } catch {
    throw new RfcSourceCacheError({
      stage: "decode",
      sourcePath,
      reason: "The RFC source cache index is malformed",
    });
  }
};

const decodeContent = (value: unknown, sourcePath: string): RfcSourceCacheContent => {
  try {
    return Schema.decodeUnknownSync(RfcSourceCacheContentSchema)(value);
  } catch {
    throw new RfcSourceCacheError({
      stage: "decode",
      sourcePath,
      reason: "The RFC source cache content is malformed",
    });
  }
};

const sourceIndexPath = (sourceDirectory: string, identifier: string): string =>
  join(sourceDirectory, `${identifier}.json`);

const sourceContentPath = (sourceDirectory: string, contentHash: string): string =>
  join(sourceDirectory, `${contentHash}.json`);

const readString = Effect.fnUntraced(function* (
  path: string,
): Effect.fn.Return<string | undefined, RfcSourceCacheError, FileSystem.FileSystem> {
  const fileSystem = yield* FileSystem.FileSystem;
  return yield* fileSystem.readFileString(path).pipe(
    Effect.catchTag("PlatformError", (error) => {
      if (isNotFound(error)) {
        return Effect.succeed(undefined);
      }
      return Effect.fail(
        new RfcSourceCacheError({
          stage: "read",
          sourcePath: path,
          reason: error.message,
        }),
      );
    }),
  );
});

const parseJson = (contents: string, sourcePath: string): unknown => {
  try {
    return JSON.parse(contents) as unknown;
  } catch {
    throw new RfcSourceCacheError({
      stage: "decode",
      sourcePath,
      reason: "The RFC source cache entry is not valid JSON",
    });
  }
};

const readSource = Effect.fnUntraced(function* (
  sourceDirectory: string,
  identifier: string,
): Effect.fn.Return<RfcSource | undefined, RfcSourceCacheError, FileSystem.FileSystem> {
  const indexPath = sourceIndexPath(sourceDirectory, identifier);
  const indexContents = yield* readString(indexPath);
  if (indexContents === undefined) {
    return undefined;
  }

  const index = yield* Effect.try({
    try: () => decodeIndex(parseJson(indexContents, indexPath), indexPath),
    catch: (error) =>
      error instanceof RfcSourceCacheError
        ? error
        : new RfcSourceCacheError({
            stage: "decode",
            sourcePath: indexPath,
            reason: errorMessage(error),
          }),
  });
  if (index.identifier !== identifier) {
    return yield* new RfcSourceCacheError({
      stage: "decode",
      sourcePath: indexPath,
      reason: "The RFC source cache index identifier does not match its path",
    });
  }
  const contentPath = sourceContentPath(sourceDirectory, index.contentHash);
  const contentContents = yield* readString(contentPath);
  if (contentContents === undefined) {
    return yield* new RfcSourceCacheError({
      stage: "read",
      sourcePath: contentPath,
      reason: "The RFC source content referenced by the cache index is missing",
    });
  }

  const content = yield* Effect.try({
    try: () => decodeContent(parseJson(contentContents, contentPath), contentPath),
    catch: (error) =>
      error instanceof RfcSourceCacheError
        ? error
        : new RfcSourceCacheError({
            stage: "decode",
            sourcePath: contentPath,
            reason: errorMessage(error),
          }),
  });
  if (
    content.text.length === 0 ||
    content.contentHash !== index.contentHash ||
    hashRfcSource(content.text) !== index.contentHash
  ) {
    return yield* new RfcSourceCacheError({
      stage: "decode",
      sourcePath: contentPath,
      reason: "The RFC source content does not match its cache index",
    });
  }

  return {
    identifier: index.identifier,
    rfcNumber: index.rfcNumber,
    sourceUrl: index.sourceUrl,
    text: content.text,
    contentHash: index.contentHash,
    fetchedAt: index.fetchedAt,
  };
});

const writeFileAtomically = Effect.fnUntraced(function* (
  fileSystem: FileSystem.FileSystem,
  path: string,
  contents: string,
): Effect.fn.Return<void, PlatformError.PlatformError> {
  const temporaryPath = `${path}.tmp-${crypto.randomUUID()}`;
  const cleanup = fileSystem
    .remove(temporaryPath, { force: true })
    .pipe(Effect.catch(() => Effect.void));
  return yield* Effect.gen(function* () {
    yield* fileSystem.writeFileString(temporaryPath, contents);
    yield* fileSystem.rename(temporaryPath, path);
  }).pipe(Effect.ensuring(cleanup));
});

const writeSource = Effect.fnUntraced(function* (
  sourceDirectory: string,
  source: RfcSource,
): Effect.fn.Return<void, RfcSourceCacheError, FileSystem.FileSystem> {
  const fileSystem = yield* FileSystem.FileSystem;
  const contentPath = sourceContentPath(sourceDirectory, source.contentHash);
  const indexPath = sourceIndexPath(sourceDirectory, source.identifier);
  const content = {
    schemaVersion: rfcSourceCacheVersion,
    kind: "rfc_source_content" as const,
    contentHash: source.contentHash,
    text: source.text,
  } satisfies RfcSourceCacheContent;
  const index = {
    schemaVersion: rfcSourceCacheVersion,
    kind: "rfc_source_index" as const,
    identifier: source.identifier,
    rfcNumber: source.rfcNumber,
    sourceUrl: source.sourceUrl,
    contentHash: source.contentHash,
    fetchedAt: source.fetchedAt,
  } satisfies RfcSourceCacheIndex;

  return yield* Effect.gen(function* () {
    yield* Effect.try({
      try: () => {
        decodeSource(source, indexPath);
      },
      catch: (error) =>
        error instanceof RfcSourceCacheError
          ? error
          : new RfcSourceCacheError({
              stage: "decode",
              sourcePath: indexPath,
              reason: errorMessage(error),
            }),
    });
    yield* fileSystem.makeDirectory(dirname(contentPath), { recursive: true });
    yield* writeFileAtomically(fileSystem, contentPath, `${JSON.stringify(content, null, 2)}\n`);
    yield* writeFileAtomically(fileSystem, indexPath, `${JSON.stringify(index, null, 2)}\n`);
  }).pipe(
    Effect.mapError((error) =>
      error instanceof RfcSourceCacheError
        ? error
        : new RfcSourceCacheError({
            stage: "write",
            sourcePath: indexPath,
            reason: errorMessage(error),
          }),
    ),
  );
});

/**
 * The default RFC source cache layer backed by the Effect filesystem.
 */
export const rfcSourceStoreLayer: Layer.Layer<RfcSourceStore> = Layer.succeed(
  RfcSourceStore,
  RfcSourceStore.of({
    read: readSource,
    write: writeSource,
  }),
);

/**
 * Create a source layer backed by a deterministic Promise-returning fetcher.
 *
 * @param fetcher Source fetcher used instead of the RFC Editor HTTP endpoint.
 * @returns A source layer suitable for tests and embedded callers.
 */
export const makeRfcSourceLayer = (fetcher: RfcSourceFetcher): Layer.Layer<RfcSourceServiceTag> =>
  Layer.succeed(
    RfcSourceServiceTag,
    RfcSourceServiceTag.of({
      fetch: (document) =>
        Effect.tryPromise({
          try: async () => {
            const result = await fetcher(document);
            return typeof result === "string" ? { sourceUrl: undefined, text: result } : result;
          },
          catch: (error) =>
            new RfcSourceFetchError({
              stage: "request",
              url: makeRfcSourceUrl(defaultRfcEditorBaseUrl, document.rfcNumber),
              reason: errorMessage(error),
            }),
        }),
    }),
  );

const fetchFromRfcEditor = Effect.fnUntraced(function* (
  http: HttpClient.HttpClient,
  baseUrl: string,
  document: CatalogDocument,
  requireRfcEditorOrigin: boolean,
): Effect.fn.Return<RfcSourcePayload, RfcSourceFetchError> {
  const url = yield* Effect.try({
    try: () => makeRfcSourceUrl(baseUrl, document.rfcNumber),
    catch: (error) =>
      new RfcSourceFetchError({ stage: "request", url: baseUrl, reason: errorMessage(error) }),
  });
  const expectedUrl = makeRfcSourceUrl(defaultRfcEditorBaseUrl, document.rfcNumber);
  if (requireRfcEditorOrigin && url !== expectedUrl) {
    return yield* new RfcSourceFetchError({
      stage: "request",
      url,
      reason: "RFC source retrieval must use the canonical RFC Editor URL",
    });
  }
  const response = yield* http
    .get(url)
    .pipe(
      Effect.mapError(
        (error) => new RfcSourceFetchError({ stage: "request", url, reason: errorMessage(error) }),
      ),
    );
  const responseUrl = yield* Effect.try({
    try: () => new URL(response.url || url),
    catch: (error) =>
      new RfcSourceFetchError({ stage: "request", url, reason: errorMessage(error) }),
  });
  const configuredUrl = yield* Effect.try({
    try: () => new URL(url),
    catch: (error) =>
      new RfcSourceFetchError({ stage: "request", url, reason: errorMessage(error) }),
  });
  if (requireRfcEditorOrigin && configuredUrl.origin !== new URL(defaultRfcEditorBaseUrl).origin) {
    return yield* new RfcSourceFetchError({
      stage: "request",
      url,
      reason: "RFC source retrieval must use the RFC Editor origin",
    });
  }
  if (
    responseUrl.origin !== configuredUrl.origin ||
    responseUrl.toString() !== configuredUrl.toString()
  ) {
    return yield* new RfcSourceFetchError({
      stage: "request",
      url: response.url || url,
      reason: "RFC Editor redirected away from the exact source URL",
    });
  }

  const successfulResponse = yield* HttpClientResponse.filterStatusOk(response).pipe(
    Effect.mapError(
      (error) => new RfcSourceFetchError({ stage: "request", url, reason: errorMessage(error) }),
    ),
  );
  const contentType = Option.getOrUndefined(
    Headers.get("content-type")(successfulResponse.headers),
  );
  if (contentType !== undefined && !contentType.toLowerCase().startsWith("text/plain")) {
    return yield* new RfcSourceFetchError({
      stage: "decode",
      url,
      reason: "RFC Editor returned a non-plain-text source",
    });
  }
  const text = yield* successfulResponse.text.pipe(
    Effect.mapError(
      (error) => new RfcSourceFetchError({ stage: "decode", url, reason: errorMessage(error) }),
    ),
  );
  if (text.length === 0) {
    return yield* new RfcSourceFetchError({
      stage: "decode",
      url,
      reason: "RFC Editor returned an empty source",
    });
  }

  return { sourceUrl: url, text };
});

/**
 * Create a source layer backed by a supplied Effect HTTP client.
 *
 * @param http HTTP client used to retrieve RFC Editor text.
 * @param baseUrl RFC Editor base URL.
 * @returns A source layer with no additional environment requirements.
 */
export const makeRfcSourceHttpLayer = (
  http: HttpClient.HttpClient,
  baseUrl: string,
): Layer.Layer<RfcSourceServiceTag> =>
  Layer.succeed(
    RfcSourceServiceTag,
    RfcSourceServiceTag.of({
      fetch: (document) => fetchFromRfcEditor(http, baseUrl, document, true),
    }),
  );

/**
 * Build the default source layer backed by RFC Editor plain text over Effect HTTP.
 *
 * @param baseUrl RFC Editor base URL.
 * @returns A source layer requiring an Effect HTTP client.
 */
export const makeDefaultRfcSourceLayer = (
  baseUrl: string,
): Layer.Layer<RfcSourceServiceTag, never, HttpClient.HttpClient> =>
  Layer.effect(
    RfcSourceServiceTag,
    Effect.gen(function* () {
      const http = yield* HttpClient.HttpClient;
      return RfcSourceServiceTag.of({
        fetch: (document) => fetchFromRfcEditor(http, baseUrl, document, true),
      });
    }),
  );

/**
 * Assemble a validated source object from a catalog document and fetched body.
 *
 * @param document Published RFC metadata.
 * @param payload Fetched authoritative text and optional source URL.
 * @param fetchedAt Fetch timestamp in milliseconds.
 * @param defaultSourceUrl URL to use when the payload does not provide one.
 * @returns A schema-valid, content-addressed source.
 */
export const makeRfcSource = (
  document: CatalogDocument,
  payload: RfcSourcePayload,
  fetchedAt: number,
  defaultSourceUrl: string,
): RfcSource => {
  const source = {
    identifier: sourceIdentifier(document),
    rfcNumber: document.rfcNumber,
    sourceUrl: payload.sourceUrl ?? defaultSourceUrl,
    text: payload.text,
    contentHash: hashRfcSource(payload.text),
    fetchedAt: new Date(fetchedAt).toISOString(),
  };
  return Schema.decodeUnknownSync(RfcSourceSchema)(source);
};

/**
 * Read an RFC source from the content-addressed cache or the authoritative
 * RFC Editor service, validating its identity before returning it.
 *
 * @param document Published RFC metadata to resolve.
 * @param sourceDirectory Directory containing content-addressed source entries.
 * @returns The exact, validated RFC source.
 * @throws RfcSourceCacheError or RfcSourceFetchError when the source is unavailable or invalid.
 */
export const loadRfcSource = Effect.fnUntraced(function* (
  document: CatalogDocument,
  sourceDirectory: string,
): Effect.fn.Return<
  RfcSource,
  RfcSourceCacheError | RfcSourceFetchError,
  FileSystem.FileSystem | RfcSourceStore | RfcSourceServiceTag
> {
  const store = yield* RfcSourceStore;
  const expectedSourceUrl = makeRfcSourceUrl(defaultRfcEditorBaseUrl, document.rfcNumber);
  const cached = yield* store.read(sourceDirectory, document.identifier);
  if (cached !== undefined) {
    if (cached.identifier !== document.identifier || cached.rfcNumber !== document.rfcNumber) {
      return yield* new RfcSourceCacheError({
        stage: "decode",
        sourcePath: sourceDirectory,
        reason: "The RFC source cache entry does not match the requested published RFC",
      });
    }
    if (cached.sourceUrl !== expectedSourceUrl) {
      return yield* new RfcSourceCacheError({
        stage: "decode",
        sourcePath: sourceDirectory,
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
  yield* store.write(sourceDirectory, source);
  return source;
});

/**
 * Return the source directory below a configured cache directory.
 *
 * @param cacheDirectory User cache directory.
 * @returns Content-addressed source cache directory.
 */
export const sourceDirectoryForCache = (cacheDirectory: string): string =>
  join(cacheDirectory, rfcSourceCacheDirectoryName);

/**
 * Read an RFC source through the default store service.
 *
 * @param sourceDirectory Source cache directory.
 * @param identifier Published RFC identifier.
 * @returns The decoded source or undefined when no cache index exists.
 */
export const readRfcSource = readSource;

/**
 * Expose the source cache path used for a source identity.
 *
 * @param sourceDirectory Source cache directory.
 * @param contentHash SHA-256 source identity.
 * @returns Content-addressed cache path.
 */
export const rfcSourceContentPath = (sourceDirectory: string, contentHash: string): string =>
  sourceContentPath(sourceDirectory, contentHash);
