import { performance } from "node:perf_hooks";
import { createRfcClient, evaluationPolicy, pinnedJevModel } from "../src/index";
import { makeDefaultCredentialStore, resolveStoredCredential } from "../../rfc/src/credentials";

const parsePositiveInteger = (value: string | undefined, fallback: number): number => {
  const parsed = value === undefined ? Number.NaN : Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? Math.min(parsed, 1_000) : fallback;
};

const main = async (): Promise<void> => {
  if (process.env.RFC_TOPIC_BENCHMARK !== "1") {
    console.log("Set RFC_TOPIC_BENCHMARK=1 to run the opt-in warm-cache topic benchmark.");
    return;
  }

  const cacheDirectory = process.env.RFC_CACHE_DIRECTORY;
  if (cacheDirectory === undefined || cacheDirectory.length === 0) {
    throw new Error("RFC_CACHE_DIRECTORY must point to a writable per-RFC source-cache directory");
  }

  const iterations = parsePositiveInteger(process.env.RFC_TOPIC_BENCHMARK_ITERATIONS, 20);
  const targetMs = evaluationPolicy.maxTopicP95LatencyMilliseconds;
  const question =
    process.env.RFC_TOPIC_BENCHMARK_QUESTION ?? "What does HTTP require of a client?";
  const typeSafeApiKey = await resolveStoredCredential(makeDefaultCredentialStore());
  const client = await createRfcClient({
    cacheDirectory,
    modelAlias: pinnedJevModel,
    policyPreset: evaluationPolicy.policyVersion,
    automaticAnswerActivation: undefined,
    typeSafeApiKey,
    typeSafeApiUrl: process.env.TYPESAFE_API_URL,
  });

  try {
    await client.research({ schemaVersion: 2, question, rfc: null, searchTerms: [question] });
    const samples: Array<number> = [];
    for (let index = 0; index < iterations; index += 1) {
      const startedAt = performance.now();
      await client.research({ schemaVersion: 2, question, rfc: null, searchTerms: [question] });
      samples.push(performance.now() - startedAt);
    }

    samples.sort((left, right) => left - right);
    const p95Index = Math.min(samples.length - 1, Math.ceil(samples.length * 0.95) - 1);
    const p95Ms = samples[p95Index] ?? 0;
    const report = {
      kind: "topic_warm_cache_benchmark",
      iterations,
      p95Ms,
      targetMs,
      passed: p95Ms < targetMs,
    };
    process.stdout.write(`${JSON.stringify(report)}\n`);
    if (!report.passed) {
      process.exitCode = 1;
    }
  } finally {
    await client.close();
  }
};

await main();
