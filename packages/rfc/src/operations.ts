import {
  ConfigurationError,
  createRfcClient,
  decodeCitationVerificationRequest,
  decodeResearchRequest,
  schemaVersion,
  toErrorEnvelope,
  type CitationVerificationRequest,
  type CitationVerificationResult,
  type ErrorEnvelope,
  type EvidenceBundle,
  type ResearchRequest,
  type RfcClient,
  type RfcSourceCacheRemoveResult,
  type RfcSourceCacheStatus,
} from "@wyattjoh/rfc-core";
import { automaticAnswerActivationFor, readCliConfig } from "./config";
import {
  CredentialInputError,
  CredentialMissingError,
  CredentialStoreError,
  resolveStoredCredential,
  storedCredentialStatus,
  type AuthStatus,
  type CredentialStore,
} from "./credentials";
import type { UsageRecorder } from "./usage-store";

/**
 * Trusted process configuration applied to one RFC operation.
 */
export interface RfcOperationOptions {
  /**
   * Directory containing cached canonical RFC sources.
   */
  readonly cacheDirectory: string;
  /**
   * Optional Datatracker API base URL selected by the process operator.
   */
  readonly datatrackerApiUrl: string | undefined;
  /**
   * Optional TypeSafe API URL selected by the process operator.
   */
  readonly typeSafeApiUrl: string | undefined;
}

/**
 * Injectable side effects shared by CLI and MCP operations.
 */
export interface RfcOperationDependencies {
  /**
   * Credential boundary used for provider construction and safe status checks.
   */
  readonly credentialStore: CredentialStore;
  /**
   * Persist one successful semantic operation in the per-user usage totals.
   */
  readonly recordUsage: UsageRecorder;
  /**
   * Construct the RFC client for one operation.
   */
  readonly createClient: typeof createRfcClient;
}

/**
 * Safe warning emitted when a successful semantic operation cannot update usage totals.
 */
export interface RfcOperationWarning {
  /**
   * Public protocol version.
   */
  readonly schemaVersion: typeof schemaVersion;
  /**
   * Identifies a non-fatal operation warning.
   */
  readonly kind: "warning";
  /**
   * Stable warning code and safe message.
   */
  readonly warning: {
    readonly code: "usage_accounting_failed";
    readonly message: string;
  };
}

/**
 * Successful operation value plus any non-fatal warnings produced after it completed.
 */
export interface RfcOperationResult<A> {
  /**
   * Validated operation result.
   */
  readonly value: A;
  /**
   * Non-fatal warnings that callers should surface without encouraging a retry.
   */
  readonly warnings: ReadonlyArray<RfcOperationWarning>;
}

const usageAccountingWarning = Object.freeze({
  schemaVersion,
  kind: "warning",
  warning: {
    code: "usage_accounting_failed",
    message: "Unable to update the per-user RFC usage totals",
  },
} as const satisfies RfcOperationWarning);

const renderTokenCount = (value: number | null): string => value?.toString() ?? "unavailable";

/**
 * Render an estimated USD value consistently across CLI output.
 *
 * @param value Estimated cost, or null when pricing is unavailable.
 * @returns A dollar value with fixed sub-cent precision or `unavailable`.
 */
export const renderEstimatedUsd = (value: number | null): string =>
  value === null ? "unavailable" : `$${value.toFixed(9)}`;

const credentialErrorEnvelope = (error: unknown): ErrorEnvelope | undefined => {
  if (error instanceof CredentialMissingError) {
    return {
      schemaVersion,
      kind: "error",
      error: {
        code: "credential_missing",
        message: "No TypeSafe API key is configured; run `rfc auth add`",
      },
    };
  }

  if (error instanceof CredentialInputError) {
    return {
      schemaVersion,
      kind: "error",
      error: {
        code: "invalid_input",
        message: "The TypeSafe API key input is invalid",
      },
    };
  }

  if (error instanceof CredentialStoreError) {
    const messages = {
      unavailable: "The platform credential store is unavailable",
      denied: "Access to the platform credential store was denied",
      storage: "Unable to store the TypeSafe API key",
      deletion: "Unable to remove the TypeSafe API key",
    } as const;
    const codes = {
      unavailable: "credential_store_unavailable",
      denied: "credential_access_denied",
      storage: "credential_storage_failed",
      deletion: "credential_deletion_failed",
    } as const;
    return {
      schemaVersion,
      kind: "error",
      error: {
        code: codes[error.kind],
        message: messages[error.kind],
      },
    };
  }

  return undefined;
};

const withClient = async <A>(
  create: () => Promise<RfcClient>,
  use: (client: RfcClient) => Promise<A>,
): Promise<A> => {
  const client = await create();
  try {
    return await use(client);
  } finally {
    await client.close();
  }
};

const readOperationConfig = () => {
  try {
    return readCliConfig();
  } catch (error) {
    throw new ConfigurationError({
      reason: error instanceof Error ? error.message : "Unknown configuration error",
    });
  }
};

const createSemanticClient = async (
  options: RfcOperationOptions,
  dependencies: RfcOperationDependencies,
): Promise<RfcClient> => {
  const cliConfig = readOperationConfig();
  const apiKey = await resolveStoredCredential(dependencies.credentialStore);
  return dependencies.createClient({
    cacheDirectory: options.cacheDirectory,
    datatrackerApiUrl: options.datatrackerApiUrl,
    modelAlias: cliConfig.modelAlias,
    policyPreset: cliConfig.policyPreset,
    automaticAnswerActivation: automaticAnswerActivationFor(cliConfig),
    typeSafeApiKey: apiKey,
    typeSafeApiUrl: options.typeSafeApiUrl,
  });
};

const recordResultUsage = async (
  dependencies: RfcOperationDependencies,
  inputTokens: number | null,
  estimatedInputCostUsd: number | null,
): Promise<ReadonlyArray<RfcOperationWarning>> => {
  try {
    await dependencies.recordUsage({ inputTokens, estimatedInputCostUsd });
    return [];
  } catch {
    return [usageAccountingWarning];
  }
};

/**
 * Map an operation failure to the safe versioned error contract shared by CLI and MCP.
 *
 * @param error Rejected operation value.
 * @returns An envelope that never contains credential values or unsafe platform details.
 */
export const toRfcOperationErrorEnvelope = (error: unknown): ErrorEnvelope =>
  credentialErrorEnvelope(error) ?? toErrorEnvelope(error);

/**
 * Research one validated known-RFC or topic request.
 *
 * @param request Unknown input decoded through the public version-two request schema.
 * @param options Trusted process configuration.
 * @param dependencies Injectable operation boundaries.
 * @returns The evidence bundle and any non-fatal usage warning.
 */
export const executeResearch = async (
  request: ResearchRequest | unknown,
  options: RfcOperationOptions,
  dependencies: RfcOperationDependencies,
): Promise<RfcOperationResult<EvidenceBundle>> => {
  const decoded = decodeResearchRequest(request);
  const value = await withClient(
    () => createSemanticClient(options, dependencies),
    (client) => client.research(decoded),
  );
  return {
    value,
    warnings: await recordResultUsage(
      dependencies,
      value.diagnostics.usage.inputTokens,
      value.diagnostics.inputCost.estimatedUsd,
    ),
  };
};

/**
 * Verify one validated factual claim against one exact RFC quotation.
 *
 * @param request Unknown input decoded through the public version-two citation schema.
 * @param options Trusted process configuration.
 * @param dependencies Injectable operation boundaries.
 * @returns The citation verdict and any non-fatal usage warning.
 */
export const executeCitationVerification = async (
  request: CitationVerificationRequest | unknown,
  options: RfcOperationOptions,
  dependencies: RfcOperationDependencies,
): Promise<RfcOperationResult<CitationVerificationResult>> => {
  const decoded = decodeCitationVerificationRequest(request);
  const value = await withClient(
    () => createSemanticClient(options, dependencies),
    (client) => client.verifyCitation(decoded),
  );
  return {
    value,
    warnings: await recordResultUsage(
      dependencies,
      value.diagnostics.usage.inputTokens,
      value.diagnostics.inputCost.estimatedUsd,
    ),
  };
};

/**
 * Inspect one named RFC source-cache entry without network access.
 *
 * @param rfc RFC identifier to inspect.
 * @param options Trusted process configuration.
 * @param dependencies Injectable operation boundaries.
 * @returns Local source-cache status.
 */
export const executeSourceCacheStatus = (
  rfc: string,
  options: RfcOperationOptions,
  dependencies: RfcOperationDependencies,
): Promise<RfcSourceCacheStatus> =>
  withClient(
    () =>
      dependencies.createClient({
        cacheDirectory: options.cacheDirectory,
        modelAlias: undefined,
        automaticAnswerActivation: undefined,
        typeSafeApiKey: undefined,
        typeSafeApiUrl: undefined,
      }),
    (client) => client.sourceCacheStatus(rfc),
  );

/**
 * Remove one named RFC source-cache entry without network access.
 *
 * @param rfc RFC identifier to remove.
 * @param options Trusted process configuration.
 * @param dependencies Injectable operation boundaries.
 * @returns Whether the named entry existed and was removed.
 */
export const executeSourceCacheRemove = (
  rfc: string,
  options: RfcOperationOptions,
  dependencies: RfcOperationDependencies,
): Promise<RfcSourceCacheRemoveResult> =>
  withClient(
    () =>
      dependencies.createClient({
        cacheDirectory: options.cacheDirectory,
        modelAlias: undefined,
        automaticAnswerActivation: undefined,
        typeSafeApiKey: undefined,
        typeSafeApiUrl: undefined,
      }),
    (client) => client.sourceCacheRemove(rfc),
  );

/**
 * Inspect safe TypeSafe credential metadata without revealing the credential.
 *
 * @param dependencies Injectable operation boundaries.
 * @returns Whether the stable credential identity is configured.
 */
export const executeAuthStatus = (dependencies: RfcOperationDependencies): Promise<AuthStatus> =>
  storedCredentialStatus(dependencies.credentialStore);

/**
 * Render one evidence bundle for concise agent or human consumption.
 *
 * @param result Version-two evidence bundle.
 * @returns Multi-line text preserving statuses, qualifications, provenance, and cost.
 */
export const renderEvidenceBundle = (result: EvidenceBundle): string => {
  const lines = [`Status: ${result.status}`, `RFC: ${result.rfc?.identifier ?? "none discovered"}`];
  for (const context of result.contexts ?? []) {
    lines.push(`Context: ${context.role} ${context.document.identifier} (${context.state})`);
  }
  for (const passage of result.evidence) {
    lines.push(
      `Evidence RFC: ${passage.provenance.identifier} (${passage.context} context)`,
      `Section: ${passage.provenance.section ?? "unknown"}`,
      `Quote: ${passage.quote}`,
      `Source: ${passage.provenance.sourceUrl}`,
      `Offsets: ${passage.provenance.startOffset}-${passage.provenance.endOffset} (${passage.provenance.offsetUnit})`,
    );
  }
  for (const candidate of result.reviewCandidates ?? []) {
    lines.push(
      "Review candidate: not accepted evidence",
      `Candidate RFC: ${candidate.provenance.identifier} (${candidate.context} context)`,
      `Section: ${candidate.provenance.section ?? "unknown"}`,
      `Quote: ${candidate.quote}`,
      `Source: ${candidate.provenance.sourceUrl}`,
      `Offsets: ${candidate.provenance.startOffset}-${candidate.provenance.endOffset} (${candidate.provenance.offsetUnit})`,
    );
  }
  lines.push(
    `Input tokens: ${renderTokenCount(result.diagnostics.usage.inputTokens)}`,
    `Estimated input cost (USD): ${renderEstimatedUsd(result.diagnostics.inputCost.estimatedUsd)}`,
  );
  return lines.join("\n");
};

/**
 * Render one citation-verification result for concise agent or human consumption.
 *
 * @param result Version-two citation verdict.
 * @returns Multi-line text preserving verdict, provenance, and cost.
 */
export const renderCitationVerification = (result: CitationVerificationResult): string =>
  [
    `Verdict: ${result.verdict}`,
    `RFC: ${result.rfc.identifier}`,
    `Quote: ${result.quote}`,
    `Offsets: ${result.provenance.startOffset ?? "unknown"}-${result.provenance.endOffset ?? "unknown"}`,
    `Section: ${result.provenance.section ?? "unknown"}`,
    `Source: ${result.provenance.sourceUrl}`,
    `Input tokens: ${renderTokenCount(result.diagnostics.usage.inputTokens)}`,
    `Estimated input cost (USD): ${renderEstimatedUsd(result.diagnostics.inputCost.estimatedUsd)}`,
  ].join("\n");

/**
 * Render one local source-cache status.
 *
 * @param result Version-two source-cache status.
 * @returns Concise multi-line status text.
 */
export const renderSourceCacheStatus = (result: RfcSourceCacheStatus): string =>
  `RFC: ${result.rfc}\nCache: ${result.state}`;

/**
 * Render one local source-cache removal result.
 *
 * @param result Version-two source-cache removal result.
 * @returns Concise multi-line removal text.
 */
export const renderSourceCacheRemove = (result: RfcSourceCacheRemoveResult): string =>
  `RFC: ${result.rfc}\nCache: ${result.removed ? "removed" : "missing"}`;

/**
 * Render safe credential status metadata.
 *
 * @param result Version-two credential status.
 * @returns Concise multi-line credential status text.
 */
export const renderAuthStatus = (result: AuthStatus): string =>
  [
    `Credential: ${result.configured ? "configured" : "not configured"}`,
    `Service: ${result.service}`,
    `Name: ${result.name}`,
  ].join("\n");
