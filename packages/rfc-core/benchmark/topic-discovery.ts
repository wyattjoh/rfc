import { performance } from "node:perf_hooks";
import { createRfcClient, datatrackerTopicSearchTermLimit, retrievalPolicy } from "../src/index";
import { makeDefaultCredentialStore, resolveStoredCredential } from "../../rfc/src/credentials";

const parsePositiveInteger = (value: string | undefined, fallback: number): number => {
  const parsed = value === undefined ? Number.NaN : Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? Math.min(parsed, 1_000) : fallback;
};

const parseSearchTerms = (value: string | undefined): ReadonlyArray<string> => {
  if (value === undefined) return ["HTTP semantics", "client request"];
  const parsed = JSON.parse(value) as unknown;
  if (
    !Array.isArray(parsed) ||
    parsed.length < 1 ||
    parsed.length > datatrackerTopicSearchTermLimit ||
    parsed.some((term) => typeof term !== "string" || term.length === 0)
  ) {
    throw new Error(
      "RFC_TOPIC_BENCHMARK_SEARCH_TERMS must be a JSON array of one to four non-empty strings",
    );
  }
  return parsed;
};

const p95 = (values: ReadonlyArray<number>): number => {
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1);
  return sorted[index] ?? 0;
};

const main = async (): Promise<void> => {
  if (process.env.RFC_TOPIC_BENCHMARK !== "1") {
    console.log("Set RFC_TOPIC_BENCHMARK=1 to run the opt-in live-discovery benchmark.");
    return;
  }

  const cacheDirectory = process.env.RFC_CACHE_DIRECTORY;
  if (cacheDirectory === undefined || cacheDirectory.length === 0) {
    throw new Error("RFC_CACHE_DIRECTORY must point to a writable per-RFC source-cache directory");
  }

  const iterations = parsePositiveInteger(process.env.RFC_TOPIC_BENCHMARK_ITERATIONS, 20);
  const provisionalTargetMs = 3_000;
  const question =
    process.env.RFC_TOPIC_BENCHMARK_QUESTION ?? "What does HTTP require of a client?";
  const searchTerms = parseSearchTerms(process.env.RFC_TOPIC_BENCHMARK_SEARCH_TERMS);
  const typeSafeApiKey = await resolveStoredCredential(makeDefaultCredentialStore());
  const client = await createRfcClient({
    cacheDirectory,
    modelAlias: retrievalPolicy.pinnedModel,
    typeSafeApiKey,
    typeSafeApiUrl: process.env.TYPESAFE_API_URL,
  });

  try {
    const warmup = await client.research({
      schemaVersion: 3,
      questions: [question],
      searchTerms,
    });
    const samples = [];
    for (let index = 0; index < iterations; index += 1) {
      const startedAt = performance.now();
      const result = await client.research({
        schemaVersion: 3,
        questions: [question],
        searchTerms,
      });
      samples.push({
        measuredTotalMs: performance.now() - startedAt,
        timings: result.diagnostics.timings,
        retrieval: result.diagnostics.retrieval,
      });
    }

    const stageP95Ms = {
      liveDiscovery: p95(samples.map(({ timings }) => timings.metadataMs)),
      sourceCache: p95(samples.map(({ timings }) => timings.sourceMs)),
      rank: p95(samples.map(({ timings }) => timings.rankMs)),
      section: p95(samples.map(({ timings }) => timings.sectionMs)),
      paragraph: p95(samples.map(({ timings }) => timings.paragraphMs)),
      semantic: p95(
        samples.map(({ timings }) => timings.rankMs + timings.sectionMs + timings.paragraphMs),
      ),
      reportedTotal: p95(samples.map(({ timings }) => timings.totalMs)),
      measuredTotal: p95(samples.map(({ measuredTotalMs }) => measuredTotalMs)),
    };
    const report = {
      schemaVersion: 3,
      kind: "topic_live_discovery_benchmark",
      policyVersion: retrievalPolicy.policyVersion,
      iterations,
      searchTerms,
      provisionalTargetMs,
      provisionalTargetMet: stageP95Ms.measuredTotal < provisionalTargetMs,
      passed: null,
      stageP95Ms,
      warmupRetrieval: warmup.diagnostics.retrieval,
      retrievalTraces: samples.map(({ retrieval }) => retrieval),
    };
    process.stdout.write(`${JSON.stringify(report)}\n`);
  } finally {
    await client.close();
  }
};

await main();
