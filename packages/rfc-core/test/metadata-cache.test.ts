import { mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "bun:test";
import { NodeFileSystem, NodePath } from "@effect/platform-node";
import { Clock, Effect, Layer } from "effect";
import { Headers } from "effect/unstable/http";
import {
  datatrackerMetadataCacheMaximumFreshnessSeconds,
  metadataFreshnessMilliseconds,
  readFreshMetadata,
  writeFreshMetadata,
} from "../src/metadata-cache";

const platform = Layer.mergeAll(NodeFileSystem.layer, NodePath.layer);

const directories: Array<string> = [];

const makeDirectory = async () => {
  const directory = await mkdtemp(join(tmpdir(), "rfc-core-metadata-cache-"));
  directories.push(directory);
  return directory;
};

const run = <A>(program: Effect.Effect<A, never, never>) => Effect.runPromise(program);

const withPlatform = <A, E, R>(program: Effect.Effect<A, E, R>) =>
  program.pipe(Effect.provide(platform)) as Effect.Effect<A, E, never>;

/**
 * Run a program with the clock advanced by a fixed offset, so freshness
 * boundaries are exercised without waiting.
 */
const atOffset = <A, E, R>(program: Effect.Effect<A, E, R>, offsetMilliseconds: number) => {
  const now = () => Date.now() + offsetMilliseconds;
  const clock: Clock.Clock = {
    currentTimeMillisUnsafe: now,
    currentTimeMillis: Effect.sync(now),
    currentTimeNanosUnsafe: () => BigInt(now()) * 1_000_000n,
    currentTimeNanos: Effect.sync(() => BigInt(now()) * 1_000_000n),
    monotonicTimeNanosUnsafe: () => BigInt(now()) * 1_000_000n,
    monotonicTimeNanos: Effect.sync(() => BigInt(now()) * 1_000_000n),
    sleep: () => Effect.void,
  };
  return withPlatform(program.pipe(Effect.provideService(Clock.Clock, clock)));
};

const url = "https://datatracker.ietf.org/api/v1/doc/document/rfc9110/?format=json";

afterAll(async () => {
  await Promise.all(
    directories.map(async (directory) => {
      await Bun.$`rm -rf ${directory}`.quiet().nothrow();
    }),
  );
});

describe("datatracker metadata freshness", () => {
  test("honours an explicit positive max-age", () => {
    expect(
      metadataFreshnessMilliseconds(Headers.fromInput({ "cache-control": "max-age=300" })),
    ).toBe(300_000);
  });

  test("subtracts a reported age", () => {
    expect(
      metadataFreshnessMilliseconds(
        Headers.fromInput({ "cache-control": "max-age=300, s-maxage=300", age: "60" }),
      ),
    ).toBe(240_000);
  });

  test("refuses to store a response that is not cacheable", () => {
    for (const headers of [
      {},
      { "cache-control": "no-store" },
      { "cache-control": "no-cache" },
      { "cache-control": "max-age=0" },
      { "cache-control": "public" },
    ]) {
      expect(metadataFreshnessMilliseconds(Headers.fromInput(headers))).toBeUndefined();
    }
  });

  test("clamps a window far longer than currency metadata should be trusted", () => {
    // Source text is immutable once published and may be held for a year, but
    // this data decides whether an RFC has been obsoleted.
    expect(
      metadataFreshnessMilliseconds(Headers.fromInput({ "cache-control": "max-age=31536000" })),
    ).toBe(datatrackerMetadataCacheMaximumFreshnessSeconds * 1_000);
  });
});

describe("datatracker metadata cache", () => {
  test("serves a stored response inside its freshness window", async () => {
    const directory = await makeDirectory();
    const body = { name: "rfc9110", rfc: 9110 };

    await run(withPlatform(writeFreshMetadata(directory, url, body, 300_000)));
    const cached = await run(withPlatform(readFreshMetadata(directory, url)));

    expect(cached).toEqual(body);
  });

  test("stops serving a response once its window has elapsed", async () => {
    const directory = await makeDirectory();
    await run(withPlatform(writeFreshMetadata(directory, url, { name: "rfc9110" }, 300_000)));

    expect(await run(atOffset(readFreshMetadata(directory, url), 299_000))).toEqual({
      name: "rfc9110",
    });
    expect(await run(atOffset(readFreshMetadata(directory, url), 301_000))).toBeUndefined();
  });

  test("distinguishes entries by their exact request URL", async () => {
    const directory = await makeDirectory();
    await run(withPlatform(writeFreshMetadata(directory, url, { name: "rfc9110" }, 300_000)));

    const other = `${url}&limit=20`;
    expect(await run(withPlatform(readFreshMetadata(directory, other)))).toBeUndefined();
  });

  test("reports a miss rather than failing when an entry is unreadable", async () => {
    // A cache fault is always resolved by performing the authoritative
    // request, so it must never surface as an operation failure.
    const directory = await makeDirectory();
    await run(withPlatform(writeFreshMetadata(directory, url, { name: "rfc9110" }, 300_000)));
    const [entry] = await readdir(join(directory, "v2"));
    if (entry === undefined) throw new Error("Expected a cache entry");
    await writeFile(join(directory, "v2", entry), "{ not json");

    expect(await run(withPlatform(readFreshMetadata(directory, url)))).toBeUndefined();
  });

  test("reports a miss for an absent entry and an unwritable directory", async () => {
    const directory = await makeDirectory();
    expect(await run(withPlatform(readFreshMetadata(directory, url)))).toBeUndefined();

    // A write into a path that cannot be created is silently a no-op.
    await run(withPlatform(writeFreshMetadata("/proc/nonexistent", url, { a: 1 }, 300_000)));
    expect(await run(withPlatform(readFreshMetadata("/proc/nonexistent", url)))).toBeUndefined();
  });

  test("refuses an entry whose fetch time is in the future", async () => {
    const directory = await makeDirectory();
    // Written by a clock an hour ahead of the reader's.
    await run(
      atOffset(writeFreshMetadata(directory, url, { name: "rfc9110" }, 300_000), 3_600_000),
    );

    expect(await run(withPlatform(readFreshMetadata(directory, url)))).toBeUndefined();
  });
});
