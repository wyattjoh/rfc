import { Clock, Context, Effect, FileSystem, Layer, Schema } from "effect";
import * as PlatformError from "effect/PlatformError";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import { dirname } from "node:path";

/**
 * The maximum age of a catalog that can be used for research.
 */
export const catalogMaxAgeMilliseconds = 7 * 24 * 60 * 60 * 1000;

/**
 * The stable identity of the version-one RFC metadata cache format.
 */
export const catalogCacheIdentity = "rfc-catalog-v1" as const;

/**
 * The default Datatracker API base URL used for catalog refreshes.
 */
export const defaultDatatrackerApiUrl = "https://datatracker.ietf.org/api/v1/";

/**
 * The number of upstream records requested per Datatracker page.
 */
export const datatrackerPageSize = 500;

/**
 * A normalized update or obsoletion relationship between published RFCs.
 */
export type CatalogRelationship = "updates" | "obsoletes";

/**
 * Schema for a normalized published RFC document in the catalog.
 */
export const CatalogDocumentSchema = Schema.Struct({
  identifier: Schema.NonEmptyString,
  rfcNumber: Schema.Natural,
  title: Schema.String,
  abstract: Schema.String,
  status: Schema.NonEmptyString,
  stream: Schema.NonEmptyString,
  canonicalUrl: Schema.NonEmptyString,
  updates: Schema.Array(Schema.NonEmptyString),
  updatedBy: Schema.Array(Schema.NonEmptyString),
  obsoletes: Schema.Array(Schema.NonEmptyString),
  obsoletedBy: Schema.Array(Schema.NonEmptyString),
});

/**
 * A normalized published RFC document stored in the catalog.
 */
export type CatalogDocument = Schema.Schema.Type<typeof CatalogDocumentSchema>;

/**
 * Schema for the versioned on-disk RFC catalog.
 */
export const RfcCatalogSchema = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  kind: Schema.Literal("rfc_catalog"),
  cacheIdentity: Schema.Literal(catalogCacheIdentity),
  fetchedAt: Schema.String,
  documents: Schema.Array(CatalogDocumentSchema),
});

/**
 * The complete normalized catalog persisted by the core package.
 */
export type RfcCatalog = Schema.Schema.Type<typeof RfcCatalogSchema>;

/**
 * Signals that Datatracker could not provide a complete catalog refresh.
 */
export class CatalogRefreshError extends Schema.TaggedError<CatalogRefreshError>()(
  "CatalogRefreshError",
  {
    stage: Schema.Literals(["request", "decode", "normalize", "write"]),
    url: Schema.String,
    reason: Schema.String,
  },
) {}

/**
 * Signals that a previously written catalog could not be read or decoded.
 */
export class CatalogReadError extends Schema.TaggedError<CatalogReadError>()("CatalogReadError", {
  catalogPath: Schema.String,
  reason: Schema.String,
}) {}

/**
 * Signals that an assembled catalog could not be atomically persisted.
 */
export class CatalogWriteError extends Schema.TaggedError<CatalogWriteError>()(
  "CatalogWriteError",
  {
    catalogPath: Schema.String,
    reason: Schema.String,
  },
) {}

/**
 * Signals that research attempted to use a catalog older than the freshness policy.
 */
export class CatalogStaleError extends Schema.TaggedError<CatalogStaleError>()(
  "CatalogStaleError",
  {
    catalogPath: Schema.String,
    fetchedAt: Schema.String,
    ageMs: Schema.Number,
  },
) {}

/**
 * Schema for catalog lifecycle states at the untrusted JSON boundary.
 */
export const CatalogStateSchema = Schema.Literals(["missing", "stale", "fresh"]);

/**
 * A catalog status response kind.
 */
export type CatalogStatusKind = "catalog_status" | "catalog_refresh";

const CatalogStatusFields = {
  schemaVersion: Schema.Literal(1),
  state: CatalogStateSchema,
  catalogPath: Schema.String,
  cacheIdentity: Schema.Literal(catalogCacheIdentity),
  fetchedAt: Schema.NullOr(Schema.String),
  refreshedAt: Schema.NullOr(Schema.String),
  ageMs: Schema.NullOr(Schema.Number),
  documentCount: Schema.Natural,
} as const;

/**
 * Schema for the public catalog status response.
 */
export const CatalogStatusSchema = Schema.Struct({
  ...CatalogStatusFields,
  kind: Schema.Literal("catalog_status"),
});

/**
 * Schema for the result emitted after a catalog refresh.
 */
export const CatalogRefreshResultSchema = Schema.Struct({
  ...CatalogStatusFields,
  kind: Schema.Literal("catalog_refresh"),
});

/**
 * A decoded catalog status response.
 */
export type CatalogStatus = Schema.Schema.Type<typeof CatalogStatusSchema>;

/**
 * A decoded catalog refresh response.
 */
export type CatalogRefreshResult = Schema.Schema.Type<typeof CatalogRefreshResultSchema>;

/**
 * An upstream Datatracker document source that can be replaced by deterministic tests.
 */
export type CatalogSource = () => Promise<ReadonlyArray<CatalogDocument>>;

/**
 * The service used by catalog programs to obtain normalized document metadata.
 */
export interface DatatrackerCatalogSourceService {
  readonly refresh: () => Effect.Effect<ReadonlyArray<CatalogDocument>, CatalogRefreshError>;
}

/**
 * Effect service tag for the Datatracker catalog source.
 */
export class DatatrackerCatalogSource extends Context.Service<
  DatatrackerCatalogSource,
  DatatrackerCatalogSourceService
>()("rfc-core/DatatrackerCatalogSource") {}

/**
 * The service used by catalog programs to read and atomically write cache data.
 */
export interface CatalogStoreService {
  readonly read: (
    catalogPath: string,
  ) => Effect.Effect<RfcCatalog | undefined, CatalogReadError, FileSystem.FileSystem>;
  readonly status: (
    catalogPath: string,
  ) => Effect.Effect<CatalogStatus, CatalogReadError, FileSystem.FileSystem>;
  readonly write: (
    catalogPath: string,
    catalog: RfcCatalog,
  ) => Effect.Effect<void, CatalogWriteError, FileSystem.FileSystem>;
}

/**
 * Effect service tag for the local RFC catalog store.
 */
export class CatalogStore extends Context.Service<CatalogStore, CatalogStoreService>()(
  "rfc-core/CatalogStore",
) {}

const isNotFound = (error: PlatformError.PlatformError): boolean =>
  error.reason._tag === "NotFound";

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : "The upstream operation failed";

const lastPathSegment = (value: string): string => {
  const withoutQuery = value.split("?", 1)[0] ?? value;
  const trimmed = withoutQuery.replace(/\/+$/, "");
  const segment = trimmed.slice(trimmed.lastIndexOf("/") + 1);
  return segment.toLowerCase();
};

const identifierFromReference = (value: string): string | undefined => {
  const segment = lastPathSegment(value);
  const match = /^rfc(\d+)$/.exec(segment);
  return match === null ? undefined : `RFC${match[1]}`;
};

const compareIdentifiers = (left: string, right: string): number => {
  const leftNumber = Number(left.slice(3));
  const rightNumber = Number(right.slice(3));
  return leftNumber - rightNumber || left.localeCompare(right);
};

const streamFromReference = (value: string): string => {
  const segment = lastPathSegment(value);
  return segment.length === 0 ? "unknown" : segment;
};

const statusFromDocument = (document: DatatrackerDocument): string => {
  const explicitStatus = document.status ?? document.state;
  if (explicitStatus !== undefined && explicitStatus !== null) {
    const status = lastPathSegment(explicitStatus);
    if (status.length > 0 && !/^\d+$/.test(status)) {
      return status;
    }
  }

  const stateStatus = document.states
    ?.map(lastPathSegment)
    .find((status) => status.length > 0 && !/^\d+$/.test(status));
  return stateStatus ?? "published";
};

const DatatrackerDocumentSchema = Schema.Struct({
  name: Schema.NonEmptyString,
  rfc_number: Schema.Natural,
  title: Schema.String,
  abstract: Schema.String,
  stream: Schema.NonEmptyString,
  status: Schema.optionalKey(Schema.NullOr(Schema.NonEmptyString)),
  state: Schema.optionalKey(Schema.NullOr(Schema.NonEmptyString)),
  resource_uri: Schema.optionalKey(Schema.NonEmptyString),
  states: Schema.optionalKey(Schema.Array(Schema.String)),
});

type DatatrackerDocument = Schema.Schema.Type<typeof DatatrackerDocumentSchema>;

const DatatrackerRelationshipSchema = Schema.Struct({
  source: Schema.NonEmptyString,
  target: Schema.NonEmptyString,
  relationship: Schema.NonEmptyString,
});

type DatatrackerRelationship = Schema.Schema.Type<typeof DatatrackerRelationshipSchema>;

const DatatrackerPageSchema = Schema.Struct({
  meta: Schema.Struct({
    next: Schema.NullOr(Schema.String),
    total_count: Schema.Natural,
  }),
  objects: Schema.Array(Schema.Unknown),
});

type DatatrackerPage = Schema.Schema.Type<typeof DatatrackerPageSchema>;

const decodePage = (value: unknown, url: string): DatatrackerPage => {
  try {
    return Schema.decodeUnknownSync(DatatrackerPageSchema)(value);
  } catch {
    throw new CatalogRefreshError({
      stage: "decode",
      url,
      reason: "Datatracker returned a malformed paginated response",
    });
  }
};

const decodeDocument = (value: unknown, url: string): DatatrackerDocument => {
  try {
    return Schema.decodeUnknownSync(DatatrackerDocumentSchema)(value);
  } catch {
    throw new CatalogRefreshError({
      stage: "decode",
      url,
      reason: "Datatracker returned an incomplete RFC document",
    });
  }
};

const decodeRelationship = (value: unknown, url: string): DatatrackerRelationship => {
  try {
    return Schema.decodeUnknownSync(DatatrackerRelationshipSchema)(value);
  } catch {
    throw new CatalogRefreshError({
      stage: "decode",
      url,
      reason: "Datatracker returned an incomplete RFC relationship",
    });
  }
};

const makePageUrl = (
  baseUrl: string,
  resource: "document" | "relateddocument",
): Effect.Effect<string, CatalogRefreshError> =>
  Effect.try({
    try: () => {
      const base = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
      const url = new URL(`doc/${resource}/`, base);
      url.searchParams.set("limit", String(datatrackerPageSize));
      url.searchParams.set("offset", "0");
      url.searchParams.set("format", "json");
      // Datatracker's default ordering is not stable across offset pages.
      // Pin the upstream primary-key order so a complete published catalog
      // cannot silently omit an RFC between requests.
      url.searchParams.set("order_by", "id");
      if (resource === "document") {
        url.searchParams.set("type__slug", "rfc");
      } else {
        url.searchParams.set("relationship__slug__in", "obs,updates");
      }
      return url.toString();
    },
    catch: (error) =>
      new CatalogRefreshError({
        stage: "request",
        url: baseUrl,
        reason: errorMessage(error),
      }),
  });

const nextPageUrl = (
  currentUrl: string,
  next: string | null,
  configuredOrigin: string,
): Effect.Effect<string | undefined, CatalogRefreshError> => {
  if (next === null || next.length === 0) {
    return Effect.succeed(undefined);
  }

  return Effect.try({
    try: () => {
      const resolved = new URL(next, currentUrl);
      if (resolved.origin !== configuredOrigin) {
        throw new CatalogRefreshError({
          stage: "request",
          url: resolved.toString(),
          reason: "Datatracker returned a next-page URL outside the configured API origin",
        });
      }
      // Keep the stable primary-key ordering on every page, even when an
      // upstream next link omits the query parameter.
      resolved.searchParams.set("order_by", "id");
      return resolved.toString();
    },
    catch: (error) =>
      error instanceof CatalogRefreshError
        ? error
        : new CatalogRefreshError({
            stage: "decode",
            url: currentUrl,
            reason: "Datatracker returned an invalid next-page URL",
          }),
  });
};

const fetchPage = Effect.fnUntraced(function* (
  http: HttpClient.HttpClient,
  url: string,
  configuredOrigin: string,
): Effect.fn.Return<DatatrackerPage, CatalogRefreshError> {
  const response = yield* http.get(url).pipe(
    Effect.mapError(
      (error) =>
        new CatalogRefreshError({
          stage: "request",
          url,
          reason: errorMessage(error),
        }),
    ),
  );
  const responseOrigin = yield* Effect.try({
    try: () => new URL(response.url).origin,
    catch: (error) =>
      new CatalogRefreshError({
        stage: "request",
        url: response.url || url,
        reason: errorMessage(error),
      }),
  });
  if (responseOrigin !== configuredOrigin) {
    return yield* new CatalogRefreshError({
      stage: "request",
      url: response.url,
      reason: "Datatracker redirected outside the configured API origin",
    });
  }

  const successfulResponse = yield* HttpClientResponse.filterStatusOk(response).pipe(
    Effect.mapError(
      (error) =>
        new CatalogRefreshError({
          stage: "request",
          url,
          reason: errorMessage(error),
        }),
    ),
  );
  const json = yield* successfulResponse.json.pipe(
    Effect.mapError(
      (error) =>
        new CatalogRefreshError({
          stage: "decode",
          url,
          reason: errorMessage(error),
        }),
    ),
  );

  return yield* Effect.try({
    try: () => decodePage(json, url),
    catch: (error) =>
      error instanceof CatalogRefreshError
        ? error
        : new CatalogRefreshError({
            stage: "decode",
            url,
            reason: errorMessage(error),
          }),
  });
});

const pageOffset = (url: string): Effect.Effect<number | undefined, CatalogRefreshError> =>
  Effect.try({
    try: () => {
      const value = new URL(url).searchParams.get("offset");
      if (value === null) return undefined;
      const offset = Number(value);
      if (!Number.isSafeInteger(offset) || offset < 0) {
        throw new Error("The pagination offset is not a non-negative integer");
      }
      return offset;
    },
    catch: (error) =>
      new CatalogRefreshError({
        stage: "decode",
        url,
        reason: errorMessage(error),
      }),
  });

const fetchAllPages = Effect.fnUntraced(function* (
  http: HttpClient.HttpClient,
  initialUrl: string,
): Effect.fn.Return<ReadonlyArray<unknown>, CatalogRefreshError> {
  const configuredOrigin = yield* Effect.try({
    try: () => new URL(initialUrl).origin,
    catch: (error) =>
      new CatalogRefreshError({
        stage: "request",
        url: initialUrl,
        reason: errorMessage(error),
      }),
  });
  const values: Array<unknown> = [];
  const visited = new Set<string>();
  let url: string | undefined = initialUrl;

  while (url !== undefined) {
    if (visited.has(url)) {
      return yield* new CatalogRefreshError({
        stage: "request",
        url,
        reason: "Datatracker pagination repeated the same page",
      });
    }
    visited.add(url);

    const currentPage: DatatrackerPage = yield* fetchPage(http, url, configuredOrigin);
    values.push(...currentPage.objects);

    const next: string | undefined = yield* nextPageUrl(
      url,
      currentPage.meta.next,
      configuredOrigin,
    );
    if (next !== undefined) {
      const currentOffset = yield* pageOffset(url);
      const nextOffset = yield* pageOffset(next);
      if (currentOffset !== undefined && nextOffset !== undefined && nextOffset <= currentOffset) {
        return yield* new CatalogRefreshError({
          stage: "decode",
          url: next,
          reason: "Datatracker pagination did not advance its offset",
        });
      }
    }
    url = next;
  }

  // total_count is advisory: Datatracker can report a different snapshot on
  // each request while documents are published or withdrawn. Exhausting the
  // validated next-link chain is the completion signal; normalization below
  // deduplicates stable document and relationship identities.
  return values;
});

const normalizeDocuments = (
  values: ReadonlyArray<unknown>,
  url: string,
): ReadonlyArray<CatalogDocument> => {
  const documents = new Map<number, CatalogDocument>();

  for (const value of values) {
    const document = decodeDocument(value, url);
    if (document.rfc_number <= 0) {
      throw new CatalogRefreshError({
        stage: "normalize",
        url,
        reason: "Datatracker returned an RFC without a positive number",
      });
    }

    if (documents.has(document.rfc_number)) {
      continue;
    }

    const identifier = `RFC${document.rfc_number}`;
    documents.set(document.rfc_number, {
      identifier,
      rfcNumber: document.rfc_number,
      title: document.title,
      abstract: document.abstract,
      status: statusFromDocument(document),
      stream: streamFromReference(document.stream),
      canonicalUrl: `https://datatracker.ietf.org/doc/rfc${document.rfc_number}/`,
      updates: [],
      updatedBy: [],
      obsoletes: [],
      obsoletedBy: [],
    });
  }

  if (documents.size === 0) {
    throw new CatalogRefreshError({
      stage: "normalize",
      url,
      reason: "Datatracker returned no published RFC documents",
    });
  }

  return [...documents.values()].sort((left, right) => left.rfcNumber - right.rfcNumber);
};

const normalizeRelationships = (
  documents: ReadonlyArray<CatalogDocument>,
  values: ReadonlyArray<unknown>,
  url: string,
): ReadonlyArray<CatalogDocument> => {
  const relationships = new Map(
    documents.map((document) => [
      document.identifier,
      {
        updates: new Set<string>(),
        updatedBy: new Set<string>(),
        obsoletes: new Set<string>(),
        obsoletedBy: new Set<string>(),
      },
    ]),
  );

  for (const value of values) {
    const relationship = decodeRelationship(value, url);
    const source = identifierFromReference(relationship.source);
    const target = identifierFromReference(relationship.target);
    const kind = lastPathSegment(relationship.relationship);
    if (source === undefined || target === undefined || (kind !== "updates" && kind !== "obs")) {
      throw new CatalogRefreshError({
        stage: "normalize",
        url,
        reason: "Datatracker returned a malformed RFC update or obsoletion relationship",
      });
    }

    const sourceValues = relationships.get(source);
    const targetValues = relationships.get(target);
    if (sourceValues === undefined || targetValues === undefined) {
      // Datatracker can retain a well-formed relationship for an RFC that is
      // absent from this published-document snapshot. Do not let that orphan
      // record invalidate the otherwise usable catalog, but keep the strict
      // validation above so malformed references still fail closed.
      continue;
    }

    if (kind === "updates") {
      sourceValues.updates.add(target);
      targetValues.updatedBy.add(source);
    } else if (kind === "obs") {
      sourceValues.obsoletes.add(target);
      targetValues.obsoletedBy.add(source);
    }
  }

  return documents.map((document) => {
    const valuesForDocument = relationships.get(document.identifier);
    if (valuesForDocument === undefined) {
      return document;
    }

    return {
      ...document,
      updates: [...valuesForDocument.updates].sort(compareIdentifiers),
      updatedBy: [...valuesForDocument.updatedBy].sort(compareIdentifiers),
      obsoletes: [...valuesForDocument.obsoletes].sort(compareIdentifiers),
      obsoletedBy: [...valuesForDocument.obsoletedBy].sort(compareIdentifiers),
    };
  });
};

const refreshFromDatatracker = Effect.fnUntraced(function* (
  http: HttpClient.HttpClient,
  baseUrl: string,
): Effect.fn.Return<ReadonlyArray<CatalogDocument>, CatalogRefreshError> {
  const documentUrl = yield* makePageUrl(baseUrl, "document");
  const relationshipUrl = yield* makePageUrl(baseUrl, "relateddocument");
  const upstreamDocuments = yield* fetchAllPages(http, documentUrl);
  const documents = yield* Effect.try({
    try: () => normalizeDocuments(upstreamDocuments, documentUrl),
    catch: (error) =>
      error instanceof CatalogRefreshError
        ? error
        : new CatalogRefreshError({
            stage: "normalize",
            url: documentUrl,
            reason: errorMessage(error),
          }),
  });
  const upstreamRelationships = yield* fetchAllPages(http, relationshipUrl);

  return yield* Effect.try({
    try: () => normalizeRelationships(documents, upstreamRelationships, relationshipUrl),
    catch: (error) =>
      error instanceof CatalogRefreshError
        ? error
        : new CatalogRefreshError({
            stage: "normalize",
            url: relationshipUrl,
            reason: errorMessage(error),
          }),
  });
});

const makeDatatrackerCatalogSourceLayer = (
  baseUrl: string,
): Layer.Layer<DatatrackerCatalogSource, never, HttpClient.HttpClient> =>
  Layer.effect(
    DatatrackerCatalogSource,
    Effect.gen(function* () {
      const http = yield* HttpClient.HttpClient;
      return DatatrackerCatalogSource.of({
        refresh: () => refreshFromDatatracker(http, baseUrl),
      });
    }),
  );

/**
 * Create a source layer backed by a deterministic in-memory catalog source.
 *
 * @param source A promise-returning source used instead of Datatracker.
 * @returns A layer suitable for Effect-based tests and embedded callers.
 */
export const makeCatalogSourceLayer = (
  source: CatalogSource,
): Layer.Layer<DatatrackerCatalogSource> =>
  Layer.succeed(
    DatatrackerCatalogSource,
    DatatrackerCatalogSource.of({
      refresh: () =>
        Effect.tryPromise({
          try: source,
          catch: (error) =>
            new CatalogRefreshError({
              stage: "request",
              url: "in-memory://catalog",
              reason: errorMessage(error),
            }),
        }),
    }),
  );

const decodeCatalog = (catalogPath: string, contents: string): RfcCatalog => {
  try {
    const catalog = Schema.decodeUnknownSync(RfcCatalogSchema)(JSON.parse(contents));
    if (!Number.isFinite(Date.parse(catalog.fetchedAt))) {
      throw new Error("The catalog fetchedAt value is not a valid timestamp");
    }
    return catalog;
  } catch (error) {
    if (error instanceof CatalogReadError) {
      throw error;
    }
    throw new CatalogReadError({
      catalogPath,
      reason: "The catalog contents are malformed or use an unsupported schema",
    });
  }
};

const catalogRead = Effect.fnUntraced(function* (
  catalogPath: string,
): Effect.fn.Return<RfcCatalog | undefined, CatalogReadError, FileSystem.FileSystem> {
  const fileSystem = yield* FileSystem.FileSystem;
  const contents = yield* fileSystem.readFileString(catalogPath).pipe(
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

  if (contents === undefined) {
    return undefined;
  }

  return yield* Effect.try({
    try: () => decodeCatalog(catalogPath, contents),
    catch: (error) =>
      error instanceof CatalogReadError
        ? error
        : new CatalogReadError({
            catalogPath,
            reason: "The catalog contents are malformed or use an unsupported schema",
          }),
  });
});

const makeCatalogStatus = Effect.fnUntraced(function* (
  catalogPath: string,
  catalog: RfcCatalog | undefined,
  kind: "catalog_status" | "catalog_refresh",
): Effect.fn.Return<CatalogStatus | CatalogRefreshResult> {
  if (catalog === undefined) {
    return {
      schemaVersion: 1,
      kind,
      state: "missing",
      catalogPath,
      cacheIdentity: catalogCacheIdentity,
      fetchedAt: null,
      refreshedAt: null,
      ageMs: null,
      documentCount: 0,
    } as CatalogStatus | CatalogRefreshResult;
  }

  const now = yield* Clock.currentTimeMillis;
  const ageMs = Math.max(0, now - Date.parse(catalog.fetchedAt));
  const state: CatalogStatus["state"] = ageMs <= catalogMaxAgeMilliseconds ? "fresh" : "stale";
  const result = {
    schemaVersion: 1 as const,
    state,
    catalogPath,
    cacheIdentity: catalog.cacheIdentity,
    fetchedAt: catalog.fetchedAt,
    refreshedAt: catalog.fetchedAt,
    ageMs,
    documentCount: catalog.documents.length,
  };

  return kind === "catalog_refresh"
    ? { ...result, kind: "catalog_refresh" }
    : { ...result, kind: "catalog_status" };
});

const catalogStatus = Effect.fnUntraced(function* (
  catalogPath: string,
): Effect.fn.Return<CatalogStatus, CatalogReadError, FileSystem.FileSystem> {
  const catalog = yield* catalogRead(catalogPath);
  const result = yield* makeCatalogStatus(catalogPath, catalog, "catalog_status");
  return result as CatalogStatus;
});

const catalogWrite = Effect.fnUntraced(function* (
  catalogPath: string,
  catalog: RfcCatalog,
): Effect.fn.Return<void, CatalogWriteError, FileSystem.FileSystem> {
  const fileSystem = yield* FileSystem.FileSystem;
  const temporaryPath = `${catalogPath}.tmp-${crypto.randomUUID()}`;
  const contents = `${JSON.stringify(catalog, null, 2)}\n`;
  const cleanup = fileSystem
    .remove(temporaryPath, { force: true })
    .pipe(Effect.catch(() => Effect.void));

  return yield* Effect.gen(function* () {
    yield* fileSystem.makeDirectory(dirname(catalogPath), { recursive: true });
    yield* fileSystem.writeFileString(temporaryPath, contents);
    yield* fileSystem.rename(temporaryPath, catalogPath);
  }).pipe(
    Effect.mapError(
      (error) =>
        new CatalogWriteError({
          catalogPath,
          reason: errorMessage(error),
        }),
    ),
    Effect.ensuring(cleanup),
  );
});

/**
 * Default catalog storage implementation backed by the Effect filesystem.
 */
export const catalogStoreLayer: Layer.Layer<CatalogStore> = Layer.succeed(
  CatalogStore,
  CatalogStore.of({
    read: catalogRead,
    status: catalogStatus,
    write: catalogWrite,
  }),
);

/**
 * Build the default Datatracker source layer for a client.
 *
 * @param baseUrl Datatracker API base URL.
 * @returns A source layer requiring the configured HTTP client.
 */
export const makeDefaultCatalogSourceLayer = (
  baseUrl: string,
): Layer.Layer<DatatrackerCatalogSource, never, HttpClient.HttpClient> =>
  makeDatatrackerCatalogSourceLayer(baseUrl);

/**
 * Assemble a normalized catalog with a current fetched timestamp.
 *
 * @param documents Normalized published RFC documents.
 * @param now Current time in milliseconds.
 * @returns A schema-valid version-one catalog.
 */
export const makeCatalog = (documents: ReadonlyArray<CatalogDocument>, now: number): RfcCatalog =>
  Schema.decodeUnknownSync(RfcCatalogSchema)({
    schemaVersion: 1,
    kind: "rfc_catalog",
    cacheIdentity: catalogCacheIdentity,
    fetchedAt: new Date(now).toISOString(),
    documents,
  });

/**
 * Produce a catalog status from a decoded catalog and current clock.
 *
 * @param catalogPath The cache path represented by the status.
 * @param catalog The decoded catalog, or undefined when the cache is missing.
 * @param now Current time in milliseconds.
 * @returns A fresh, stale, or missing catalog status.
 */
export const catalogStatusFromValue = (
  catalogPath: string,
  catalog: RfcCatalog | undefined,
  now: number,
): CatalogStatus => {
  if (catalog === undefined) {
    return {
      schemaVersion: 1,
      kind: "catalog_status",
      state: "missing",
      catalogPath,
      cacheIdentity: catalogCacheIdentity,
      fetchedAt: null,
      refreshedAt: null,
      ageMs: null,
      documentCount: 0,
    };
  }

  const ageMs = Math.max(0, now - Date.parse(catalog.fetchedAt));
  return {
    schemaVersion: 1,
    kind: "catalog_status",
    state: ageMs <= catalogMaxAgeMilliseconds ? "fresh" : "stale",
    catalogPath,
    cacheIdentity: catalog.cacheIdentity,
    fetchedAt: catalog.fetchedAt,
    refreshedAt: catalog.fetchedAt,
    ageMs,
    documentCount: catalog.documents.length,
  };
};

/**
 * Read a catalog through the storage service and require seven-day freshness.
 *
 * @param catalogPath The cache path to inspect.
 * @returns A fresh catalog suitable for research.
 */
export const readFreshCatalog = Effect.fnUntraced(function* (
  catalogPath: string,
): Effect.fn.Return<RfcCatalog, CatalogReadError | CatalogStaleError, FileSystem.FileSystem> {
  const catalog = yield* catalogRead(catalogPath);
  if (catalog === undefined) {
    return yield* new CatalogStaleError({
      catalogPath,
      fetchedAt: "",
      ageMs: Number.POSITIVE_INFINITY,
    });
  }

  const now = yield* Clock.currentTimeMillis;
  const status = catalogStatusFromValue(catalogPath, catalog, now);
  if (status.state !== "fresh") {
    return yield* new CatalogStaleError({
      catalogPath,
      fetchedAt: catalog.fetchedAt,
      ageMs: status.ageMs ?? Number.POSITIVE_INFINITY,
    });
  }

  return catalog;
});

/**
 * Build a catalog refresh result from a freshly persisted catalog.
 *
 * @param catalogPath The cache path represented by the result.
 * @param catalog The catalog that was written.
 * @param now Current time in milliseconds.
 * @returns A versioned refresh result.
 */
export const catalogRefreshResultFromValue = (
  catalogPath: string,
  catalog: RfcCatalog,
  now: number,
): CatalogRefreshResult => {
  const status = catalogStatusFromValue(catalogPath, catalog, now);
  return {
    ...status,
    kind: "catalog_refresh",
  };
};

/**
 * Read a catalog through the default store service.
 *
 * @param catalogPath The cache path to inspect.
 * @returns The decoded catalog or undefined when no cache exists.
 */
export const readCatalog = catalogRead;

/**
 * Return the default store layer for consumers that need to compose an Effect program.
 */
export const makeCatalogStoreLayer = (): Layer.Layer<CatalogStore> => catalogStoreLayer;

/**
 * Normalize a Datatracker document page and relationship page into catalog documents.
 *
 * @param documentValues Raw Datatracker document records.
 * @param relationshipValues Raw Datatracker relationship records.
 * @returns Deduplicated, relationship-aware catalog documents.
 */
export const normalizeCatalogDocuments = (
  documentValues: ReadonlyArray<unknown>,
  relationshipValues: ReadonlyArray<unknown>,
): ReadonlyArray<CatalogDocument> => {
  const documents = normalizeDocuments(documentValues, "in-memory://documents");
  return normalizeRelationships(documents, relationshipValues, "in-memory://relationships");
};
