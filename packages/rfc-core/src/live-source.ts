import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { Clock, Context, Effect, FileSystem, Layer, Option, Result, Schema } from "effect";
import * as PlatformError from "effect/PlatformError";
import { Headers, HttpClient } from "effect/unstable/http";
import type { CatalogDocument } from "./catalog";
import {
  RfcSourceCacheError,
  RfcSourceFetchError,
  defaultRfcEditorBaseUrl,
  hashRfcSource,
  makeRfcSourceUrl,
  type RfcSource,
  type RfcSourceFetcher,
} from "./source";

/**
 * Version of the HTTP-compliant RFC source-cache format.
 */
export const liveRfcSourceCacheVersion = 2 as const;

/**
 * Stable identity for version-two RFC source-cache entries.
 */
export const liveRfcSourceCacheIdentity = "rfc-source-v2" as const;

/**
 * Observable result of one RFC source-cache read.
 */
export const LiveSourceCacheOutcomeSchema = Schema.Literals([
  "hit",
  "miss",
  "revalidated",
  "replaced",
  "repaired",
]);

/**
 * Observable result of one RFC source-cache read.
 */
export type LiveSourceCacheOutcome = Schema.Schema.Type<typeof LiveSourceCacheOutcomeSchema>;

const LiveSourceCacheEntrySchema = Schema.Struct({
  schemaVersion: Schema.Literal(liveRfcSourceCacheVersion),
  kind: Schema.Literal("rfc_source_cache_entry"),
  cacheIdentity: Schema.Literal(liveRfcSourceCacheIdentity),
  identifier: Schema.NonEmptyString,
  rfcNumber: Schema.Number.check(Schema.isGreaterThan(0)),
  sourceUrl: Schema.NonEmptyString,
  text: Schema.NonEmptyString,
  contentHash: Schema.NonEmptyString,
  etag: Schema.NullOr(Schema.NonEmptyString),
  fetchedAt: Schema.String,
  freshUntil: Schema.String,
});

type LiveSourceCacheEntry = Schema.Schema.Type<typeof LiveSourceCacheEntrySchema>;

/**
 * Typed failure when stale RFC text cannot be authoritatively revalidated.
 */
export class RfcSourceRevalidationError extends Schema.TaggedError<RfcSourceRevalidationError>()(
  "RfcSourceRevalidationError",
  {
    url: Schema.String,
    reason: Schema.String,
  },
) {}

type LiveSourceResponse = {
  readonly status: 200 | 304;
  readonly sourceUrl: string;
  readonly text: string | undefined;
  readonly etag: string | undefined;
  readonly maxAgeMilliseconds: number;
};

/**
 * HTTP boundary used by version-two RFC source caching.
 */
export interface LiveRfcSourceService {
  /**
   * Fetch or conditionally revalidate one canonical RFC Editor source.
   */
  readonly fetch: (
    document: CatalogDocument,
    etag: string | undefined,
  ) => Effect.Effect<LiveSourceResponse, RfcSourceFetchError>;
}

/**
 * Effect service tag for version-two RFC source retrieval.
 */
export class LiveRfcSource extends Context.Service<LiveRfcSource, LiveRfcSourceService>()(
  "rfc-core/LiveRfcSource",
) {}

/**
 * Exact source plus the cache behavior used to obtain it.
 */
export interface LiveRfcSourceResult {
  /**
   * Exact canonical RFC source.
   */
  readonly source: RfcSource;
  /**
   * Cache behavior observed while loading the source.
   */
  readonly outcome: LiveSourceCacheOutcome;
  /**
   * Number of RFC Editor requests issued.
   */
  readonly requestCount: number;
  /**
   * Final RFC Editor response status, when a request was issued.
   */
  readonly status: number | undefined;
}

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : "The RFC source operation failed";

const isNotFound = (error: PlatformError.PlatformError): boolean =>
  error.reason._tag === "NotFound";

const entryPath = (sourceDirectory: string, identifier: string): string =>
  join(sourceDirectory, "v2", `${identifier}.json`);

const validEtag = (value: string): boolean => /^(?:W\/)?"[^"\r\n]*"$/.test(value);

const maximumFreshnessMilliseconds = 365 * 24 * 60 * 60 * 1_000;

const maxAgeMilliseconds = (headers: Headers.Headers): number => {
  const cacheControl = Option.getOrUndefined(Headers.get("cache-control")(headers));
  if (
    cacheControl === undefined ||
    /(?:^|,)\s*(?:no-cache|no-store)\s*(?:,|$)/i.test(cacheControl)
  ) {
    return 0;
  }
  const maxAge = cacheControl.match(/(?:^|,)\s*max-age=(\d+)\s*(?:,|$)/i)?.[1];
  if (maxAge === undefined) return 0;
  const seconds = Number(maxAge);
  const ageValue = Option.getOrUndefined(Headers.get("age")(headers));
  const age = ageValue === undefined ? 0 : Number(ageValue);
  if (!Number.isSafeInteger(seconds) || seconds < 0 || !Number.isSafeInteger(age) || age < 0) {
    return 0;
  }
  return Math.min(maximumFreshnessMilliseconds, Math.max(0, seconds * 1_000 - age * 1_000));
};

const responseEtag = (
  headers: Headers.Headers,
  url: string,
): Effect.Effect<string | undefined, RfcSourceFetchError> =>
  Effect.try({
    try: () => {
      const etag = Option.getOrUndefined(Headers.get("etag")(headers));
      if (etag !== undefined && !validEtag(etag)) throw new Error("invalid ETag");
      return etag;
    },
    catch: () =>
      new RfcSourceFetchError({
        stage: "decode",
        url,
        reason: "RFC Editor returned a malformed ETag validator",
      }),
  });

const fetchFromRfcEditor = Effect.fnUntraced(function* (
  http: HttpClient.HttpClient,
  document: CatalogDocument,
  etag: string | undefined,
): Effect.fn.Return<LiveSourceResponse, RfcSourceFetchError> {
  const url = makeRfcSourceUrl(defaultRfcEditorBaseUrl, document.rfcNumber);
  const response = yield* http
    .get(url, etag === undefined ? undefined : { headers: { "if-none-match": etag } })
    .pipe(
      Effect.mapError(
        (error) =>
          new RfcSourceFetchError({
            stage: "request",
            url,
            reason: errorMessage(error),
          }),
      ),
    );
  const responseUrl = response.url || url;
  if (responseUrl !== url) {
    return yield* new RfcSourceFetchError({
      stage: "request",
      url: responseUrl,
      reason: "RFC Editor redirected away from the exact canonical source URL",
    });
  }
  if (response.status === 304) {
    if (etag === undefined) {
      return yield* new RfcSourceFetchError({
        stage: "decode",
        url,
        reason: "RFC Editor returned 304 without a conditional request",
      });
    }
    return {
      status: 304,
      sourceUrl: url,
      text: undefined,
      etag: (yield* responseEtag(response.headers, url)) ?? etag,
      maxAgeMilliseconds: maxAgeMilliseconds(response.headers),
    };
  }
  if (response.status < 200 || response.status >= 300) {
    return yield* new RfcSourceFetchError({
      stage: "request",
      url,
      reason: `RFC Editor returned HTTP ${response.status}`,
    });
  }
  const contentType = Option.getOrUndefined(Headers.get("content-type")(response.headers));
  if (contentType !== undefined && !contentType.toLowerCase().startsWith("text/plain")) {
    return yield* new RfcSourceFetchError({
      stage: "decode",
      url,
      reason: "RFC Editor returned a non-plain-text source",
    });
  }
  const text = yield* response.text.pipe(
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
  return {
    status: 200,
    sourceUrl: url,
    text,
    etag: yield* responseEtag(response.headers, url),
    maxAgeMilliseconds: maxAgeMilliseconds(response.headers),
  };
});

/**
 * Create a version-two source layer backed by a supplied HTTP client.
 *
 * @param http HTTP client used for canonical RFC Editor requests.
 * @returns A source service layer.
 */
export const makeLiveRfcSourceHttpLayer = (
  http: HttpClient.HttpClient,
): Layer.Layer<LiveRfcSource> =>
  Layer.succeed(
    LiveRfcSource,
    LiveRfcSource.of({
      fetch: (document, etag) => fetchFromRfcEditor(http, document, etag),
    }),
  );

/**
 * Build the default version-two source layer.
 *
 * @returns A source layer requiring an Effect HTTP client.
 */
export const makeDefaultLiveRfcSourceLayer = (): Layer.Layer<
  LiveRfcSource,
  never,
  HttpClient.HttpClient
> =>
  Layer.effect(
    LiveRfcSource,
    Effect.gen(function* () {
      const http = yield* HttpClient.HttpClient;
      return LiveRfcSource.of({
        fetch: (document, etag) => fetchFromRfcEditor(http, document, etag),
      });
    }),
  );

/**
 * Create a deterministic version-two source layer from an injected fetcher.
 *
 * @param fetcher Promise-returning source fetcher.
 * @returns A deterministic source service layer.
 */
export const makeLiveRfcSourceLayer = (fetcher: RfcSourceFetcher): Layer.Layer<LiveRfcSource> =>
  Layer.succeed(
    LiveRfcSource,
    LiveRfcSource.of({
      fetch: (document) =>
        Effect.tryPromise({
          try: async () => {
            const payload = await fetcher(document);
            const normalized =
              typeof payload === "string" ? { sourceUrl: undefined, text: payload } : payload;
            return {
              status: 200 as const,
              sourceUrl:
                normalized.sourceUrl ??
                makeRfcSourceUrl(defaultRfcEditorBaseUrl, document.rfcNumber),
              text: normalized.text,
              etag: undefined,
              maxAgeMilliseconds: 60 * 60 * 1_000,
            };
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

const readEntry = Effect.fnUntraced(function* (
  sourceDirectory: string,
  document: CatalogDocument,
): Effect.fn.Return<
  { readonly entry: LiveSourceCacheEntry | undefined; readonly corrupt: boolean },
  RfcSourceCacheError,
  FileSystem.FileSystem
> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = entryPath(sourceDirectory, document.identifier);
  const contents = yield* fileSystem.readFileString(path).pipe(
    Effect.catchTag("PlatformError", (error) =>
      isNotFound(error)
        ? Effect.succeed(undefined)
        : Effect.fail(
            new RfcSourceCacheError({
              stage: "read",
              sourcePath: path,
              reason: error.message,
            }),
          ),
    ),
  );
  if (contents === undefined) return { entry: undefined, corrupt: false };
  const decoded = yield* Effect.result(
    Effect.try({
      try: () => {
        const entry = Schema.decodeUnknownSync(LiveSourceCacheEntrySchema)(
          JSON.parse(contents) as unknown,
        );
        const expectedUrl = makeRfcSourceUrl(defaultRfcEditorBaseUrl, document.rfcNumber);
        if (
          entry.identifier !== document.identifier ||
          entry.rfcNumber !== document.rfcNumber ||
          entry.sourceUrl !== expectedUrl ||
          hashRfcSource(entry.text) !== entry.contentHash ||
          !Number.isFinite(Date.parse(entry.fetchedAt)) ||
          !Number.isFinite(Date.parse(entry.freshUntil)) ||
          (entry.etag !== null && !validEtag(entry.etag))
        ) {
          throw new Error("invalid source cache entry");
        }
        return entry;
      },
      catch: () => new Error("corrupt source cache entry"),
    }),
  );
  return Result.isSuccess(decoded)
    ? { entry: decoded.success, corrupt: false }
    : { entry: undefined, corrupt: true };
});

const writeEntry = Effect.fnUntraced(function* (
  sourceDirectory: string,
  entry: LiveSourceCacheEntry,
): Effect.fn.Return<void, RfcSourceCacheError, FileSystem.FileSystem> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = entryPath(sourceDirectory, entry.identifier);
  const temporaryPath = `${path}.tmp-${crypto.randomUUID()}`;
  const cleanup = fileSystem
    .remove(temporaryPath, { force: true })
    .pipe(Effect.catch(() => Effect.void));
  return yield* Effect.gen(function* () {
    yield* fileSystem.makeDirectory(dirname(path), { recursive: true });
    yield* fileSystem.writeFileString(temporaryPath, `${JSON.stringify(entry, null, 2)}\n`);
    yield* fileSystem.rename(temporaryPath, path);
  }).pipe(
    Effect.ensuring(cleanup),
    Effect.mapError(
      (error) =>
        new RfcSourceCacheError({
          stage: "write",
          sourcePath: path,
          reason: error.message,
        }),
    ),
  );
});

const sourceFromEntry = (entry: LiveSourceCacheEntry): RfcSource => ({
  identifier: entry.identifier,
  rfcNumber: entry.rfcNumber,
  sourceUrl: entry.sourceUrl,
  text: entry.text,
  contentHash: entry.contentHash,
  fetchedAt: entry.fetchedAt,
});

const entryFromResponse = (
  document: CatalogDocument,
  response: LiveSourceResponse,
  now: number,
): LiveSourceCacheEntry => {
  if (response.text === undefined) throw new Error("A 200 response must include source text");
  return {
    schemaVersion: liveRfcSourceCacheVersion,
    kind: "rfc_source_cache_entry",
    cacheIdentity: liveRfcSourceCacheIdentity,
    identifier: document.identifier,
    rfcNumber: document.rfcNumber,
    sourceUrl: response.sourceUrl,
    text: response.text,
    contentHash: createHash("sha256").update(response.text, "utf8").digest("hex"),
    etag: response.etag ?? null,
    fetchedAt: new Date(now).toISOString(),
    freshUntil: new Date(now + response.maxAgeMilliseconds).toISOString(),
  };
};

/**
 * Load canonical RFC text through the version-two HTTP cache.
 *
 * @param document Exact request-local RFC metadata.
 * @param sourceDirectory Root source-cache directory.
 * @returns Exact source text and the observed cache outcome.
 */
export const loadLiveRfcSource = Effect.fnUntraced(function* (
  document: CatalogDocument,
  sourceDirectory: string,
): Effect.fn.Return<
  LiveRfcSourceResult,
  RfcSourceCacheError | RfcSourceFetchError | RfcSourceRevalidationError,
  FileSystem.FileSystem | LiveRfcSource
> {
  const { corrupt, entry } = yield* readEntry(sourceDirectory, document);
  const now = yield* Clock.currentTimeMillis;
  if (entry !== undefined && now < Date.parse(entry.freshUntil)) {
    return { source: sourceFromEntry(entry), outcome: "hit", requestCount: 0, status: undefined };
  }

  const service = yield* LiveRfcSource;
  const stale = entry !== undefined;
  const responseResult = yield* Effect.result(
    service.fetch(document, stale ? (entry.etag ?? undefined) : undefined),
  );
  if (Result.isFailure(responseResult)) {
    if (stale) {
      return yield* new RfcSourceRevalidationError({
        url: makeRfcSourceUrl(defaultRfcEditorBaseUrl, document.rfcNumber),
        reason: responseResult.failure.reason,
      });
    }
    return yield* responseResult.failure;
  }
  const response = responseResult.success;
  if (response.sourceUrl !== makeRfcSourceUrl(defaultRfcEditorBaseUrl, document.rfcNumber)) {
    const failure = new RfcSourceFetchError({
      stage: "decode",
      url: response.sourceUrl,
      reason: "RFC source retrieval must use the canonical RFC Editor URL",
    });
    return yield* stale
      ? new RfcSourceRevalidationError({ url: response.sourceUrl, reason: failure.reason })
      : failure;
  }

  if (response.status === 304) {
    if (entry === undefined) {
      return yield* new RfcSourceFetchError({
        stage: "decode",
        url: response.sourceUrl,
        reason: "RFC Editor returned 304 without cached source text",
      });
    }
    const refreshed: LiveSourceCacheEntry = {
      ...entry,
      etag: response.etag ?? entry.etag,
      fetchedAt: new Date(now).toISOString(),
      freshUntil: new Date(now + response.maxAgeMilliseconds).toISOString(),
    };
    yield* writeEntry(sourceDirectory, refreshed);
    return {
      source: sourceFromEntry(refreshed),
      outcome: "revalidated",
      requestCount: 1,
      status: 304,
    };
  }

  const nextResult = yield* Effect.result(
    Effect.try({
      try: () => {
        if (response.text?.length === 0) throw new Error("RFC Editor returned an empty source");
        return entryFromResponse(document, response, now);
      },
      catch: (error) =>
        new RfcSourceFetchError({
          stage: "decode",
          url: response.sourceUrl,
          reason: errorMessage(error),
        }),
    }),
  );
  if (Result.isFailure(nextResult)) {
    return yield* stale
      ? new RfcSourceRevalidationError({
          url: response.sourceUrl,
          reason: nextResult.failure.reason,
        })
      : nextResult.failure;
  }
  const next = nextResult.success;
  yield* writeEntry(sourceDirectory, next);
  return {
    source: sourceFromEntry(next),
    outcome: corrupt ? "repaired" : stale ? "replaced" : "miss",
    requestCount: 1,
    status: 200,
  };
});
