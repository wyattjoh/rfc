import { spawn } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type {
  CitationVerificationResult,
  EvidenceBundle,
  RfcSourceCacheRemoveResult,
  RfcSourceCacheStatus,
} from "@wyattjoh/rfc-core";
import type { AuthStatus } from "@wyattjoh/rfc";
import {
  datatrackerTopicSearchTermLimit,
  datatrackerTopicSearchTermMaximumCharacters,
  renderAuthStatus,
  renderCitationVerification,
  renderEvidenceBundle,
  renderSourceCacheRemove,
  renderSourceCacheStatus,
  rfcAgentToolMetadata,
  rfcMcpInstructions,
  schemaVersion,
} from "@wyattjoh/rfc/agent";
import { Type } from "typebox";
import rfcPiPackage from "../package.json" with { type: "json" };

/**
 * The CLI is pinned to the exact version this package depends on.
 *
 * A dist-tag would re-resolve against the registry on every tool call and could
 * run a CLI this package was never tested against. `release-please`'s
 * `node-workspace` plugin rewrites this dependency whenever the CLI is
 * released, so the pin follows the published version without manual edits.
 */
const rfcPackageSpec = `@wyattjoh/rfc@${rfcPiPackage.dependencies["@wyattjoh/rfc"]}`;
const commandTimeoutMilliseconds = 180_000;
const commandOutputMaximumBytes = 1024 * 1024;
const commandStderrMaximumCharacters = 2_000;
const commandFailureRetentionLimit = 32;

/**
 * Raw diagnostics from an RFC CLI process that exited non-zero.
 */
type RfcCommandFailureDiagnostics = {
  /**
   * Process exit code, or null when the process was terminated by a signal.
   */
  readonly exitCode: number | null;
  /**
   * Bounded stderr text exactly as the CLI wrote it.
   */
  readonly stderr: string;
};

/**
 * A non-zero RFC CLI exit, carrying the diagnostics that name its cause.
 */
class RfcCommandFailure extends Error {
  readonly diagnostics: RfcCommandFailureDiagnostics;

  constructor(message: string, diagnostics: RfcCommandFailureDiagnostics) {
    super(message);
    this.name = "RfcCommandFailure";
    this.diagnostics = diagnostics;
  }
}

/**
 * Diagnostics awaiting the `tool_result` hook, keyed by tool call.
 *
 * Pi replaces a thrown tool error with a result whose `details` is `{}`, so a
 * throw alone destroys the exit code and stderr at the point of failure. The
 * hook reattaches them to the recorded result without turning the failure into
 * an apparent success.
 */
const commandFailures = new Map<string, RfcCommandFailureDiagnostics>();

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

/**
 * Environment variable that replaces the published CLI for a session.
 */
const rfcCliCommandVariable = "RFC_CLI_COMMAND";

/**
 * The executable and leading arguments used to run the RFC CLI.
 */
type RfcCliInvocation = {
  /**
   * Executable resolved through PATH, or an absolute path.
   */
  readonly command: string;
  /**
   * Arguments placed before the per-tool arguments.
   */
  readonly prefixArguments: ReadonlyArray<string>;
};

/**
 * Resolve how to run the RFC CLI, honouring a development override.
 *
 * `RFC_CLI_COMMAND` accepts a JSON array for a command with arguments, for
 * example `["bun","/path/to/packages/rfc/src/bin.ts"]`, or a bare executable
 * path. It exists so a working-tree CLI can be exercised without publishing;
 * unset, the pinned published package is used. The variable selects an
 * executable, which is no more exposure than PATH already carries for `bunx`.
 *
 * Read per call rather than at module load so a session can set it late.
 *
 * @returns The command and leading arguments to spawn.
 */
const resolveRfcInvocation = (): RfcCliInvocation => {
  const override = process.env[rfcCliCommandVariable]?.trim();
  if (override === undefined || override.length === 0) {
    return { command: "bunx", prefixArguments: [rfcPackageSpec] };
  }
  if (!override.startsWith("[")) return { command: override, prefixArguments: [] };

  const parsed: unknown = ((): unknown => {
    try {
      return JSON.parse(override);
    } catch {
      return undefined;
    }
  })();
  if (
    !Array.isArray(parsed) ||
    parsed.length === 0 ||
    !parsed.every((entry) => typeof entry === "string" && entry.length > 0)
  ) {
    throw new Error(
      `${rfcCliCommandVariable} must be a non-empty executable path or a JSON array of non-empty strings`,
    );
  }
  return { command: parsed[0] as string, prefixArguments: (parsed as Array<string>).slice(1) };
};

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

    const invocation = resolveRfcInvocation();
    const child = spawn(invocation.command, [...invocation.prefixArguments, ...args], {
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
        const stderrText = stderrLines.join(" | ").slice(0, commandStderrMaximumCharacters);
        finishWithError(
          new RfcCommandFailure(
            envelope === undefined
              ? `RFC CLI failed without a versioned error envelope (exit ${String(code)}); stderr: ${
                  stderrText.length === 0 ? "<empty>" : stderrText
                }`
              : JSON.stringify(envelope),
            { exitCode: code, stderr: stderrText },
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
 * Run one RFC CLI command, retaining the diagnostics of a non-zero exit so the
 * `tool_result` hook can record them against this tool call.
 *
 * @param toolCallId Pi tool call the command belongs to.
 * @param args Command arguments appended to the RFC CLI package spec.
 * @param input Structured standard input, when the command reads one.
 * @param signal Cancellation signal for the tool call.
 * @returns The decoded CLI result and any warnings it emitted.
 */
const runToolCommand = <A extends object>(
  toolCallId: string,
  args: ReadonlyArray<string>,
  input: object | undefined,
  signal: AbortSignal | undefined,
): Promise<RfcCommandResult<A>> =>
  runRfcCommand<A>(args, input, signal).catch((error: unknown) => {
    if (error instanceof RfcCommandFailure) {
      if (commandFailures.size >= commandFailureRetentionLimit) {
        const oldest = commandFailures.keys().next();
        if (oldest.done !== true) commandFailures.delete(oldest.value);
      }
      commandFailures.set(toolCallId, error.diagnostics);
    }
    throw error;
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

  pi.on("tool_result", (event) => {
    const diagnostics = commandFailures.get(event.toolCallId);
    if (diagnostics === undefined) return undefined;
    commandFailures.delete(event.toolCallId);
    return { details: diagnostics };
  });

  pi.registerTool({
    name: rfcAgentToolMetadata.researchKnownRfc.name,
    label: rfcAgentToolMetadata.researchKnownRfc.title,
    description: rfcAgentToolMetadata.researchKnownRfc.description,
    promptSnippet: rfcAgentToolMetadata.researchKnownRfc.title,
    parameters: knownRfcResearchParameters,
    async execute(toolCallId, { question, rfc }, signal) {
      const result = await runToolCommand<EvidenceBundle>(
        toolCallId,
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
    async execute(toolCallId, { question, searchTerms }, signal) {
      const result = await runToolCommand<EvidenceBundle>(
        toolCallId,
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
    async execute(toolCallId, { rfc, claim, quote, offset }, signal) {
      const result = await runToolCommand<CitationVerificationResult>(
        toolCallId,
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
    async execute(toolCallId, { rfc }, signal) {
      const result = await runToolCommand<RfcSourceCacheStatus>(
        toolCallId,
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
    async execute(toolCallId, { rfc }, signal) {
      const result = await runToolCommand<RfcSourceCacheRemoveResult>(
        toolCallId,
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
    async execute(toolCallId, _params, signal) {
      const result = await runToolCommand<AuthStatus>(
        toolCallId,
        // `auth` reports status itself; its only subcommands are login and remove.
        ["auth", "--format", "json"],
        undefined,
        signal,
      );
      return successResult(result.value, renderAuthStatus(result.value), result.warnings);
    },
  });
}
