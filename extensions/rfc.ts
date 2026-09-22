import { spawn } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  datatrackerTopicSearchTermLimit,
  datatrackerTopicSearchTermMaximumCharacters,
  schemaVersion,
  type CitationVerificationResult,
  type EvidenceBundle,
  type RfcSourceCacheRemoveResult,
  type RfcSourceCacheStatus,
} from "../packages/rfc-core/src";
import { rfcAgentToolMetadata, rfcMcpInstructions } from "../packages/rfc/src/agent-surface";
import type { AuthStatus } from "../packages/rfc/src/credentials";
import {
  renderAuthStatus,
  renderCitationVerification,
  renderEvidenceBundle,
  renderSourceCacheRemove,
  renderSourceCacheStatus,
} from "../packages/rfc/src/operations";
import { Type } from "typebox";

const rfcPackageSpec = "@wyattjoh/rfc@0.1.0";
const commandTimeoutMilliseconds = 180_000;
const commandOutputMaximumBytes = 1024 * 1024;

const nonEmptyString = (description: string) => Type.String({ description, minLength: 1 });

const knownRfcResearchParameters = Type.Object(
  {
    question: nonEmptyString("One independently answerable RFC question"),
    rfc: nonEmptyString("Exact published RFC identifier, for example RFC9110"),
  },
  { additionalProperties: false },
);

const topicResearchParameters = Type.Object(
  {
    question: nonEmptyString("One independently answerable topic question"),
    searchTerms: Type.Array(
      Type.String({
        description:
          "Deliberate topic-discovery term sent verbatim in Datatracker query URLs and upstream logs",
        minLength: 1,
        maxLength: datatrackerTopicSearchTermMaximumCharacters,
      }),
      { minItems: 1, maxItems: datatrackerTopicSearchTermLimit },
    ),
  },
  { additionalProperties: false },
);

const citationParameters = Type.Object(
  {
    rfc: nonEmptyString("Exact published RFC identifier containing the quotation"),
    claim: nonEmptyString("One factual claim to check"),
    quote: nonEmptyString("Exact unchanged RFC quotation"),
    offset: Type.Optional(
      Type.Integer({
        description:
          "Absolute UTF-8 byte offset copied from research provenance; omit for a unique quotation",
        minimum: 0,
      }),
    ),
  },
  { additionalProperties: false },
);

const rfcParameters = Type.Object(
  {
    rfc: nonEmptyString("Exact named RFC source-cache entry, for example RFC9110"),
  },
  { additionalProperties: false },
);

const sourceCacheRemoveParameters = Type.Object(
  {
    rfc: nonEmptyString("Exact named RFC source-cache entry, for example RFC9110"),
    confirm: Type.Literal(true, {
      description: "Must be true to confirm removal of the named cache entry",
    }),
  },
  { additionalProperties: false },
);

const emptyParameters = Type.Object({}, { additionalProperties: false });

type RfcToolDetails = {
  readonly structuredContent: object;
  readonly warnings: ReadonlyArray<object>;
};

type RfcCommandResult<A extends object> = {
  readonly value: A;
  readonly warnings: ReadonlyArray<object>;
};

const successResult = (
  structuredContent: object,
  text: string,
  warnings: ReadonlyArray<object> = [],
) => ({
  content: [
    { type: "text" as const, text },
    ...warnings.map((warning) => ({ type: "text" as const, text: JSON.stringify(warning) })),
  ],
  details: { structuredContent, warnings } satisfies RfcToolDetails,
});

const parseJsonObject = (value: string): object | undefined => {
  try {
    const parsed: unknown = JSON.parse(value);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? parsed
      : undefined;
  } catch {
    return undefined;
  }
};

const runRfcCommand = <A extends object>(
  args: ReadonlyArray<string>,
  input: object | undefined,
  signal: AbortSignal | undefined,
): Promise<RfcCommandResult<A>> =>
  new Promise((resolve, reject) => {
    signal?.throwIfAborted();

    const child = spawn("bunx", [rfcPackageSpec, ...args], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout: Array<Buffer> = [];
    const stderr: Array<Buffer> = [];
    let outputBytes = 0;
    let outputError: Error | undefined;
    let settled = false;

    const cleanup = (): void => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
    };
    const finishWithError = (error: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const abort = (): void => {
      child.kill("SIGTERM");
      finishWithError(new Error("RFC tool execution was cancelled"));
    };
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      finishWithError(new Error("RFC tool execution timed out"));
    }, commandTimeoutMilliseconds);
    const capture = (chunks: Array<Buffer>) => (chunk: Buffer) => {
      outputBytes += chunk.byteLength;
      if (outputBytes > commandOutputMaximumBytes) {
        outputError = new Error("RFC tool output exceeded 1048576 bytes");
        child.kill("SIGTERM");
        return;
      }
      chunks.push(chunk);
    };

    signal?.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", capture(stdout));
    child.stderr.on("data", capture(stderr));
    child.once("error", finishWithError);
    child.once("close", (code) => {
      if (settled) return;
      if (outputError !== undefined) {
        finishWithError(outputError);
        return;
      }

      const stdoutText = Buffer.concat(stdout).toString("utf8").trim();
      const stderrLines = Buffer.concat(stderr)
        .toString("utf8")
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
      const stderrObjects = stderrLines.flatMap((line) => {
        const parsed = parseJsonObject(line);
        return parsed === undefined ? [] : [parsed];
      });

      if (code !== 0) {
        const envelope = stderrObjects.find((entry) => "kind" in entry && entry.kind === "error");
        finishWithError(
          new Error(
            envelope === undefined
              ? "RFC CLI failed without a versioned error envelope"
              : JSON.stringify(envelope),
          ),
        );
        return;
      }

      const value = parseJsonObject(stdoutText);
      if (value === undefined) {
        finishWithError(new Error("RFC CLI returned an invalid JSON result"));
        return;
      }

      settled = true;
      cleanup();
      resolve({ value: value as A, warnings: stderrObjects });
    });

    child.stdin.on("error", () => undefined);
    child.stdin.end(input === undefined ? undefined : `${JSON.stringify(input)}\n`);
  });

/**
 * Register the RFC evidence engine as native Pi tools with the MCP surface's names and metadata.
 *
 * @param pi Pi extension API used to register tools and prompt guidance.
 */
export default function rfcExtension(pi: ExtensionAPI): void {
  pi.on("before_agent_start", (event) => {
    event.systemPromptOptions.sections.rfc_evidence_engine = rfcMcpInstructions;
  });

  pi.registerTool({
    name: rfcAgentToolMetadata.researchKnownRfc.name,
    label: rfcAgentToolMetadata.researchKnownRfc.title,
    description: rfcAgentToolMetadata.researchKnownRfc.description,
    promptSnippet: rfcAgentToolMetadata.researchKnownRfc.title,
    parameters: knownRfcResearchParameters,
    async execute(_toolCallId, { question, rfc }, signal) {
      const result = await runRfcCommand<EvidenceBundle>(
        ["research"],
        { schemaVersion, question, rfc },
        signal,
      );
      return successResult(result.value, renderEvidenceBundle(result.value), result.warnings);
    },
  });

  pi.registerTool({
    name: rfcAgentToolMetadata.researchTopic.name,
    label: rfcAgentToolMetadata.researchTopic.title,
    description: rfcAgentToolMetadata.researchTopic.description,
    promptSnippet: rfcAgentToolMetadata.researchTopic.title,
    parameters: topicResearchParameters,
    async execute(_toolCallId, { question, searchTerms }, signal) {
      const result = await runRfcCommand<EvidenceBundle>(
        ["research"],
        { schemaVersion, question, rfc: null, searchTerms },
        signal,
      );
      return successResult(result.value, renderEvidenceBundle(result.value), result.warnings);
    },
  });

  pi.registerTool({
    name: rfcAgentToolMetadata.verifyCitation.name,
    label: rfcAgentToolMetadata.verifyCitation.title,
    description: rfcAgentToolMetadata.verifyCitation.description,
    promptSnippet: rfcAgentToolMetadata.verifyCitation.title,
    parameters: citationParameters,
    async execute(_toolCallId, { rfc, claim, quote, offset }, signal) {
      const result = await runRfcCommand<CitationVerificationResult>(
        ["verify-citation"],
        { schemaVersion, rfc, claim, quote, offset: offset ?? null },
        signal,
      );
      return successResult(result.value, renderCitationVerification(result.value), result.warnings);
    },
  });

  pi.registerTool({
    name: rfcAgentToolMetadata.sourceCacheStatus.name,
    label: rfcAgentToolMetadata.sourceCacheStatus.title,
    description: rfcAgentToolMetadata.sourceCacheStatus.description,
    promptSnippet: rfcAgentToolMetadata.sourceCacheStatus.title,
    parameters: rfcParameters,
    async execute(_toolCallId, { rfc }, signal) {
      const result = await runRfcCommand<RfcSourceCacheStatus>(
        ["cache", "status", "--rfc", rfc, "--format", "json"],
        undefined,
        signal,
      );
      return successResult(result.value, renderSourceCacheStatus(result.value), result.warnings);
    },
  });

  pi.registerTool({
    name: rfcAgentToolMetadata.sourceCacheRemove.name,
    label: rfcAgentToolMetadata.sourceCacheRemove.title,
    description: rfcAgentToolMetadata.sourceCacheRemove.description,
    promptSnippet: rfcAgentToolMetadata.sourceCacheRemove.title,
    parameters: sourceCacheRemoveParameters,
    async execute(_toolCallId, { rfc }, signal) {
      const result = await runRfcCommand<RfcSourceCacheRemoveResult>(
        ["cache", "remove", "--rfc", rfc, "--format", "json"],
        undefined,
        signal,
      );
      return successResult(result.value, renderSourceCacheRemove(result.value), result.warnings);
    },
  });

  pi.registerTool({
    name: rfcAgentToolMetadata.authStatus.name,
    label: rfcAgentToolMetadata.authStatus.title,
    description: rfcAgentToolMetadata.authStatus.description,
    promptSnippet: rfcAgentToolMetadata.authStatus.title,
    parameters: emptyParameters,
    async execute(_toolCallId, _params, signal) {
      const result = await runRfcCommand<AuthStatus>(
        ["auth", "status", "--format", "json"],
        undefined,
        signal,
      );
      return successResult(result.value, renderAuthStatus(result.value), result.warnings);
    },
  });
}
