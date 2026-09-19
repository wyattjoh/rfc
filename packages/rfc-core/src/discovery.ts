import {
  Cause,
  Clock,
  Context,
  Duration,
  Effect,
  Layer,
  Option,
  Random,
  Result,
  Schema,
} from "effect";
import { Headers, HttpClient, HttpClientError, HttpClientResponse } from "effect/unstable/http";
import { defaultDatatrackerApiUrl, type CatalogDocument } from "./catalog";

/**
 * Maximum number of attempts for one required Datatracker request.
 */
export const datatrackerMaxAttempts = 3;

/**
 * Maximum elapsed time for one required Datatracker request, including retries.
 */
export const datatrackerRequestDeadlineMilliseconds = 10_000;

/**
 * Maximum successor relationship rows requested for one RFC.
 */
export const datatrackerSuccessorLimit = 64;

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
});

/**
 * A request-local upstream request trace.
 */
export type RetrievalRequestTrace = Schema.Schema.Type<typeof RetrievalRequestTraceSchema>;

/**
 * Live retrieval diagnostics for a schema-version-two known-RFC request.
 */
export const LiveRetrievalTraceSchema = Schema.Struct({
  schemaVersion: Schema.Literal(2),
  requestCount: Schema.Natural,
  datatrackerRequestCount: Schema.Natural,
  sourceRequestCount: Schema.Natural,
  metadataMs: Schema.Number,
  sourceMs: Schema.Number,
  sourceCacheOutcome: Schema.Literals(["hit", "miss"]),
  requests: Schema.Array(RetrievalRequestTraceSchema),
});

/**
 * Live retrieval diagnostics for a schema-version-two known-RFC request.
 */
export type LiveRetrievalTrace = Schema.Schema.Type<typeof LiveRetrievalTraceSchema>;

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
 * Request-local exact RFC metadata and direct successor information.
 */
export interface LiveRfcLookup {
  /**
   * Exact normalized metadata for the requested published RFC.
   */
  readonly document: CatalogDocument;
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
 * Service for bounded request-local RFC discovery.
 */
export interface RfcDiscoveryService {
  /**
   * Retrieve exact metadata and direct successor relationships for one RFC.
   */
  readonly lookupKnownRfc: (identifier: string) => Effect.Effect<LiveRfcLookup, RfcDiscoveryError>;
}

/**
 * Effect service tag for bounded request-local RFC discovery.
 */
export class RfcDiscovery extends Context.Service<RfcDiscovery, RfcDiscoveryService>()(
  "rfc-core/RfcDiscovery",
) {}

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

const DatatrackerRelationshipPageSchema = Schema.Struct({
  meta: Schema.Struct({
    next: Schema.NullOr(Schema.String),
    total_count: Schema.Natural,
  }),
  objects: Schema.Array(DatatrackerRelationshipSchema),
});

type DatatrackerRelationshipPage = Schema.Schema.Type<typeof DatatrackerRelationshipPageSchema>;

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
      .find((status) => status.length > 0 && !/^\d+$/.test(status)) ?? "published"
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
  status === 408 ||
  status === 429 ||
  status === 500 ||
  status === 502 ||
  status === 503 ||
  status === 504;

const retryAfterMilliseconds = (
  response: HttpClientResponse.HttpClientResponse,
  now: number,
): number | undefined => {
  const value = Option.getOrUndefined(Headers.get("retry-after")(response.headers));
  if (value === undefined) return undefined;
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
};

const fetchJson = Effect.fnUntraced(function* (
  http: HttpClient.HttpClient,
  url: string,
  kind: "metadata" | "relationships",
): Effect.fn.Return<FetchedJson, RfcDiscoveryError> {
  const startedAt = yield* Clock.currentTimeMillis;
  let scheduledDelay = 0;
  let lastStatus: number | null = null;
  const statuses: Array<number | null> = [];

  for (let attempt = 1; attempt <= datatrackerMaxAttempts; attempt += 1) {
    const attemptStartedAt = yield* Clock.currentTimeMillis;
    const elapsedBeforeAttempt = Math.max(0, attemptStartedAt - startedAt, scheduledDelay);
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
      http.get(url).pipe(Effect.timeout(Duration.millis(remaining))),
    );
    if (Result.isFailure(requestResult)) {
      statuses.push(null);
      const failure = requestResult.failure;
      const transient =
        Cause.isTimeoutError(failure) ||
        (HttpClientError.isHttpClientError(failure) && failure.reason._tag === "TransportError");
      if (!transient || attempt >= datatrackerMaxAttempts) {
        return yield* new RfcDiscoveryError({
          stage: "request",
          url,
          reason: transient
            ? `Datatracker retry budget exhausted after ${attempt} attempts`
            : errorMessage(failure),
          attempts: attempt,
        });
      }
      const delay = yield* retryDelayMilliseconds(undefined, attempt);
      if (elapsedBeforeAttempt + delay > datatrackerRequestDeadlineMilliseconds) {
        return yield* new RfcDiscoveryError({
          stage: "request",
          url,
          reason: `Datatracker retry deadline exhausted after ${attempt} attempts`,
          attempts: attempt,
        });
      }
      yield* Effect.sleep(Duration.millis(delay));
      scheduledDelay += delay;
      continue;
    }

    const response = requestResult.success;
    lastStatus = response.status;
    statuses.push(response.status);
    if (isTransientStatus(response.status)) {
      const delay = yield* retryDelayMilliseconds(response, attempt);
      if (
        attempt >= datatrackerMaxAttempts ||
        elapsedBeforeAttempt + delay > datatrackerRequestDeadlineMilliseconds
      ) {
        return yield* new RfcDiscoveryError({
          stage: "request",
          url,
          reason: `Datatracker retry budget exhausted after ${attempt} attempts (HTTP ${response.status})`,
          attempts: attempt,
        });
      }
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

    const jsonResult = yield* Effect.result(response.json);
    if (Result.isFailure(jsonResult)) {
      return yield* new RfcDiscoveryError({
        stage: "decode",
        url,
        reason: errorMessage(jsonResult.failure),
        attempts: attempt,
      });
    }
    const finishedAt = yield* Clock.currentTimeMillis;
    return {
      value: jsonResult.success,
      trace: {
        kind,
        url,
        attempts: attempt,
        status: response.status,
        statuses,
        durationMs: Math.max(0, finishedAt - startedAt, scheduledDelay),
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

const decodeDocument = (
  value: unknown,
  url: string,
  attempts: number,
): Effect.Effect<DatatrackerDocument, RfcDiscoveryError> =>
  Effect.try({
    try: () => {
      const document = Schema.decodeUnknownSync(DatatrackerDocumentSchema)(value);
      if (document.rfc_number <= 0) throw new Error("RFC number must be positive");
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
        page.meta.next !== null ||
        page.meta.total_count > datatrackerSuccessorLimit ||
        page.objects.length > datatrackerSuccessorLimit
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

const normalizeDocument = (
  document: DatatrackerDocument,
  relationships: ReadonlyArray<DatatrackerRelationship>,
  url: string,
  attempts: number,
): Effect.Effect<CatalogDocument, RfcDiscoveryError> =>
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

const lookupKnownRfc = Effect.fnUntraced(function* (
  http: HttpClient.HttpClient,
  baseUrl: string,
  identifier: string,
): Effect.fn.Return<LiveRfcLookup, RfcDiscoveryError> {
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

  const documentUrl = yield* Effect.try({
    try: () => makeExactDocumentUrl(baseUrl, name),
    catch: (error) =>
      new RfcDiscoveryError({
        stage: "request",
        url: baseUrl,
        reason: errorMessage(error),
        attempts: 0,
      }),
  });
  const documentResponse = yield* fetchJson(http, documentUrl, "metadata");
  const document = yield* decodeDocument(
    documentResponse.value,
    documentUrl,
    documentResponse.trace.attempts,
  );
  if (document.name.toLowerCase() !== name || document.rfc_number !== Number(name.slice(3))) {
    return yield* new RfcDiscoveryError({
      stage: "decode",
      url: documentUrl,
      reason: "Datatracker exact RFC metadata did not match the requested identifier",
      attempts: documentResponse.trace.attempts,
    });
  }

  const relationshipUrl = makeSuccessorUrl(baseUrl, name);
  const relationshipResponse = yield* fetchJson(http, relationshipUrl, "relationships");
  const relationshipPage = yield* decodeRelationships(
    relationshipResponse.value,
    relationshipUrl,
    relationshipResponse.trace.attempts,
  );
  const normalized = yield* normalizeDocument(
    document,
    relationshipPage.objects,
    relationshipUrl,
    relationshipResponse.trace.attempts,
  );
  const finishedAt = yield* Clock.currentTimeMillis;
  return {
    document: normalized,
    requests: [documentResponse.trace, relationshipResponse.trace],
    metadataMs: Math.max(0, finishedAt - startedAt),
  };
});

/**
 * Create an RFC discovery layer backed by a supplied HTTP client.
 *
 * @param http HTTP client used for anonymous Datatracker requests.
 * @param baseUrl Datatracker v1 API base URL.
 * @returns A request-local RFC discovery service layer.
 */
export const makeRfcDiscoveryHttpLayer = (
  http: HttpClient.HttpClient,
  baseUrl: string,
): Layer.Layer<RfcDiscovery> =>
  Layer.succeed(
    RfcDiscovery,
    RfcDiscovery.of({
      lookupKnownRfc: (identifier) => lookupKnownRfc(http, baseUrl, identifier),
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
): Layer.Layer<RfcDiscovery, never, HttpClient.HttpClient> =>
  Layer.effect(
    RfcDiscovery,
    Effect.gen(function* () {
      const http = yield* HttpClient.HttpClient;
      return RfcDiscovery.of({
        lookupKnownRfc: (identifier) => lookupKnownRfc(http, baseUrl, identifier),
      });
    }),
  );
