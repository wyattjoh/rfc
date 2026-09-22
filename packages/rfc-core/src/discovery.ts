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
  Random,
  Result,
  Schema,
  Stream,
} from "effect";
import { Headers, HttpClient, HttpClientError, HttpClientResponse } from "effect/unstable/http";
import {
  metadataFreshnessMilliseconds,
  readFreshMetadata,
  writeFreshMetadata,
} from "./metadata-cache";
import type { RfcMetadata } from "./metadata";
import { datatrackerTopicSearchTermLimit } from "./protocol";

export type { RfcMetadata } from "./metadata";
export {
  datatrackerTopicSearchTermLimit,
  datatrackerTopicSearchTermMaximumCharacters,
} from "./protocol";

/**
 * Default anonymous Datatracker v1 API root.
 */
export const defaultDatatrackerApiUrl = "https://datatracker.ietf.org/api/v1/";

/**
 * One RFC admitted to semantic document selection for a topic request.
 */
export type DocumentCandidate = RfcMetadata;

/**
 * Maximum number of attempts for one required Datatracker request.
 */
export const datatrackerMaxAttempts = 3;

/**
 * Maximum elapsed time for one complete Datatracker fetch/decode/retry operation.
 */
export const datatrackerRequestDeadlineMilliseconds = 10_000;

/**
 * Maximum bytes accepted from one Datatracker JSON response.
 */
export const datatrackerMaximumResponseBytes = 1024 * 1024;

/**
 * Maximum successor relationship rows requested for one RFC.
 */
export const datatrackerSuccessorLimit = 64;

/**
 * Maximum number of rows requested for one topic-search stream.
 */
export const datatrackerTopicResultLimit = 20;

/**
 * Maximum Datatracker requests issued by one topic discovery.
 */
export const datatrackerTopicRequestLimit = datatrackerTopicSearchTermLimit * 2;

/**
 * Maximum simultaneous Datatracker requests issued by topic discovery.
 */
export const datatrackerTopicConcurrencyLimit = 4;

/**
 * Maximum upstream rows admitted across one topic discovery.
 */
export const datatrackerTopicUpstreamRowLimit =
  datatrackerTopicRequestLimit * datatrackerTopicResultLimit;

/**
 * Maximum number of merged document candidates returned by live discovery.
 */
export const datatrackerDocumentCandidateLimit = 32;

/**
 * Maximum number of RFC contexts visited during live currency traversal.
 */
export const datatrackerCurrencyContextLimit = 8;

/**
 * Maximum successor depth visited during live currency traversal.
 */
export const datatrackerCurrencyDepthLimit = 16;

const boundedCurrencyDepthLimit = (limit: number | undefined): number =>
  limit !== undefined && Number.isSafeInteger(limit) && limit >= 0
    ? Math.min(limit, datatrackerCurrencyDepthLimit)
    : datatrackerCurrencyDepthLimit;

const TraversalBoundedExitSchema = Schema.Literals([
  "depth_limit",
  "context_limit",
  "relationship_limit",
]);

type TraversalBoundedExit = Schema.Schema.Type<typeof TraversalBoundedExitSchema>;

const traversalBoundedExitOrder: ReadonlyArray<TraversalBoundedExit> = [
  "depth_limit",
  "context_limit",
  "relationship_limit",
];

/**
 * One request-local upstream request trace.
 */
export const RetrievalRequestTraceSchema = Schema.Struct({
  kind: Schema.Literals(["metadata", "relationships", "source"]),
  url: Schema.NonEmptyString,
  attempts: Schema.Natural,
  status: Schema.NullOr(Schema.Natural),
  statuses: Schema.Array(Schema.NullOr(Schema.Natural)),
  durationMs: Schema.Number,
  /**
   * Whether the response came from the metadata cache instead of upstream.
   *
   * The entry is still recorded so the trace continues to describe the shape
   * of the traversal, but it made no upstream attempt and so carries none.
   */
  cached: Schema.optionalKey(Schema.Boolean),
});

/**
 * A request-local upstream request trace.
 */
export type RetrievalRequestTrace = Schema.Schema.Type<typeof RetrievalRequestTraceSchema>;

/**
 * Live retrieval diagnostics for a schema-version-two research request.
 *
 * Request counts describe logical trace entries. Each entry records its own
 * bounded upstream attempt count and status sequence independently.
 */
export const LiveRetrievalTraceSchema = Schema.Struct({
  schemaVersion: Schema.Literal(2),
  requestCount: Schema.Natural,
  datatrackerRequestCount: Schema.Natural,
  sourceRequestCount: Schema.Natural,
  metadataMs: Schema.Number,
  sourceMs: Schema.Number,
  sourceCacheOutcome: Schema.Literals([
    "hit",
    "miss",
    "revalidated",
    "replaced",
    "repaired",
    "not_requested",
  ]),
  upstreamRows: Schema.optionalKey(Schema.Natural),
  uniqueCandidates: Schema.optionalKey(Schema.Natural),
  mergeLimit: Schema.optionalKey(Schema.Natural),
  semanticCandidates: Schema.optionalKey(Schema.Natural),
  selectedSources: Schema.optionalKey(Schema.Natural),
  topicTruncated: Schema.optionalKey(Schema.Boolean),
  traversalComplete: Schema.optionalKey(Schema.Boolean),
  traversalContexts: Schema.optionalKey(Schema.Natural),
  traversalDepth: Schema.optionalKey(Schema.Natural),
  successorRows: Schema.optionalKey(Schema.Natural),
  boundedExits: Schema.optionalKey(Schema.Array(TraversalBoundedExitSchema)),
  contextLimit: Schema.optionalKey(Schema.Natural),
  depthLimit: Schema.optionalKey(Schema.Natural),
  relationshipLimit: Schema.optionalKey(Schema.Natural),
  requests: Schema.Array(RetrievalRequestTraceSchema),
});

/**
 * Live retrieval diagnostics for a schema-version-two research request.
 */
export type LiveRetrievalTrace = Schema.Schema.Type<typeof LiveRetrievalTraceSchema>;

/**
 * Schema for relationship-free RFC metadata exposed by version two.
 */
export const RfcDocumentSchema = Schema.Struct({
  identifier: Schema.NonEmptyString.check(Schema.isMaxLength(64)),
  rfcNumber: Schema.Int.check(Schema.isGreaterThan(0)),
  title: Schema.String.check(Schema.isMaxLength(2_000)),
  abstract: Schema.String.check(Schema.isMaxLength(100_000)),
  status: Schema.NonEmptyString.check(Schema.isMaxLength(256)),
  stream: Schema.NonEmptyString.check(Schema.isMaxLength(256)),
  canonicalUrl: Schema.NonEmptyString.check(Schema.isMaxLength(2_048)),
}).check(
  // The identifier and number describe the same RFC, so a document that pairs
  // them inconsistently cannot satisfy the version-two contract.
  Schema.makeFilter((document) =>
    document.identifier === `RFC${document.rfcNumber}`
      ? undefined
      : {
          path: ["identifier"],
          issue: "identifier must be RFC followed by its RFC number",
        },
  ),
);

/**
 * Request-local RFC metadata exposed through the version-two public facade.
 */
export type RfcDocument = Schema.Schema.Type<typeof RfcDocumentSchema>;

/**
 * Typed failure from a required request-local Datatracker operation.
 */
export class RfcDiscoveryError extends Schema.TaggedError<RfcDiscoveryError>()(
  "RfcDiscoveryError",
  {
    stage: Schema.Literals(["request", "decode"]),
    url: Schema.String,
    reason: Schema.String,
    attempts: Schema.Natural,
  },
) {}

/**
 * Request-local exact RFC metadata without relationship traversal.
 */
export interface LiveExactRfcLookup {
  /**
   * Exact normalized metadata for the requested published RFC.
   */
  readonly document: RfcMetadata;
  /**
   * Datatracker request traces produced by this lookup.
   */
  readonly requests: ReadonlyArray<RetrievalRequestTrace>;
  /**
   * Total time spent retrieving and decoding metadata.
   */
  readonly metadataMs: number;
}

/**
 * Request-local exact RFC metadata and bounded successor information.
 */
export interface LiveRfcLookup {
  /**
   * Exact normalized metadata for the requested published RFC.
   */
  readonly document: RfcMetadata;
  /**
   * Request-local metadata for every RFC visited during bounded currency traversal.
   */
  readonly documents: ReadonlyArray<RfcMetadata>;
  /**
   * Whether every discovered successor fit within traversal bounds.
   */
  readonly traversalComplete: boolean;
  /**
   * Number of RFC contexts visited during traversal.
   */
  readonly traversalContexts: number;
  /**
   * Greatest successor depth visited from the requested RFC.
   */
  readonly traversalDepth: number;
  /**
   * Effective successor depth limit, never above the production hard maximum.
   */
  readonly depthLimit: number;
  /**
   * Number of successor relationship rows observed.
   */
  readonly successorRows: number;
  /**
   * Hard traversal bounds that prevented complete successor coverage.
   */
  readonly boundedExits: ReadonlyArray<TraversalBoundedExit>;
  /**
   * Datatracker request traces produced by this lookup.
   */
  readonly requests: ReadonlyArray<RetrievalRequestTrace>;
  /**
   * Total time spent retrieving and decoding metadata.
   */
  readonly metadataMs: number;
}

/**
 * Request-local topic-discovery candidates and diagnostics.
 */
export interface LiveTopicDiscovery {
  /**
   * Deterministically merged RFC metadata candidates.
   */
  readonly documents: ReadonlyArray<RfcMetadata>;
  /**
   * Datatracker request traces produced by topic discovery.
   */
  readonly requests: ReadonlyArray<RetrievalRequestTrace>;
  /**
   * Number of rows returned before RFC deduplication.
   */
  readonly upstreamRows: number;
  /**
   * Number of distinct RFCs observed before applying the semantic merge cap.
   */
  readonly uniqueCandidates: number;
  /**
   * Whether a bounded query or the deterministic merge reported omitted candidates.
   */
  readonly truncated: boolean;
  /**
   * Total time spent retrieving and merging candidates.
   */
  readonly metadataMs: number;
}

/**
 * Service for bounded request-local RFC discovery.
 */
export interface RfcDiscoveryService {
  /**
   * Retrieve exact metadata without relationship traversal.
   */
  readonly lookupExactRfc: (
    identifier: string,
  ) => Effect.Effect<LiveExactRfcLookup, RfcDiscoveryError, FileSystem.FileSystem | Path.Path>;
  /**
   * Retrieve exact metadata and recursively traverse successor relationships.
   */
  readonly lookupKnownRfc: (
    identifier: string,
  ) => Effect.Effect<LiveRfcLookup, RfcDiscoveryError, FileSystem.FileSystem | Path.Path>;
  /**
   * Discover bounded RFC candidates for ordered caller-supplied terms.
   */
  readonly discoverTopic: (
    searchTerms: ReadonlyArray<string>,
  ) => Effect.Effect<LiveTopicDiscovery, RfcDiscoveryError, FileSystem.FileSystem | Path.Path>;
}

/**
 * Effect service tag for bounded request-local RFC discovery.
 */
export class RfcDiscovery extends Context.Service<RfcDiscovery, RfcDiscoveryService>()(
  "rfc-core/RfcDiscovery",
) {}

const DatatrackerNameSchema = Schema.NonEmptyString.check(Schema.isMaxLength(64));
const DatatrackerReferenceSchema = Schema.NonEmptyString.check(Schema.isMaxLength(2_048));
const DatatrackerOptionalNameSchema = Schema.NonEmptyString.check(Schema.isMaxLength(256));

const DatatrackerDocumentSchema = Schema.Struct({
  name: DatatrackerNameSchema,
  rfc_number: Schema.Natural,
  title: Schema.String.check(Schema.isMaxLength(2_000)),
  abstract: Schema.String.check(Schema.isMaxLength(100_000)),
  stream: DatatrackerReferenceSchema,
  status: Schema.optionalKey(Schema.NullOr(DatatrackerOptionalNameSchema)),
  state: Schema.optionalKey(Schema.NullOr(DatatrackerOptionalNameSchema)),
  resource_uri: Schema.optionalKey(DatatrackerReferenceSchema),
  states: Schema.optionalKey(
    Schema.Array(DatatrackerReferenceSchema).check(Schema.isMaxLength(64)),
  ),
});

type DatatrackerDocument = Schema.Schema.Type<typeof DatatrackerDocumentSchema>;

/**
 * Whether one decoded document identifies a published RFC.
 *
 * `Schema.Natural` admits zero, and nothing in the payload ties `name` to
 * `rfc_number`, so both are verified here: a published RFC has a positive safe
 * number and a canonical `rfc<number>` name. A mismatch means the row does not
 * describe the RFC it claims to, so it is rejected rather than researched.
 */
const isPublishedRfcDocument = (document: DatatrackerDocument): boolean =>
  Number.isSafeInteger(document.rfc_number) &&
  document.rfc_number > 0 &&
  document.name.toLowerCase() === `rfc${document.rfc_number}`;

const DatatrackerRelationshipSchema = Schema.Struct({
  source: DatatrackerReferenceSchema,
  target: DatatrackerReferenceSchema,
  relationship: DatatrackerReferenceSchema,
});

type DatatrackerRelationship = Schema.Schema.Type<typeof DatatrackerRelationshipSchema>;

const DatatrackerRelationshipPageSchema = Schema.Struct({
  meta: Schema.Struct({
    next: Schema.NullOr(Schema.String.check(Schema.isMaxLength(4_096))),
    total_count: Schema.Natural,
  }),
  objects: Schema.Array(DatatrackerRelationshipSchema),
});

type DatatrackerRelationshipPage = Schema.Schema.Type<typeof DatatrackerRelationshipPageSchema>;

const DatatrackerDocumentPageSchema = Schema.Struct({
  meta: Schema.Struct({
    next: Schema.NullOr(Schema.String.check(Schema.isMaxLength(4_096))),
    total_count: Schema.Natural,
  }),
  objects: Schema.Array(DatatrackerDocumentSchema),
});

type DatatrackerDocumentPage = Schema.Schema.Type<typeof DatatrackerDocumentPageSchema>;

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : "The upstream operation failed";

const lastPathSegment = (value: string): string => {
  const withoutQuery = value.split("?", 1)[0] ?? value;
  const trimmed = withoutQuery.replace(/\/+$/, "");
  return trimmed.slice(trimmed.lastIndexOf("/") + 1).toLowerCase();
};

const identifierFromReference = (value: string): string | undefined => {
  const match = /^rfc([1-9]\d*)$/.exec(lastPathSegment(value));
  return match === null ? undefined : `RFC${match[1]}`;
};

const streamFromReference = (value: string): string => lastPathSegment(value) || "unknown";

const statusFromDocument = (document: DatatrackerDocument): string => {
  const explicitStatus = document.status ?? document.state;
  if (explicitStatus !== undefined && explicitStatus !== null) {
    const status = lastPathSegment(explicitStatus);
    if (status.length > 0 && !/^\d+$/.test(status)) return status;
  }

  return (
    document.states
      ?.map(lastPathSegment)
      // Reporting "published" here would assert a state Datatracker did not
      // return. "unknown" matches the fallback used for an absent stream.
      .find((status) => status.length > 0 && !/^\d+$/.test(status)) ?? "unknown"
  );
};

const normalizeRfcName = (value: string): string | undefined => {
  const match = /^(?:rfc\s*)?([1-9]\d*)$/i.exec(value.trim());
  if (match === null) return undefined;
  const number = Number(match[1]);
  return Number.isSafeInteger(number) && number > 0 ? `rfc${number}` : undefined;
};

const makeExactDocumentUrl = (baseUrl: string, name: string): string => {
  const base = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  const url = new URL(`doc/document/${name}/`, base);
  url.searchParams.set("format", "json");
  return url.toString();
};

const makeTopicUrl = (baseUrl: string, term: string, field: "title" | "abstract"): string => {
  const base = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  const url = new URL("doc/document/", base);
  url.searchParams.set("format", "json");
  url.searchParams.set("limit", String(datatrackerTopicResultLimit));
  url.searchParams.set("offset", "0");
  // Datatracker permits list ordering only by document id; descending ids are
  // its supported newest-first RFC stream.
  url.searchParams.set("order_by", "-id");
  url.searchParams.set("type__slug", "rfc");
  url.searchParams.set(`${field}__icontains`, term);
  return url.toString();
};

const makeSuccessorUrl = (baseUrl: string, name: string): string => {
  const base = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  const url = new URL("doc/relateddocument/", base);
  url.searchParams.set("format", "json");
  url.searchParams.set("limit", String(datatrackerSuccessorLimit));
  url.searchParams.set("offset", "0");
  url.searchParams.set("relationship__slug__in", "obs,updates");
  url.searchParams.set("target__name", name);
  return url.toString();
};

const isTransientStatus = (status: number): boolean =>
  status === 408 || status === 429 || (status >= 500 && status <= 599);

const retryAfterMilliseconds = (
  response: HttpClientResponse.HttpClientResponse,
  now: number,
): number | undefined => {
  const value = Option.getOrUndefined(Headers.get("retry-after")(response.headers));
  if (value === undefined || value.trim().length === 0) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000;
  const date = Date.parse(value);
  if (!Number.isFinite(date)) return undefined;
  return Math.max(0, date - now);
};

const retryDelayMilliseconds = Effect.fnUntraced(function* (
  response: HttpClientResponse.HttpClientResponse | undefined,
  attempt: number,
) {
  const now = yield* Clock.currentTimeMillis;
  const retryAfter = response === undefined ? undefined : retryAfterMilliseconds(response, now);
  if (retryAfter !== undefined) return retryAfter;
  const jitter = yield* Random.next;
  const exponential = 100 * 2 ** Math.max(0, attempt - 1);
  return Math.round(exponential * (0.5 + jitter * 0.5));
});

type FetchedJson = {
  readonly value: unknown;
  readonly trace: RetrievalRequestTrace;
  readonly headers: Headers.Headers | undefined;
};

type RequestDeadline = {
  readonly startedAt: number;
  elapsedFloor: number;
};

type FetchState = {
  attempts: number;
  readonly deadline: RequestDeadline;
};

const readBoundedJson = Effect.fnUntraced(function* (
  response: HttpClientResponse.HttpClientResponse,
  url: string,
  attempts: number,
): Effect.fn.Return<unknown, RfcDiscoveryError> {
  const contentLengthValue = Option.getOrUndefined(Headers.get("content-length")(response.headers));
  if (contentLengthValue !== undefined) {
    const contentLength = Number(contentLengthValue);
    if (!Number.isSafeInteger(contentLength) || contentLength < 0) {
      return yield* new RfcDiscoveryError({
        stage: "decode",
        url,
        reason: "Datatracker returned an invalid Content-Length",
        attempts,
      });
    }
    if (contentLength > datatrackerMaximumResponseBytes) {
      return yield* new RfcDiscoveryError({
        stage: "decode",
        url,
        reason: `Datatracker metadata exceeds ${datatrackerMaximumResponseBytes} bytes`,
        attempts,
      });
    }
  }

  const body = yield* response.stream.pipe(
    Stream.runFoldEffect(
      () => ({ size: 0, chunks: [] as Array<Uint8Array> }),
      (state, chunk) => {
        const size = state.size + chunk.byteLength;
        if (size > datatrackerMaximumResponseBytes) {
          return Effect.fail(
            new RfcDiscoveryError({
              stage: "decode",
              url,
              reason: `Datatracker metadata exceeds ${datatrackerMaximumResponseBytes} bytes`,
              attempts,
            }),
          );
        }
        state.chunks.push(chunk);
        return Effect.succeed({ size, chunks: state.chunks });
      },
    ),
    Effect.mapError((error) =>
      error instanceof RfcDiscoveryError
        ? error
        : new RfcDiscoveryError({
            stage: "decode",
            url,
            reason: errorMessage(error),
            attempts,
          }),
    ),
  );

  const bytes = Buffer.concat(
    body.chunks.map((chunk) => Buffer.from(chunk)),
    body.size,
  );
  return yield* Effect.try({
    // Titles and abstracts reach semantic selection verbatim, so malformed bytes
    // must fail rather than be silently rewritten with U+FFFD.
    try: () => JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
    catch: () =>
      new RfcDiscoveryError({
        stage: "decode",
        url,
        reason: "Datatracker returned malformed JSON metadata",
        attempts,
      }),
  });
});

const fetchJsonWithinDeadline = Effect.fnUntraced(function* (
  http: HttpClient.HttpClient,
  url: string,
  kind: "metadata" | "relationships",
  state: FetchState,
): Effect.fn.Return<FetchedJson, RfcDiscoveryError> {
  const operationStartedAt = yield* Clock.currentTimeMillis;
  let scheduledDelay = 0;
  let lastStatus: number | null = null;
  const statuses: Array<number | null> = [];

  for (let attempt = 1; attempt <= datatrackerMaxAttempts; attempt += 1) {
    state.attempts = attempt;
    const attemptStartedAt = yield* Clock.currentTimeMillis;
    const elapsedBeforeAttempt = Math.max(
      0,
      attemptStartedAt - state.deadline.startedAt,
      state.deadline.elapsedFloor,
    );
    if (elapsedBeforeAttempt >= datatrackerRequestDeadlineMilliseconds) {
      return yield* new RfcDiscoveryError({
        stage: "request",
        url,
        reason: "Datatracker request deadline was exhausted before the next attempt",
        attempts: attempt - 1,
      });
    }

    const remaining = datatrackerRequestDeadlineMilliseconds - elapsedBeforeAttempt;
    const requestResult = yield* Effect.result(
      Effect.gen(function* () {
        const response = yield* http.get(url);
        const responseUrl = response.url || url;
        const responseOrigin = yield* Effect.try({
          try: () => new URL(responseUrl).origin,
          catch: () =>
            new RfcDiscoveryError({
              stage: "request",
              url: responseUrl,
              reason: "Datatracker returned an invalid response URL",
              attempts: attempt,
            }),
        });
        if (responseOrigin !== new URL(url).origin) {
          return yield* new RfcDiscoveryError({
            stage: "request",
            url: responseUrl,
            reason: "Datatracker redirected outside the configured API origin",
            attempts: attempt,
          });
        }
        if (response.status < 200 || response.status >= 300) {
          return { response, value: undefined } as const;
        }

        const value = yield* readBoundedJson(response, url, attempt);
        return { response, value } as const;
      }).pipe(Effect.timeout(Duration.millis(remaining))),
    );
    if (Result.isFailure(requestResult)) {
      statuses.push(null);
      const failure = requestResult.failure;
      if (failure instanceof RfcDiscoveryError) return yield* failure;
      const transient =
        Cause.isTimeoutError(failure) ||
        (HttpClientError.isHttpClientError(failure) && failure.reason._tag === "TransportError");
      if (!transient || attempt >= datatrackerMaxAttempts) {
        return yield* new RfcDiscoveryError({
          stage: transient ? "request" : "decode",
          url,
          reason: transient
            ? `Datatracker retry budget exhausted after ${attempt} attempts`
            : errorMessage(failure),
          attempts: attempt,
        });
      }
      const delay = yield* retryDelayMilliseconds(undefined, attempt);
      const failureObservedAt = yield* Clock.currentTimeMillis;
      const elapsedAtFailure = Math.max(
        failureObservedAt - state.deadline.startedAt,
        state.deadline.elapsedFloor,
      );
      if (elapsedAtFailure + delay >= datatrackerRequestDeadlineMilliseconds) {
        return yield* new RfcDiscoveryError({
          stage: "request",
          url,
          reason: `Datatracker retry deadline exhausted after ${attempt} attempts`,
          attempts: attempt,
        });
      }
      state.deadline.elapsedFloor = elapsedAtFailure + delay;
      yield* Effect.sleep(Duration.millis(delay));
      scheduledDelay += delay;
      continue;
    }

    const { response, value } = requestResult.success;
    lastStatus = response.status;
    statuses.push(response.status);
    if (isTransientStatus(response.status)) {
      const delay = yield* retryDelayMilliseconds(response, attempt);
      const responseObservedAt = yield* Clock.currentTimeMillis;
      const elapsedAtResponse = Math.max(
        responseObservedAt - state.deadline.startedAt,
        state.deadline.elapsedFloor,
      );
      if (
        attempt >= datatrackerMaxAttempts ||
        elapsedAtResponse + delay >= datatrackerRequestDeadlineMilliseconds
      ) {
        return yield* new RfcDiscoveryError({
          stage: "request",
          url,
          reason: `Datatracker retry budget exhausted after ${attempt} attempts (HTTP ${response.status})`,
          attempts: attempt,
        });
      }
      state.deadline.elapsedFloor = elapsedAtResponse + delay;
      yield* Effect.sleep(Duration.millis(delay));
      scheduledDelay += delay;
      continue;
    }

    if (response.status < 200 || response.status >= 300) {
      return yield* new RfcDiscoveryError({
        stage: "request",
        url,
        reason: `Datatracker returned HTTP ${response.status}`,
        attempts: attempt,
      });
    }

    const finishedAt = yield* Clock.currentTimeMillis;
    state.deadline.elapsedFloor = Math.max(
      state.deadline.elapsedFloor,
      finishedAt - state.deadline.startedAt,
    );
    return {
      value,
      headers: response.headers,
      trace: {
        kind,
        url,
        attempts: attempt,
        status: response.status,
        statuses,
        durationMs: Math.max(0, finishedAt - operationStartedAt, scheduledDelay),
      },
    };
  }

  return yield* new RfcDiscoveryError({
    stage: "request",
    url,
    reason: `Datatracker retry policy ended after ${datatrackerMaxAttempts} attempts (HTTP ${lastStatus ?? "unknown"})`,
    attempts: datatrackerMaxAttempts,
  });
});

const fetchJson = Effect.fnUntraced(function* (
  http: HttpClient.HttpClient,
  url: string,
  kind: "metadata" | "relationships",
  metadataDirectory: string | undefined,
): Effect.fn.Return<FetchedJson, RfcDiscoveryError, FileSystem.FileSystem | Path.Path> {
  const startedAt = yield* Clock.currentTimeMillis;
  // A response still inside the window Datatracker declared for it is reused
  // without a request. Currency traversal issues two requests per RFC across
  // up to eight contexts, all sequential, so this is the difference between a
  // warm request costing one round trip and costing sixteen.
  if (metadataDirectory !== undefined) {
    const cached = yield* readFreshMetadata(metadataDirectory, url);
    if (cached !== undefined) {
      const finishedAt = yield* Clock.currentTimeMillis;
      return {
        value: cached,
        headers: undefined,
        trace: {
          kind,
          url,
          attempts: 0,
          status: null,
          statuses: [],
          durationMs: Math.max(0, finishedAt - startedAt),
          cached: true,
        },
      };
    }
  }
  const fetched = yield* fetchJsonWithinDeadline(http, url, kind, {
    attempts: 0,
    deadline: { startedAt, elapsedFloor: 0 },
  });
  if (metadataDirectory !== undefined && fetched.headers !== undefined) {
    const freshness = metadataFreshnessMilliseconds(fetched.headers);
    if (freshness !== undefined) {
      yield* writeFreshMetadata(metadataDirectory, url, fetched.value, freshness);
    }
  }
  return fetched;
});

const decodeDocument = (
  value: unknown,
  url: string,
  attempts: number,
): Effect.Effect<DatatrackerDocument, RfcDiscoveryError> =>
  Effect.try({
    try: () => {
      const document = Schema.decodeUnknownSync(DatatrackerDocumentSchema)(value);
      if (!isPublishedRfcDocument(document)) {
        throw new Error("Datatracker metadata does not identify a published RFC");
      }
      return document;
    },
    catch: () =>
      new RfcDiscoveryError({
        stage: "decode",
        url,
        reason: "Datatracker returned incomplete exact RFC metadata",
        attempts,
      }),
  });

const decodeRelationships = (
  value: unknown,
  url: string,
  attempts: number,
): Effect.Effect<DatatrackerRelationshipPage, RfcDiscoveryError> =>
  Effect.try({
    try: () => {
      const page = Schema.decodeUnknownSync(DatatrackerRelationshipPageSchema)(value);
      if (
        page.objects.length > datatrackerSuccessorLimit ||
        page.meta.total_count < page.objects.length
      ) {
        throw new Error("successor relationship response exceeded its bound");
      }
      return page;
    },
    catch: () =>
      new RfcDiscoveryError({
        stage: "decode",
        url,
        reason: "Datatracker returned malformed or unbounded successor relationships",
        attempts,
      }),
  });

const decodeDocumentPage = (
  value: unknown,
  url: string,
  attempts: number,
): Effect.Effect<DatatrackerDocumentPage, RfcDiscoveryError> =>
  Effect.try({
    try: () => {
      const page = Schema.decodeUnknownSync(DatatrackerDocumentPageSchema)(value);
      if (
        page.objects.length > datatrackerTopicResultLimit ||
        page.meta.total_count < page.objects.length
      ) {
        throw new Error("topic response exceeded its bound");
      }
      if (!page.objects.every(isPublishedRfcDocument)) {
        throw new Error("Datatracker metadata does not identify a published RFC");
      }
      return page;
    },
    catch: () =>
      new RfcDiscoveryError({
        stage: "decode",
        url,
        reason: "Datatracker returned malformed or unbounded topic metadata",
        attempts,
      }),
  });

const normalizeDocument = (
  document: DatatrackerDocument,
  relationships: ReadonlyArray<DatatrackerRelationship>,
  url: string,
  attempts: number,
): Effect.Effect<RfcMetadata, RfcDiscoveryError> =>
  Effect.try({
    try: () => {
      const identifier = `RFC${document.rfc_number}`;
      const updatedBy = new Set<string>();
      const obsoletedBy = new Set<string>();
      for (const relationship of relationships) {
        const source = identifierFromReference(relationship.source);
        const target = identifierFromReference(relationship.target);
        const kind = lastPathSegment(relationship.relationship);
        if (
          source === undefined ||
          target !== identifier ||
          (kind !== "updates" && kind !== "obs")
        ) {
          throw new Error("invalid successor relationship");
        }
        if (kind === "updates") updatedBy.add(source);
        else obsoletedBy.add(source);
      }
      return {
        identifier,
        rfcNumber: document.rfc_number,
        title: document.title,
        abstract: document.abstract,
        status: statusFromDocument(document),
        stream: streamFromReference(document.stream),
        canonicalUrl: `https://datatracker.ietf.org/doc/rfc${document.rfc_number}/`,
        updates: [],
        updatedBy: [...updatedBy].sort(),
        obsoletes: [],
        obsoletedBy: [...obsoletedBy].sort(),
      };
    },
    catch: () =>
      new RfcDiscoveryError({
        stage: "decode",
        url,
        reason: "Datatracker returned an invalid exact RFC relationship",
        attempts,
      }),
  });

type FetchedExactDocument = {
  readonly document: DatatrackerDocument;
  readonly url: string;
  readonly trace: RetrievalRequestTrace;
};

const fetchExactDocument = Effect.fnUntraced(function* (
  http: HttpClient.HttpClient,
  baseUrl: string,
  name: string,
  metadataDirectory: string | undefined,
): Effect.fn.Return<FetchedExactDocument, RfcDiscoveryError, FileSystem.FileSystem | Path.Path> {
  const url = yield* Effect.try({
    try: () => makeExactDocumentUrl(baseUrl, name),
    catch: (error) =>
      new RfcDiscoveryError({
        stage: "request",
        url: baseUrl,
        reason: errorMessage(error),
        attempts: 0,
      }),
  });
  const response = yield* fetchJson(http, url, "metadata", metadataDirectory);
  const document = yield* decodeDocument(response.value, url, response.trace.attempts);
  if (document.name.toLowerCase() !== name || document.rfc_number !== Number(name.slice(3))) {
    return yield* new RfcDiscoveryError({
      stage: "decode",
      url,
      reason: "Datatracker exact RFC metadata did not match the requested identifier",
      attempts: response.trace.attempts,
    });
  }
  return { document, url, trace: response.trace };
});

type ExactLookup = {
  readonly document: RfcMetadata;
  readonly successorNames: ReadonlyArray<string>;
  readonly relationshipRows: number;
  readonly relationshipBoundHit: boolean;
  readonly requests: ReadonlyArray<RetrievalRequestTrace>;
};

const lookupOneRfc = Effect.fnUntraced(function* (
  http: HttpClient.HttpClient,
  baseUrl: string,
  name: string,
  metadataDirectory: string | undefined,
): Effect.fn.Return<ExactLookup, RfcDiscoveryError, FileSystem.FileSystem | Path.Path> {
  const exact = yield* fetchExactDocument(http, baseUrl, name, metadataDirectory);
  const relationshipUrl = makeSuccessorUrl(baseUrl, name);
  const relationshipResponse = yield* fetchJson(
    http,
    relationshipUrl,
    "relationships",
    metadataDirectory,
  );
  const relationshipPage = yield* decodeRelationships(
    relationshipResponse.value,
    relationshipUrl,
    relationshipResponse.trace.attempts,
  );
  const normalized = yield* normalizeDocument(
    exact.document,
    relationshipPage.objects,
    relationshipUrl,
    relationshipResponse.trace.attempts,
  );
  return {
    document: normalized,
    successorNames: [...normalized.updatedBy, ...normalized.obsoletedBy]
      .map((identifier) => identifier.toLowerCase())
      .sort(),
    relationshipRows: relationshipPage.objects.length,
    relationshipBoundHit:
      relationshipPage.meta.next !== null ||
      relationshipPage.meta.total_count > relationshipPage.objects.length ||
      relationshipPage.objects.length >= datatrackerSuccessorLimit,
    requests: [exact.trace, relationshipResponse.trace],
  };
});

const lookupExactRfc = Effect.fnUntraced(function* (
  http: HttpClient.HttpClient,
  baseUrl: string,
  identifier: string,
  metadataDirectory: string | undefined,
): Effect.fn.Return<LiveExactRfcLookup, RfcDiscoveryError, FileSystem.FileSystem | Path.Path> {
  const startedAt = yield* Clock.currentTimeMillis;
  const name = normalizeRfcName(identifier);
  if (name === undefined) {
    return yield* new RfcDiscoveryError({
      stage: "request",
      url: baseUrl,
      reason: "RFC identifier must contain a positive published RFC number",
      attempts: 0,
    });
  }
  const exact = yield* fetchExactDocument(http, baseUrl, name, metadataDirectory);
  const document = yield* normalizeDocument(exact.document, [], exact.url, exact.trace.attempts);
  const finishedAt = yield* Clock.currentTimeMillis;
  return {
    document,
    requests: [exact.trace],
    metadataMs: Math.max(0, finishedAt - startedAt),
  };
});

const lookupKnownRfc = Effect.fnUntraced(function* (
  http: HttpClient.HttpClient,
  baseUrl: string,
  identifier: string,
  configuredDepthLimit: number | undefined,
  metadataDirectory: string | undefined,
): Effect.fn.Return<LiveRfcLookup, RfcDiscoveryError, FileSystem.FileSystem | Path.Path> {
  const startedAt = yield* Clock.currentTimeMillis;
  const depthLimit = boundedCurrencyDepthLimit(configuredDepthLimit);
  const requestedName = normalizeRfcName(identifier);
  if (requestedName === undefined) {
    return yield* new RfcDiscoveryError({
      stage: "request",
      url: baseUrl,
      reason: "RFC identifier must contain a positive published RFC number",
      attempts: 0,
    });
  }

  const queue: Array<{ readonly name: string; readonly depth: number }> = [
    { name: requestedName, depth: 0 },
  ];
  const queued = new Set([requestedName]);
  const visited = new Set<string>();
  const documents: Array<RfcMetadata> = [];
  const requests: Array<RetrievalRequestTrace> = [];
  let traversalComplete = true;
  let traversalDepth = 0;
  let successorRows = 0;
  const boundedExits = new Set<TraversalBoundedExit>();

  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined || visited.has(current.name)) continue;
    if (documents.length >= datatrackerCurrencyContextLimit) {
      traversalComplete = false;
      boundedExits.add("context_limit");
      break;
    }
    visited.add(current.name);
    const lookup = yield* lookupOneRfc(http, baseUrl, current.name, metadataDirectory);
    documents.push(lookup.document);
    requests.push(...lookup.requests);
    traversalDepth = Math.max(traversalDepth, current.depth);
    successorRows += lookup.relationshipRows;
    if (lookup.relationshipBoundHit) {
      traversalComplete = false;
      boundedExits.add("relationship_limit");
    }

    for (const successorName of lookup.successorNames) {
      if (visited.has(successorName) || queued.has(successorName)) continue;
      if (current.depth >= depthLimit) {
        traversalComplete = false;
        boundedExits.add("depth_limit");
        continue;
      }
      if (queued.size >= datatrackerCurrencyContextLimit) {
        traversalComplete = false;
        boundedExits.add("context_limit");
        continue;
      }
      queued.add(successorName);
      queue.push({ name: successorName, depth: current.depth + 1 });
    }
  }

  const requested = documents.find(
    (document) => document.identifier.toLowerCase() === requestedName,
  );
  if (requested === undefined) {
    return yield* new RfcDiscoveryError({
      stage: "decode",
      url: makeExactDocumentUrl(baseUrl, requestedName),
      reason: "Datatracker did not return the requested RFC metadata",
      attempts: 1,
    });
  }
  const finishedAt = yield* Clock.currentTimeMillis;
  return {
    document: requested,
    documents,
    traversalComplete,
    traversalContexts: documents.length,
    traversalDepth,
    depthLimit,
    successorRows,
    boundedExits: traversalBoundedExitOrder.filter((exit) => boundedExits.has(exit)),
    requests,
    metadataMs: Math.max(0, finishedAt - startedAt),
  };
});

const discoverTopic = Effect.fnUntraced(function* (
  http: HttpClient.HttpClient,
  baseUrl: string,
  searchTerms: ReadonlyArray<string>,
  metadataDirectory: string | undefined,
): Effect.fn.Return<LiveTopicDiscovery, RfcDiscoveryError, FileSystem.FileSystem | Path.Path> {
  const startedAt = yield* Clock.currentTimeMillis;
  const termStreams = yield* Effect.forEach(
    searchTerms,
    (term) =>
      Effect.forEach(
        ["title", "abstract"] as const,
        Effect.fnUntraced(function* (field) {
          const url = makeTopicUrl(baseUrl, term, field);
          const response = yield* fetchJson(http, url, "metadata", metadataDirectory);
          const page = yield* decodeDocumentPage(response.value, url, response.trace.attempts);
          const documents = yield* Effect.forEach(page.objects, (document) =>
            normalizeDocument(document, [], url, response.trace.attempts),
          );
          return {
            documents,
            trace: response.trace,
            truncated: page.meta.next !== null || page.meta.total_count > page.objects.length,
          };
        }),
        { concurrency: 2 },
      ),
    { concurrency: datatrackerTopicConcurrencyLimit / 2 },
  );
  const streams = termStreams.flat();

  const merged: Array<RfcMetadata> = [];
  const seen = new Set<string>();
  for (let row = 0; ; row += 1) {
    let found = false;
    for (const stream of streams) {
      const document = stream.documents[row];
      if (document === undefined) continue;
      found = true;
      if (seen.has(document.identifier)) continue;
      seen.add(document.identifier);
      if (merged.length < datatrackerDocumentCandidateLimit) merged.push(document);
    }
    if (!found) break;
  }

  const finishedAt = yield* Clock.currentTimeMillis;
  return {
    documents: merged,
    requests: streams.map(({ trace }) => trace),
    upstreamRows: streams.reduce((count, stream) => count + stream.documents.length, 0),
    uniqueCandidates: seen.size,
    truncated:
      streams.some(({ truncated }) => truncated) || seen.size > datatrackerDocumentCandidateLimit,
    metadataMs: Math.max(0, finishedAt - startedAt),
  };
});

/**
 * Create an RFC discovery layer backed by a supplied HTTP client.
 *
 * @param http HTTP client used for anonymous Datatracker requests.
 * @param baseUrl Datatracker v1 API base URL.
 * @param currencyDepthLimit Optional lower successor depth limit for deterministic tests.
 * @returns A request-local RFC discovery service layer.
 */
export const makeRfcDiscoveryHttpLayer = (
  http: HttpClient.HttpClient,
  baseUrl: string,
  currencyDepthLimit: number | undefined = undefined,
  metadataDirectory: string | undefined = undefined,
): Layer.Layer<RfcDiscovery> =>
  Layer.succeed(
    RfcDiscovery,
    RfcDiscovery.of({
      lookupExactRfc: (identifier) => lookupExactRfc(http, baseUrl, identifier, metadataDirectory),
      lookupKnownRfc: (identifier) =>
        lookupKnownRfc(http, baseUrl, identifier, currencyDepthLimit, metadataDirectory),
      discoverTopic: (searchTerms) => discoverTopic(http, baseUrl, searchTerms, metadataDirectory),
    }),
  );

/**
 * Build the default live RFC discovery layer.
 *
 * @param baseUrl Datatracker v1 API base URL.
 * @returns An RFC discovery layer requiring an Effect HTTP client.
 */
export const makeDefaultRfcDiscoveryLayer = (
  baseUrl: string = defaultDatatrackerApiUrl,
  metadataDirectory: string | undefined = undefined,
): Layer.Layer<RfcDiscovery, never, HttpClient.HttpClient> =>
  Layer.effect(
    RfcDiscovery,
    Effect.gen(function* () {
      const http = yield* HttpClient.HttpClient;
      return RfcDiscovery.of({
        lookupExactRfc: (identifier) =>
          lookupExactRfc(http, baseUrl, identifier, metadataDirectory),
        lookupKnownRfc: (identifier) =>
          lookupKnownRfc(http, baseUrl, identifier, undefined, metadataDirectory),
        discoverTopic: (searchTerms) =>
          discoverTopic(http, baseUrl, searchTerms, metadataDirectory),
      });
    }),
  );
