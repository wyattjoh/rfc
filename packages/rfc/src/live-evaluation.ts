import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  ConfigurationError,
  evaluationCorpus,
  evaluationCorpusDigest,
  evaluationModelAlias,
  evaluationPolicy,
  evaluationReleaseAttestation,
  failedEvaluationObservation,
  observationFromCitationResult,
  observationFromEvidenceBundle,
  pinnedJevModel,
  runEvaluation,
  type EvaluationCase,
  type EvaluationReportOptions,
} from "@wyattjoh/rfc-core";
import { readCliConfig } from "./config";
import {
  makeDefaultCredentialStore,
  resolveStoredCredential,
  type CredentialStore,
} from "./credentials";
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

const researchRequestFor = (evaluationCase: EvaluationCase) => {
  if (evaluationCase.question === null) {
    throw new Error(`Research case ${evaluationCase.id} is missing a question`);
  }
  return evaluationCase.rfc === null
    ? {
        schemaVersion: 2 as const,
        question: evaluationCase.question,
        rfc: null,
        searchTerms: evaluationCase.searchTerms ?? ["HTTP client request message"],
      }
    : {
        schemaVersion: 2 as const,
        question: evaluationCase.question,
        rfc: evaluationCase.rfc,
        searchTerms: undefined,
      };
};

const citationRequestFor = (evaluationCase: EvaluationCase) => {
  if (
    evaluationCase.rfc === null ||
    evaluationCase.claim === null ||
    evaluationCase.quote === null
  ) {
    throw new Error(`Citation case ${evaluationCase.id} is incomplete`);
  }
  return {
    schemaVersion: 2 as const,
    rfc: evaluationCase.rfc,
    claim: evaluationCase.claim,
    quote: evaluationCase.quote,
    offset: evaluationCase.offset,
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
 * Injectable dependencies for the opt-in live evaluator.
 */
export interface LiveEvaluationOptions {
  /**
   * Credential boundary shared with ordinary research and citation commands.
   */
  readonly credentialStore: CredentialStore | undefined;
  /**
   * Explicit command-level opt-in for a live provider run.
   */
  readonly enable: boolean | undefined;
}

const defaultLiveEvaluationOptions: LiveEvaluationOptions = {
  credentialStore: undefined,
  enable: true,
};

/**
 * Run the opt-in live TypeSafe calibration against authoritative RFC Editor sources.
 *
 * An untimed pass over every live case warms request-local source entries before
 * three sequential timed iterations. This preserves a bounded provider call
 * order while excluding cache warming from both p95 gates. The provider key is
 * resolved from the same injectable Bun.secrets boundary used by the CLI.
 *
 * @param options Explicit live-run opt-in and credential boundary.
 * @returns Zero when every precision, safety, latency, and model gate passes;
 * otherwise two.
 */
export const runLiveEvaluation = async (
  runtimeOptions: LiveEvaluationOptions = defaultLiveEvaluationOptions,
): Promise<number> => {
  let config: ReturnType<typeof readCliConfig>;
  try {
    config = readCliConfig({
      liveEvaluation: runtimeOptions.enable,
      automaticAnswerEnabled: undefined,
      evaluationCacheDirectory: undefined,
      evaluationOutput: undefined,
    });
  } catch (error) {
    throw new ConfigurationError({
      reason:
        error instanceof Error ? error.message : "Unable to validate live evaluation configuration",
    });
  }
  if (!config.liveEvaluation) {
    throw new ConfigurationError({
      reason: "Live evaluation is disabled; pass the explicit live-evaluation opt-in",
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

  let reportOptions: EvaluationReportOptions = {
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
  const apiKey = await resolveStoredCredential(
    runtimeOptions.credentialStore ?? makeDefaultCredentialStore(),
  );
  const client = await createRfcCalibrationClient({
    cacheDirectory: config.evaluationCacheDirectory,
    modelAlias: config.evaluationModel,
    policyPreset: config.policyPreset,
    typeSafeApiKey: apiKey,
    typeSafeApiUrl: undefined,
  });

  try {
    const evaluateCase = async (evaluationCase: EvaluationCase) => {
      try {
        if (evaluationCase.kind === "research") {
          const result = await client.research(researchRequestFor(evaluationCase));
          return observationFromEvidenceBundle(evaluationCase, result);
        }
        const result = await client.verifyCitation(citationRequestFor(evaluationCase));
        return observationFromCitationResult(evaluationCase, result);
      } catch (error) {
        return failedEvaluationObservation(evaluationCase, reportOptions, errorKind(error));
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
    reportOptions = {
      ...reportOptions,
      authoritativeSourceHashes: Object.fromEntries(
        [...sourceHashes.entries()]
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([identifier, hashes]) => [identifier, [...hashes].sort()]),
      ),
    };
    const report = await runEvaluation(timedCorpus, evaluateCase, reportOptions);
    const output = `${JSON.stringify(report, null, 2)}\n`;
    await mkdir(dirname(config.evaluationOutput), { recursive: true });
    await writeFile(config.evaluationOutput, output, "utf8");
    process.stdout.write(output);
    return report.gate.passed ? 0 : 2;
  } finally {
    await client.close();
  }
};
