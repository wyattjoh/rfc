import { createHash } from "node:crypto";
import { Clock, Effect, FileSystem, Path, Schema } from "effect";
import { Headers } from "effect/unstable/http";
import { maxAgeMilliseconds } from "./live-source";

/**
 * Version of the Datatracker metadata-cache format.
 */
export const datatrackerMetadataCacheVersion = "v2";

/**
 * Maximum bytes read back for one cached Datatracker response.
 *
 * Matches the streaming cap applied to a live Datatracker body, so a cached
 * entry can never exceed what the network path would have accepted.
 */
export const datatrackerMetadataCacheEntryMaximumBytes = 1_048_576;

/**
 * Upper bound applied to a server-declared freshness window.
 *
 * Datatracker currently declares `max-age=300`. Clamping means a future
 * misconfiguration upstream cannot pin currency metadata for an unbounded
 * period, which is the one input where staleness changes a research outcome.
 */
export const datatrackerMetadataCacheMaximumFreshnessSeconds = 3_600;

const CacheEntrySchema = Schema.Struct({
  schemaVersion: Schema.Literal(2),
  url: Schema.NonEmptyString,
  fetchedAt: Schema.NonEmptyString,
  freshUntil: Schema.NonEmptyString,
  body: Schema.Unknown,
});

type CacheEntry = Schema.Schema.Type<typeof CacheEntrySchema>;

const entryPath = (pathService: Path.Path, directory: string, url: string): string =>
  pathService.join(
    directory,
    datatrackerMetadataCacheVersion,
    `${createHash("sha256").update(url).digest("hex")}.json`,
  );

/**
 * The freshness window a Datatracker response declares for itself.
 *
 * Only an explicit positive `max-age` produces a window, so a response without
 * one is never stored: this cache honours what the server already says about
 * its own data rather than inventing a retention policy. HTTP parsing is
 * shared with the source cache; the tighter clamp is applied here.
 *
 * @param headers Datatracker response headers.
 * @returns Freshness in milliseconds, or undefined when the response is not cacheable.
 */
export const metadataFreshnessMilliseconds = (headers: Headers.Headers): number | undefined => {
  const declared = maxAgeMilliseconds(headers);
  if (declared <= 0) return undefined;
  return Math.min(declared, datatrackerMetadataCacheMaximumFreshnessSeconds * 1_000);
};

/**
 * Read a Datatracker response that is still within its declared freshness.
 *
 * A miss, an unreadable entry, and a corrupt entry are all reported the same
 * way, because every one of them is resolved by performing the authoritative
 * request. This cache never changes what a caller may conclude, only whether a
 * round trip was required to conclude it, so it fails soft where the source
 * cache — which backs quoted evidence — fails closed.
 *
 * @param directory Root Datatracker metadata-cache directory.
 * @param url Exact request URL used as the cache identity.
 * @returns The cached response body, or undefined when a request is required.
 */
export const readFreshMetadata = Effect.fnUntraced(function* (
  directory: string,
  url: string,
): Effect.fn.Return<unknown | undefined, never, FileSystem.FileSystem | Path.Path> {
  const fileSystem = yield* FileSystem.FileSystem;
  const pathService = yield* Path.Path;
  const path = entryPath(pathService, directory, url);
  const now = yield* Clock.currentTimeMillis;

  return yield* Effect.gen(function* () {
    const info = yield* fileSystem.stat(path);
    if (info.size > BigInt(datatrackerMetadataCacheEntryMaximumBytes)) return undefined;
    const contents = yield* fileSystem.readFileString(path);
    const entry: CacheEntry = Schema.decodeUnknownSync(CacheEntrySchema)(JSON.parse(contents));
    if (entry.url !== url) return undefined;
    const fetchedAt = Date.parse(entry.fetchedAt);
    const freshUntil = Date.parse(entry.freshUntil);
    if (!Number.isFinite(fetchedAt) || !Number.isFinite(freshUntil)) return undefined;
    // A future timestamp cannot describe a response this client received, so
    // the entry's window is not trustworthy.
    if (fetchedAt > now || now >= freshUntil) return undefined;
    return entry.body;
  }).pipe(Effect.catchCause(() => Effect.succeed(undefined)));
});

/**
 * Store a Datatracker response for the window the server declared.
 *
 * @param directory Root Datatracker metadata-cache directory.
 * @param url Exact request URL used as the cache identity.
 * @param body Decoded response body.
 * @param freshnessMilliseconds Server-declared freshness window.
 * @returns Nothing; a storage failure is intentionally not an operation failure.
 */
export const writeFreshMetadata = Effect.fnUntraced(function* (
  directory: string,
  url: string,
  body: unknown,
  freshnessMilliseconds: number,
): Effect.fn.Return<void, never, FileSystem.FileSystem | Path.Path> {
  const fileSystem = yield* FileSystem.FileSystem;
  const pathService = yield* Path.Path;
  const path = entryPath(pathService, directory, url);
  const now = yield* Clock.currentTimeMillis;
  const entry: CacheEntry = {
    schemaVersion: 2,
    url,
    fetchedAt: new Date(now).toISOString(),
    freshUntil: new Date(now + freshnessMilliseconds).toISOString(),
    body,
  };

  const temporaryPath = `${path}.tmp-${crypto.randomUUID()}`;
  yield* Effect.gen(function* () {
    const serialized = `${JSON.stringify(entry)}\n`;
    if (Buffer.byteLength(serialized) > datatrackerMetadataCacheEntryMaximumBytes) return;
    yield* fileSystem.makeDirectory(pathService.dirname(path), { recursive: true });
    yield* fileSystem.writeFileString(temporaryPath, serialized);
    yield* fileSystem.rename(temporaryPath, path);
  }).pipe(
    Effect.ensuring(
      fileSystem.remove(temporaryPath, { force: true }).pipe(Effect.catch(() => Effect.void)),
    ),
    Effect.catchCause(() => Effect.void),
  );
});
