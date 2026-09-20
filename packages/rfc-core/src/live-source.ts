import { createHash } from "node:crypto";
import {
  Cause,
  Clock,
  Context,
  Duration,
  Effect,
  FileSystem,
  Layer,
  Option,
  Path,
  Result,
  Schema,
  Stream,
} from "effect";
import * as PlatformError from "effect/PlatformError";
import { Headers, HttpClient, HttpClientResponse } from "effect/unstable/http";
import type { RfcMetadata } from "./discovery";
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

const rfcSourceDeadlineMilliseconds = 10_000;
const rfcSourceMaximumBytes = 8 * 1024 * 1024;

/**
 * Maximum on-disk size of one serialized source-cache entry.
 *
 * An entry wraps bounded source text in a JSON envelope, so this allows headroom
 * above `rfcSourceMaximumBytes` for that envelope and for string escaping. A
 * larger file is treated as corrupt and repaired rather than decoded, which
 * keeps a damaged entry from allocating without bound.
 */
const rfcSourceCacheEntryMaximumBytes = 2 * rfcSourceMaximumBytes;

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
    /**
     * RFC Editor response status, when one was received.
     */
    status: Schema.optionalKey(Schema.Number),
  },
) {}

type LiveSourceResponse = {
  readonly status: 200 | 304;
  readonly sourceUrl: string;
  readonly text: string | undefined;
  readonly etag: string | undefined;
  readonly maxAgeMilliseconds: number;
  /**
   * Whether the response carries `Cache-Control: no-store`.
   */
  readonly noStore: boolean;
};

/**
 * HTTP boundary used by version-two RFC source caching.
 */
export interface LiveRfcSourceService {
  /**
   * Fetch or conditionally revalidate one canonical RFC Editor source.
   */
  readonly fetch: (
    document: RfcMetadata,
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

const entryPath = (pathService: Path.Path, sourceDirectory: string, identifier: string): string =>
  pathService.join(sourceDirectory, "v2", `${identifier}.json`);

const validEtag = (value: string): boolean => /^(?:W\/)?"[^"\r\n]*"$/.test(value);

/**
 * Whether a validator is a strong entity tag.
 *
 * `If-None-Match` uses weak comparison, so a weak validator can produce a `304`
 * for a byte-different representation. Evidence carries exact hashes and UTF-8
 * byte offsets, so only a strong validator may drive conditional revalidation;
 * a weak one falls back to an unconditional fetch.
 */
const isStrongEtag = (value: string): boolean => /^"[^"\r\n]*"$/.test(value);

/**
 * Whether a Content-Type names exactly the `text/plain` media type.
 *
 * Parameters such as `charset` are permitted after the media type; a different
 * type that merely begins with the same characters is not.
 */
const isPlainTextMediaType = (value: string): boolean =>
  value.split(";", 1)[0]?.trim().toLowerCase() === "text/plain";

const maximumFreshnessMilliseconds = 365 * 24 * 60 * 60 * 1_000;

/**
 * Whether a response forbids persistent storage.
 *
 * `no-store` is distinct from `no-cache`: the latter permits storing a response
 * so long as it is revalidated before reuse, while the former forbids writing it
 * to the cache at all.
 */
const noStoreDirective = (headers: Headers.Headers): boolean => {
  const cacheControl = Option.getOrUndefined(Headers.get("cache-control")(headers));
  return cacheControl !== undefined && /(?:^|,)\s*no-store\s*(?:,|$)/i.test(cacheControl);
};

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

const readBoundedSourceText = Effect.fnUntraced(function* (
  response: HttpClientResponse.HttpClientResponse,
  url: string,
): Effect.fn.Return<string, RfcSourceFetchError> {
  const contentLengthValue = Option.getOrUndefined(Headers.get("content-length")(response.headers));
  if (contentLengthValue !== undefined) {
    const contentLength = Number(contentLengthValue);
    if (!Number.isSafeInteger(contentLength) || contentLength < 0) {
      return yield* new RfcSourceFetchError({
        stage: "decode",
        url,
        reason: "RFC Editor returned an invalid Content-Length",
      });
    }
    if (contentLength > rfcSourceMaximumBytes) {
      return yield* new RfcSourceFetchError({
        stage: "decode",
        url,
        reason: `RFC Editor source exceeds ${rfcSourceMaximumBytes} bytes`,
      });
    }
  }

  const body = yield* response.stream.pipe(
    Stream.runFoldEffect(
      () => ({ size: 0, chunks: [] as Array<Uint8Array> }),
      (state, chunk) => {
        const size = state.size + chunk.byteLength;
        if (size > rfcSourceMaximumBytes) {
          return Effect.fail(
            new RfcSourceFetchError({
              stage: "decode",
              url,
              reason: `RFC Editor source exceeds ${rfcSourceMaximumBytes} bytes`,
            }),
          );
        }
        state.chunks.push(chunk);
        return Effect.succeed({ size, chunks: state.chunks });
      },
    ),
    Effect.mapError((error) =>
      error instanceof RfcSourceFetchError
        ? error
        : new RfcSourceFetchError({ stage: "decode", url, reason: errorMessage(error) }),
    ),
  );
  if (body.size === 0) {
    return yield* new RfcSourceFetchError({
      stage: "decode",
      url,
      reason: "RFC Editor returned an empty source",
    });
  }
  const bytes = Buffer.concat(
    body.chunks.map((chunk) => Buffer.from(chunk)),
    body.size,
  );
  // Exact evidence depends on the decoded text matching the transmitted bytes,
  // so malformed input must fail rather than be silently replaced with U+FFFD.
  return yield* Effect.try({
    try: () => new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    catch: () =>
      new RfcSourceFetchError({
        stage: "decode",
        url,
        reason: "RFC Editor source is not valid UTF-8",
      }),
  });
});

const fetchFromRfcEditor = (
  http: HttpClient.HttpClient,
  document: RfcMetadata,
  etag: string | undefined,
): Effect.Effect<LiveSourceResponse, RfcSourceFetchError> => {
  const url = makeRfcSourceUrl(defaultRfcEditorBaseUrl, document.rfcNumber);
  return Effect.gen(function* () {
    const response = yield* http.get(
      url,
      etag === undefined ? undefined : { headers: { "if-none-match": etag } },
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
        status: 304 as const,
        sourceUrl: url,
        text: undefined,
        etag: (yield* responseEtag(response.headers, url)) ?? etag,
        maxAgeMilliseconds: maxAgeMilliseconds(response.headers),
        noStore: noStoreDirective(response.headers),
      };
    }
    if (response.status !== 200) {
      return yield* new RfcSourceFetchError({
        stage: "request",
        url,
        reason: `RFC Editor returned HTTP ${response.status}`,
        status: response.status,
      });
    }
    const contentType = Option.getOrUndefined(Headers.get("content-type")(response.headers));
    // Only an exact text/plain media type qualifies; a prefix test would also
    // admit unrelated types such as text/plain-html.
    if (contentType === undefined || !isPlainTextMediaType(contentType)) {
      return yield* new RfcSourceFetchError({
        stage: "decode",
        url,
        reason: "RFC Editor returned a non-plain-text source",
      });
    }
    return {
      status: 200 as const,
      sourceUrl: url,
      text: yield* readBoundedSourceText(response, url),
      etag: yield* responseEtag(response.headers, url),
      maxAgeMilliseconds: maxAgeMilliseconds(response.headers),
      noStore: noStoreDirective(response.headers),
    };
  }).pipe(
    Effect.timeout(Duration.millis(rfcSourceDeadlineMilliseconds)),
    Effect.mapError((error) => {
      if (error instanceof RfcSourceFetchError) return error;
      return new RfcSourceFetchError({
        stage: "request",
        url,
        reason: Cause.isTimeoutError(error)
          ? "RFC Editor request exceeded the ten-second deadline"
          : errorMessage(error),
      });
    }),
  );
};

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
              noStore: false,
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
  document: RfcMetadata,
): Effect.fn.Return<
  { readonly entry: LiveSourceCacheEntry | undefined; readonly corrupt: boolean },
  RfcSourceCacheError,
  FileSystem.FileSystem | Path.Path
> {
  const fileSystem = yield* FileSystem.FileSystem;
  const pathService = yield* Path.Path;
  const path = entryPath(pathService, sourceDirectory, document.identifier);
  const info = yield* fileSystem.stat(path).pipe(
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
  if (info === undefined) return { entry: undefined, corrupt: false };
  if (info.size > BigInt(rfcSourceCacheEntryMaximumBytes)) {
    return { entry: undefined, corrupt: true };
  }
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
        const fetchedAt = Date.parse(entry.fetchedAt);
        const freshUntil = Date.parse(entry.freshUntil);
        if (
          entry.identifier !== document.identifier ||
          entry.rfcNumber !== document.rfcNumber ||
          entry.sourceUrl !== expectedUrl ||
          hashRfcSource(entry.text) !== entry.contentHash ||
          !Number.isFinite(fetchedAt) ||
          !Number.isFinite(freshUntil) ||
          freshUntil < fetchedAt ||
          freshUntil - fetchedAt > maximumFreshnessMilliseconds ||
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
): Effect.fn.Return<void, RfcSourceCacheError, FileSystem.FileSystem | Path.Path> {
  const fileSystem = yield* FileSystem.FileSystem;
  const pathService = yield* Path.Path;
  const path = entryPath(pathService, sourceDirectory, entry.identifier);
  const temporaryPath = `${path}.tmp-${crypto.randomUUID()}`;
  const cleanup = fileSystem
    .remove(temporaryPath, { force: true })
    .pipe(Effect.catch(() => Effect.void));
  return yield* Effect.gen(function* () {
    yield* fileSystem.makeDirectory(pathService.dirname(path), { recursive: true });
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

const removeEntry = Effect.fnUntraced(function* (
  sourceDirectory: string,
  identifier: string,
): Effect.fn.Return<void, RfcSourceCacheError, FileSystem.FileSystem | Path.Path> {
  const fileSystem = yield* FileSystem.FileSystem;
  const pathService = yield* Path.Path;
  const path = entryPath(pathService, sourceDirectory, identifier);
  yield* fileSystem.remove(path, { force: true }).pipe(
    Effect.catchTag("PlatformError", (error) =>
      isNotFound(error)
        ? Effect.void
        : Effect.fail(
            new RfcSourceCacheError({
              stage: "write",
              sourcePath: path,
              reason: error.message,
            }),
          ),
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
  document: RfcMetadata,
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
  document: RfcMetadata,
  sourceDirectory: string,
): Effect.fn.Return<
  LiveRfcSourceResult,
  RfcSourceCacheError | RfcSourceFetchError | RfcSourceRevalidationError,
  FileSystem.FileSystem | LiveRfcSource | Path.Path
> {
  const { corrupt, entry } = yield* readEntry(sourceDirectory, document);
  const now = yield* Clock.currentTimeMillis;
  // A future fetchedAt cannot describe a response this client received, so the
  // entry's freshness window is not trustworthy and must be revalidated.
  const fetchedInThePast = entry !== undefined && Date.parse(entry.fetchedAt) <= now;
  if (entry !== undefined && fetchedInThePast && now < Date.parse(entry.freshUntil)) {
    return { source: sourceFromEntry(entry), outcome: "hit", requestCount: 0, status: undefined };
  }

  const service = yield* LiveRfcSource;
  const stale = entry !== undefined;
  const conditionalEtag =
    entry?.etag !== null && entry?.etag !== undefined && isStrongEtag(entry.etag)
      ? entry.etag
      : undefined;
  const sourceUrl = makeRfcSourceUrl(defaultRfcEditorBaseUrl, document.rfcNumber);
  const responseResult = yield* Effect.result(
    service.fetch(document, conditionalEtag).pipe(
      Effect.timeout(Duration.millis(rfcSourceDeadlineMilliseconds)),
      Effect.mapError((error) =>
        Cause.isTimeoutError(error)
          ? new RfcSourceFetchError({
              stage: "request",
              url: sourceUrl,
              reason: "RFC Editor request exceeded the ten-second deadline",
            })
          : error,
      ),
    ),
  );
  if (Result.isFailure(responseResult)) {
    if (stale) {
      return yield* new RfcSourceRevalidationError({
        url: makeRfcSourceUrl(defaultRfcEditorBaseUrl, document.rfcNumber),
        reason: responseResult.failure.reason,
        status: responseResult.failure.status,
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
    // A 304 asserts that the representation behind the conditional validator is
    // unchanged. Rebinding the cached bytes to any other validator - weak, or
    // simply different - would let unrelated text be reported as exact evidence.
    if (
      conditionalEtag === undefined ||
      (response.etag !== undefined &&
        !(isStrongEtag(response.etag) && response.etag === conditionalEtag))
    ) {
      return yield* new RfcSourceRevalidationError({
        url: response.sourceUrl,
        reason: "RFC Editor returned 304 with a validator that does not match the cached source",
      });
    }
    const refreshed: LiveSourceCacheEntry = {
      ...entry,
      etag: conditionalEtag,
      fetchedAt: new Date(now).toISOString(),
      freshUntil: new Date(now + response.maxAgeMilliseconds).toISOString(),
    };
    if (response.noStore) {
      yield* removeEntry(sourceDirectory, document.identifier);
    } else {
      yield* writeEntry(sourceDirectory, refreshed);
    }
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
        if (
          response.text !== undefined &&
          Buffer.byteLength(response.text, "utf8") > rfcSourceMaximumBytes
        ) {
          throw new Error(`RFC Editor source exceeds ${rfcSourceMaximumBytes} bytes`);
        }
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
          status: response.status,
        })
      : nextResult.failure;
  }
  const next = nextResult.success;
  if (response.noStore) {
    yield* removeEntry(sourceDirectory, document.identifier);
  } else {
    yield* writeEntry(sourceDirectory, next);
  }
  return {
    source: sourceFromEntry(next),
    outcome: corrupt ? "repaired" : stale ? "replaced" : "miss",
    requestCount: 1,
    status: 200,
  };
});
