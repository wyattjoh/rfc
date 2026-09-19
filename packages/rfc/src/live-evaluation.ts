import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  ConfigurationError,
  defaultRfcEditorBaseUrl,
  evaluationCorpus,
  evaluationCorpusDigest,
  evaluationModelAlias,
  evaluationPolicy,
  evaluationReleaseAttestation,
  failedEvaluationObservation,
  makeRfcSourceUrl,
  observationFromCitationResult,
  observationFromEvidenceBundle,
  pinnedJevModel,
  runEvaluation,
  type EvaluationCase,
  type EvaluationReportOptions,
} from "@wyattjoh/rfc-core";
import { readCliConfig } from "./config";
import { createRfcCalibrationClient } from "../../rfc-core/src/internal-calibration";

const liveCorpus = {
  ...evaluationCorpus,
  cases: evaluationCorpus.cases.filter((evaluationCase) => evaluationCase.live),
};

const liveEvaluationIterations = 3;

const timedCorpus = {
  ...liveCorpus,
  cases: liveCorpus.cases.flatMap((evaluationCase) =>
    Array.from({ length: liveEvaluationIterations }, (_, iteration) => ({
      ...evaluationCase,
      id: `${evaluationCase.id}:iteration-${iteration + 1}`,
    })),
  ),
};

const rfcNumberFromIdentifier = (identifier: string): number => {
  const match = /^RFC([0-9]+)$/i.exec(identifier);
  const number = match === null ? Number.NaN : Number(match[1]);
  if (!Number.isSafeInteger(number) || number <= 0) {
    throw new Error("The evaluation corpus contains an invalid RFC identifier");
  }
  return number;
};

const normalizeSource = (
  source: string,
): {
  readonly text: string;
  readonly starts: ReadonlyArray<number>;
  readonly ends: ReadonlyArray<number>;
} => {
  const characters: Array<string> = [];
  const starts: Array<number> = [];
  const ends: Array<number> = [];
  let index = 0;
  while (index < source.length) {
    const character = source[index];
    if (character === "-" && source[index + 1] === "\n") {
      index += 2;
      while (index < source.length && (source[index] === " " || source[index] === "\t")) {
        index += 1;
      }
      continue;
    }
    if (character !== undefined && /\s/.test(character)) {
      const start = index;
      while (index < source.length && /\s/.test(source[index] ?? "")) {
        index += 1;
      }
      characters.push(" ");
      starts.push(start);
      ends.push(index);
      continue;
    }
    if (character !== undefined) {
      characters.push(character);
      starts.push(index);
      ends.push(index + 1);
    }
    index += 1;
  }
  return { text: characters.join(""), starts, ends };
};

const readAuthoritativeSource = async (identifier: string): Promise<string> => {
  const url = makeRfcSourceUrl(defaultRfcEditorBaseUrl, rfcNumberFromIdentifier(identifier));
  const response = await fetch(url, { redirect: "error" });
  if (!response.ok || response.url !== url) {
    throw new Error("The RFC Editor source could not be loaded exactly");
  }
  return response.text();
};

const exactQuoteFromSource = (evaluationCase: EvaluationCase, source: string): string => {
  if (evaluationCase.quote === null) {
    throw new Error(`Citation case ${evaluationCase.id} is incomplete`);
  }
  const normalized = normalizeSource(source);
  const needle = evaluationCase.quote.trim().replace(/\s+/g, " ");
  const start = normalized.text.indexOf(needle);
  if (start < 0) {
    throw new Error("The committed evaluation quote was not found in the RFC Editor source");
  }
  const end = start + needle.length - 1;
  const sourceStart = normalized.starts[start];
  const sourceEnd = normalized.ends[end];
  if (sourceStart === undefined || sourceEnd === undefined) {
    throw new Error("The committed evaluation quote has invalid source bounds");
  }
  return source.slice(sourceStart, sourceEnd);
};

const utf8OffsetFor = (source: string, quote: string): number => {
  const index = source.indexOf(quote);
  if (index < 0) {
    throw new Error("The selected evaluation quote has no exact source occurrence");
  }
  return new TextEncoder().encode(source.slice(0, index)).byteLength;
};

const loadCitationSources = async (): Promise<ReadonlyMap<string, string>> => {
  const identifiers = new Set(
    liveCorpus.cases.flatMap((evaluationCase) =>
      evaluationCase.kind === "citation" && evaluationCase.rfc !== null ? [evaluationCase.rfc] : [],
    ),
  );
  const sources = new Map<string, string>();
  for (const identifier of identifiers) {
    sources.set(identifier, await readAuthoritativeSource(identifier));
  }
  return sources;
};

const researchRequestFor = (evaluationCase: EvaluationCase) => {
  if (evaluationCase.question === null) {
    throw new Error(`Research case ${evaluationCase.id} is missing a question`);
  }
  return {
    schemaVersion: 1 as const,
    question: evaluationCase.question,
    rfc: evaluationCase.rfc,
  };
};

const citationRequestFor = (
  evaluationCase: EvaluationCase,
  sources: ReadonlyMap<string, string>,
) => {
  if (
    evaluationCase.rfc === null ||
    evaluationCase.claim === null ||
    evaluationCase.quote === null
  ) {
    throw new Error(`Citation case ${evaluationCase.id} is incomplete`);
  }
  const source = sources.get(evaluationCase.rfc);
  if (source === undefined) {
    throw new Error(`Citation source ${evaluationCase.rfc} is unavailable`);
  }
  const quote =
    evaluationCase.category === "fabricated_quotation"
      ? evaluationCase.quote
      : exactQuoteFromSource(evaluationCase, source);
  if (evaluationCase.category === "duplicate_quotation" && source.split(quote).length - 1 < 2) {
    throw new Error("The duplicate evaluation quote is not repeated in the RFC Editor source");
  }
  return {
    schemaVersion: 1 as const,
    rfc: evaluationCase.rfc,
    claim: evaluationCase.claim,
    quote,
    offset:
      evaluationCase.category === "duplicate_quotation"
        ? utf8OffsetFor(source, quote)
        : evaluationCase.offset,
  };
};

const errorKind = (error: unknown): string => {
  if (typeof error === "object" && error !== null && "_tag" in error) {
    const tag = (error as { readonly _tag: unknown | undefined })._tag;
    if (typeof tag === "string" && tag.length > 0) return tag;
  }
  return "EvaluationOperationError";
};

/**
 * Run the opt-in live TypeSafe calibration against authoritative RFC Editor sources.
 *
 * Catalog and source refreshes happen before an untimed pass over every live
 * case and three sequential timed iterations. This warms currency successors
 * and provider-accepted topic sources while preserving a bounded provider call
 * order and excluding catalog refresh from both p95 gates.
 *
 * @returns Zero when every precision, safety, latency, and model gate passes;
 * otherwise two.
 */
export const runLiveEvaluation = async (): Promise<number> => {
  let config: ReturnType<typeof readCliConfig>;
  try {
    config = readCliConfig();
  } catch (error) {
    throw new ConfigurationError({
      reason:
        error instanceof Error ? error.message : "Unable to validate live evaluation configuration",
    });
  }
  if (!config.liveEvaluation) {
    throw new ConfigurationError({
      reason: "Live evaluation is disabled; set RFC_LIVE_EVALUATION=true explicitly",
    });
  }
  if (
    config.policyPreset !== evaluationPolicy.policyVersion ||
    config.evaluationModel !== evaluationModelAlias ||
    config.pinnedModel !== pinnedJevModel ||
    config.modelAlias !== pinnedJevModel
  ) {
    throw new ConfigurationError({
      reason: "Live calibration must use the committed precision policy and exact Jev pin",
    });
  }

  let options: EvaluationReportOptions = {
    origin: "live",
    releaseBuildId: evaluationReleaseAttestation.buildId,
    corpusDigest: evaluationCorpusDigest,
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1_000).toISOString(),
    authoritativeSourceHashes: undefined,
    policyVersion: evaluationPolicy.policyVersion,
    requestedModel: evaluationModelAlias,
    pinnedModel: pinnedJevModel,
    minimumSupportedClaimPrecision: undefined,
    maxKnownRfcP95LatencyMilliseconds: undefined,
    maxTopicP95LatencyMilliseconds: undefined,
  };
  const client = await createRfcCalibrationClient({
    cacheDirectory: config.evaluationCacheDirectory,
    catalogPath: undefined,
    modelAlias: config.evaluationModel,
    policyPreset: config.policyPreset,
    typeSafeApiKey: config.apiKey,
    typeSafeApiUrl: undefined,
  });

  try {
    await client.catalogRefresh();
    await client.prefetchSources([
      ...new Set(
        liveCorpus.cases.flatMap((evaluationCase) =>
          evaluationCase.rfc === null ? [] : [evaluationCase.rfc],
        ),
      ),
    ]);
    const citationSources = await loadCitationSources();
    const evaluateCase = async (evaluationCase: EvaluationCase) => {
      try {
        if (evaluationCase.kind === "research") {
          const result = await client.research(researchRequestFor(evaluationCase));
          return observationFromEvidenceBundle(evaluationCase, result);
        }
        const result = await client.verifyCitation(
          citationRequestFor(evaluationCase, citationSources),
        );
        return observationFromCitationResult(evaluationCase, result);
      } catch (error) {
        return failedEvaluationObservation(evaluationCase, options, errorKind(error));
      }
    };
    const warmupObservations = [];
    for (const evaluationCase of liveCorpus.cases) {
      warmupObservations.push(await evaluateCase(evaluationCase));
    }
    if (warmupObservations.some((observation) => observation.errorKind !== null)) {
      throw new ConfigurationError({
        reason: "Live evaluation warm-up did not complete every corpus case",
      });
    }
    const sourceHashes = new Map<string, Set<string>>();
    for (const [index, evaluationCase] of liveCorpus.cases.entries()) {
      if (evaluationCase.rfc === null) continue;
      const observation = warmupObservations[index];
      if (observation === undefined) {
        throw new ConfigurationError({
          reason: `Live evaluation did not produce source metadata for ${evaluationCase.id}`,
        });
      }
      const hashes = sourceHashes.get(evaluationCase.rfc) ?? new Set<string>();
      for (const hash of observation.sourceHashes) hashes.add(hash);
      sourceHashes.set(evaluationCase.rfc, hashes);
    }
    options = {
      ...options,
      authoritativeSourceHashes: Object.fromEntries(
        [...sourceHashes.entries()]
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([identifier, hashes]) => [identifier, [...hashes].sort()]),
      ),
    };
    const report = await runEvaluation(timedCorpus, evaluateCase, options);
    const output = `${JSON.stringify(report, null, 2)}\n`;
    await mkdir(dirname(config.evaluationOutput), { recursive: true });
    await writeFile(config.evaluationOutput, output, "utf8");
    process.stdout.write(output);
    return report.gate.passed ? 0 : 2;
  } finally {
    await client.close();
  }
};
