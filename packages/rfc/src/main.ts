import {
  InvalidInputError,
  createRfcClient,
  decodeCitationVerificationRequest,
  decodeResearchRequest,
  defaultCacheDirectory,
  schemaVersion,
} from "@wyattjoh/rfc-core";
import { NodeServices } from "@effect/platform-node";
import { Console, Effect, Option } from "effect";
import { Argument, CliError, Command, Flag } from "effect/unstable/cli";
import packageMetadata from "../package.json" with { type: "json" };
import { runRfcMcpServer } from "./mcp";
import {
  executeAuthStatus,
  executeCitationVerification,
  executeResearch,
  executeSourceCacheRemove,
  executeSourceCacheStatus,
  renderAuthStatus,
  renderCitationVerification,
  renderEvidenceBundle,
  renderEstimatedUsd,
  renderSourceCacheRemove,
  renderSourceCacheStatus,
  toRfcOperationErrorEnvelope,
  type RfcOperationOptions,
  type RfcOperationWarning,
} from "./operations";
import {
  makeUsageReader,
  makeUsageRecorder,
  type UsageReader,
  type UsageRecorder,
  type UsageTotals,
} from "./usage-store";
import {
  CredentialInputError,
  addStoredCredential,
  makeDefaultCredentialStore,
  removeStoredCredential,
  type CredentialStore,
} from "./credentials";

/**
 * Injectable side effects used by the CLI composition root.
 *
 * Production uses process streams and Bun.secrets. Tests replace every
 * boundary so they never touch the operator's credential manager or terminal.
 */
export interface RfcCliDependencies {
  /**
   * Credential boundary used for provider construction and auth commands.
   */
  readonly credentialStore: CredentialStore;
  /**
   * Read the process standard input when a command explicitly permits it.
   */
  readonly readStandardInput: () => Promise<string>;
  /**
   * Read one credential through a masked interactive prompt.
   */
  readonly promptCredential: () => Promise<string>;
  /**
   * Write one already-rendered value to standard output.
   */
  readonly writeStdout: (value: string) => void;
  /**
   * Write one already-rendered value to standard error.
   */
  readonly writeStderr: (value: string) => void;
  /**
   * Read the cumulative per-user usage totals.
   */
  readonly readUsage: UsageReader;
  /**
   * Persist one successful operation in the per-user usage totals.
   */
  readonly recordUsage: UsageRecorder;
  /**
   * Construct the RFC client for one command invocation.
   *
   * Process-protocol tests substitute a stub here so they can assert decoding,
   * rendering, and exit status without reproducing retrieval internals.
   */
  readonly createClient: typeof createRfcClient;
}

const format = Flag.Literals("format", ["json", "human"] as const).pipe(
  Flag.withDescription(
    "Output format; defaults to human for arguments and JSON for structured standard input",
  ),
  Flag.optional,
);

const cacheDirectory = Flag.String("cache-directory").pipe(
  Flag.withDescription("Directory containing cached canonical RFC sources"),
  Flag.withDefault(defaultCacheDirectory),
);

const datatrackerApiUrl = Flag.String("datatracker-api-url").pipe(
  Flag.withDescription("Datatracker API base URL used for live discovery"),
  Flag.optional,
);

const question = Flag.String("question").pipe(
  Flag.withAlias("q"),
  Flag.withDescription("Short question used when standard input is not supplied"),
  Flag.optional,
);

const questionArgument = Argument.String("question").pipe(
  Argument.withDescription("Question to research when standard input is not supplied"),
  Argument.optional,
);

const rfc = Flag.String("rfc").pipe(
  Flag.withAlias("r"),
  Flag.withDescription("Known RFC identifier for a short interactive request"),
  Flag.optional,
);

const cacheRfc = Flag.String("rfc").pipe(
  Flag.withAlias("r"),
  Flag.withDescription("Named RFC source cache entry"),
  Flag.optional,
);

const rfcArgument = Argument.String("rfc").pipe(
  Argument.withDescription("Named RFC identifier"),
  Argument.optional,
);

const searchTerms = Flag.String("search-term").pipe(
  Flag.withDescription("Ordered topic-discovery term; repeat one to four times"),
  Flag.between(0, 4),
);

const typeSafeApiUrl = Flag.String("typesafe-api-url").pipe(
  Flag.withDescription("TypeSafe API URL used for deterministic or self-hosted providers"),
  Flag.optional,
);

const claim = Flag.String("claim").pipe(
  Flag.withDescription("Factual claim to verify when standard input is not supplied"),
  Flag.optional,
);

const claimArgument = Argument.String("claim").pipe(
  Argument.withDescription("Factual claim to verify when standard input is not supplied"),
  Argument.optional,
);

const quote = Flag.String("quote").pipe(
  Flag.withDescription("Exact RFC quotation to verify when standard input is not supplied"),
  Flag.optional,
);

const quoteArgument = Argument.String("quote").pipe(
  Argument.withDescription("Exact RFC quotation to verify when standard input is not supplied"),
  Argument.optional,
);

const offset = Flag.String("offset").pipe(
  Flag.withDescription("Absolute UTF-8 byte offset for a repeated quotation"),
  Flag.optional,
);

const credentialFromStdin = Flag.Boolean("stdin").pipe(
  Flag.withDescription("Read the TypeSafe API key from standard input; never use an argv value"),
  Flag.withDefault(false),
);

const credentialFromStdinAlias = Flag.Boolean("from-stdin").pipe(
  Flag.withDescription("Alias for --stdin"),
  Flag.withDefault(false),
);

/**
 * Maximum bytes accepted from standard input for one request.
 *
 * Every other reader in the CLI is bounded; leaving this one open let a piped
 * stream grow the process heap without limit. A request carries a question or
 * a claim and one quotation, so a megabyte is far above any real input.
 */
const standardInputMaximumBytes = 1024 * 1024;

const readProcessStandardInput = async (): Promise<string> => {
  if (process.stdin.isTTY) return "";
  const chunks: Array<string> = [];
  let bytes = 0;
  for await (const chunk of process.stdin) {
    const text = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    bytes += Buffer.byteLength(text, "utf8");
    if (bytes > standardInputMaximumBytes) {
      throw new InvalidInputError({
        reason: `Standard input exceeds ${standardInputMaximumBytes} bytes`,
      });
    }
    chunks.push(text);
  }
  return chunks.join("");
};

const readMaskedCredential = async (): Promise<string> => {
  if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== "function") {
    throw new CredentialInputError({
      reason: "Interactive credential input requires a TTY; use --stdin for automation",
    });
  }

  process.stderr.write("TypeSafe API key: ");
  return new Promise<string>((resolve, reject) => {
    let value = "";
    const finish = (result: string | Error): void => {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdin.off("data", onData);
      process.stderr.write("\n");
      if (result instanceof Error) reject(result);
      else resolve(result);
    };
    const onData = (chunk: Buffer | string): void => {
      for (const character of chunk.toString()) {
        if (character === "\r" || character === "\n") {
          finish(value);
          return;
        }
        if (character === "\u0003") {
          finish(
            new CredentialInputError({
              reason: "Interactive credential input was cancelled",
            }),
          );
          return;
        }
        if (character === "\u007f" || character === "\b") {
          if (value.length > 0) value = value.slice(0, -1);
          continue;
        }
        if (character < " ") continue;
        // Nothing is echoed. Writing one mask character per keystroke put the
        // exact key length on screen, which a recording or a shared screen
        // then carries off the machine.
        value += character;
      }
    };
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on("data", onData);
  });
};

/**
 * Construct the production CLI side-effect boundary.
 *
 * @returns Dependencies backed by process streams and Bun's native credential manager.
 */
export const makeDefaultCliDependencies = (): RfcCliDependencies => ({
  credentialStore: makeDefaultCredentialStore(),
  readStandardInput: readProcessStandardInput,
  promptCredential: readMaskedCredential,
  writeStdout: (value) => process.stdout.write(value),
  writeStderr: (value) => process.stderr.write(value),
  readUsage: makeUsageReader(),
  recordUsage: makeUsageRecorder(),
  createClient: createRfcClient,
});

/**
 * Map a CLI or core failure to a safe versioned process envelope.
 *
 * @param error Rejected operation value.
 * @returns An envelope that never contains credential values or platform error text.
 */
export const toCliErrorEnvelope = (error: unknown): object => toRfcOperationErrorEnvelope(error);

/**
 * Hosts for which cleartext is not a downgrade, so a local test double works.
 */
const loopbackHosts = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Require an operator-supplied endpoint override to be encrypted in transit.
 *
 * `--typesafe-api-url http://…` sends the stored key as a bearer credential
 * over cleartext on every call, and a cleartext Datatracker endpoint lets a
 * network position rewrite the metadata that currency decisions rest on.
 * Neither flag is reachable by the model, so this closes an operator footgun
 * rather than a model escape.
 *
 * @param flag Flag name as the operator spelled it, used in the refusal.
 * @param value Operator-supplied URL, or undefined when the flag is absent.
 * @returns The value unchanged when it is safe to use.
 * @throws InvalidInputError when the URL is malformed or cleartext off-host.
 */
const secureEndpointOverride = (flag: string, value: string | undefined): string | undefined => {
  if (value === undefined) return undefined;
  const url = URL.parse(value);
  if (url === null) throw new InvalidInputError({ reason: `${flag} must be an absolute URL` });
  if (url.protocol === "https:") return value;
  if (url.protocol === "http:" && loopbackHosts.has(url.hostname)) return value;
  throw new InvalidInputError({
    reason: `${flag} must use https, or http on a loopback host`,
  });
};

const decodeResearchInput = (input: string) => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch {
    throw new InvalidInputError({ reason: "Research input must be valid JSON" });
  }

  return decodeResearchRequest(parsed);
};

const decodeCitationRequest = (input: unknown) => {
  try {
    return decodeCitationVerificationRequest(input);
  } catch {
    throw new InvalidInputError({ reason: "Citation input must use schema version 2" });
  }
};

const decodeCitationInput = (input: string) => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch {
    throw new InvalidInputError({ reason: "Citation input must be valid JSON" });
  }

  return decodeCitationRequest(parsed);
};

const parseCitationOffset = (value: string): number => {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new InvalidInputError({ reason: "Citation offset must be a non-negative integer" });
  }
  return parsed;
};

const resolveArgumentInput = (
  flagName: string,
  flagValue: Option.Option<string>,
  argumentValue: Option.Option<string>,
): string | undefined => {
  if (Option.isSome(flagValue) && Option.isSome(argumentValue)) {
    throw new InvalidInputError({
      reason: `${flagName} cannot be combined with its positional argument`,
    });
  }
  return Option.getOrUndefined(flagValue) ?? Option.getOrUndefined(argumentValue);
};

const resolveRequiredArgumentInput = (
  flagName: string,
  flagValue: Option.Option<string>,
  argumentValue: Option.Option<string>,
): string => {
  const value = resolveArgumentInput(flagName, flagValue, argumentValue);
  if (value === undefined) {
    throw new InvalidInputError({ reason: `${flagName} or its positional argument is required` });
  }
  return value;
};

const resolveOutputFormat = (
  selected: Option.Option<"json" | "human">,
  structuredStandardInput = false,
): "json" | "human" =>
  Option.getOrElse(selected, () => (structuredStandardInput ? "json" : "human"));

const renderUsageTotals = (totals: UsageTotals): string =>
  [
    `Updated: ${totals.updatedAt}`,
    `Operations: ${totals.operations}`,
    `Priced operations: ${totals.pricedOperations}`,
    `Unpriced operations: ${totals.unpricedOperations}`,
    `Operations without input tokens: ${totals.operationsWithoutInputTokens}`,
    `Input tokens: ${totals.inputTokens}`,
    `Priced input tokens: ${totals.pricedInputTokens}`,
    `Unpriced input tokens: ${totals.unpricedInputTokens}`,
    `Estimated input cost (USD): ${renderEstimatedUsd(totals.estimatedInputCostUsd)}`,
  ].join("\n");

const makeApplication = (dependencies: RfcCliDependencies) => {
  const writeStdout = (value: string): Effect.Effect<void> =>
    Effect.sync(() => dependencies.writeStdout(`${value}\n`));

  const writeWarnings = (warnings: ReadonlyArray<RfcOperationWarning>): Effect.Effect<void> =>
    Effect.sync(() => {
      for (const warning of warnings) {
        dependencies.writeStderr(`${JSON.stringify(warning)}\n`);
      }
    });

  const operationOptions = (
    selectedCacheDirectory: string,
    selectedDatatrackerApiUrl: Option.Option<string>,
    selectedTypeSafeApiUrl: Option.Option<string>,
  ): RfcOperationOptions => ({
    cacheDirectory: selectedCacheDirectory,
    datatrackerApiUrl: secureEndpointOverride(
      "--datatracker-api-url",
      Option.getOrUndefined(selectedDatatrackerApiUrl),
    ),
    typeSafeApiUrl: secureEndpointOverride(
      "--typesafe-api-url",
      Option.getOrUndefined(selectedTypeSafeApiUrl),
    ),
  });

  const sourceCacheStatusCommand = Command.make(
    "status",
    {
      cacheDirectory,
      format,
      rfc: cacheRfc,
      rfcArgument,
    },
    Effect.fn(function* ({ cacheDirectory, format, rfc, rfcArgument }) {
      const selectedRfc = resolveRequiredArgumentInput("--rfc", rfc, rfcArgument);
      const status = yield* Effect.tryPromise({
        try: () =>
          executeSourceCacheStatus(
            selectedRfc,
            operationOptions(cacheDirectory, Option.none(), Option.none()),
            dependencies,
          ),
        catch: (error) => error,
      });
      yield* writeStdout(
        resolveOutputFormat(format) === "human"
          ? renderSourceCacheStatus(status)
          : JSON.stringify(status),
      );
    }),
  ).pipe(Command.withDescription("Inspect one RFC source cache entry without network access"));

  const sourceCacheRemoveCommand = Command.make(
    "remove",
    {
      cacheDirectory,
      format,
      rfc: cacheRfc,
      rfcArgument,
    },
    Effect.fn(function* ({ cacheDirectory, format, rfc, rfcArgument }) {
      const selectedRfc = resolveRequiredArgumentInput("--rfc", rfc, rfcArgument);
      const result = yield* Effect.tryPromise({
        try: () =>
          executeSourceCacheRemove(
            selectedRfc,
            operationOptions(cacheDirectory, Option.none(), Option.none()),
            dependencies,
          ),
        catch: (error) => error,
      });
      yield* writeStdout(
        resolveOutputFormat(format) === "human"
          ? renderSourceCacheRemove(result)
          : JSON.stringify(result),
      );
    }),
  ).pipe(Command.withDescription("Remove one RFC source cache entry without network access"));

  const sourceCacheCommand = Command.make("cache").pipe(
    Command.withDescription("Manage individually requested RFC source text"),
    Command.withSubcommands([sourceCacheStatusCommand, sourceCacheRemoveCommand]),
  );

  const verifyCitationCommand = Command.make(
    "verify-citation",
    {
      cacheDirectory,
      datatrackerApiUrl,
      format,
      rfc,
      rfcArgument,
      claim,
      claimArgument,
      quote,
      quoteArgument,
      offset,
      typeSafeApiUrl,
    },
    Effect.fn(function* (flags) {
      const standardInput = yield* Effect.tryPromise({
        try: dependencies.readStandardInput,
        catch: () => new InvalidInputError({ reason: "Unable to read citation input" }),
      });

      const request =
        standardInput.trim().length > 0
          ? decodeCitationInput(standardInput)
          : (() => {
              const selectedRfc = resolveRequiredArgumentInput(
                "--rfc",
                flags.rfc,
                flags.rfcArgument,
              );
              const selectedClaim = resolveRequiredArgumentInput(
                "--claim",
                flags.claim,
                flags.claimArgument,
              );
              const selectedQuote = resolveRequiredArgumentInput(
                "--quote",
                flags.quote,
                flags.quoteArgument,
              );
              return decodeCitationRequest({
                schemaVersion: 2,
                rfc: selectedRfc,
                claim: selectedClaim,
                quote: selectedQuote,
                offset: Option.isSome(flags.offset)
                  ? parseCitationOffset(flags.offset.value)
                  : null,
              });
            })();

      const result = yield* Effect.tryPromise({
        try: () =>
          executeCitationVerification(
            request,
            operationOptions(flags.cacheDirectory, flags.datatrackerApiUrl, flags.typeSafeApiUrl),
            dependencies,
          ),
        catch: (error) => error,
      });
      yield* writeWarnings(result.warnings);
      yield* writeStdout(
        resolveOutputFormat(flags.format, standardInput.trim().length > 0) === "human"
          ? renderCitationVerification(result.value)
          : JSON.stringify(result.value),
      );
    }),
  ).pipe(
    Command.withDescription("Verify an RFC quotation against a factual claim"),
    Command.withExamples([
      {
        command: "rfc verify-citation < citation.json",
        description: "Verify canonical JSON from standard input",
      },
      {
        command:
          'rfc verify-citation RFC9110 "The client sends a request" "The client MUST send a request"',
        description: "Verify a short interactive citation with positional arguments",
      },
    ]),
  );

  const researchCommand = Command.make(
    "research",
    {
      cacheDirectory,
      datatrackerApiUrl,
      format,
      question,
      questionArgument,
      rfc,
      rfcArgument,
      searchTerms,
      typeSafeApiUrl,
    },
    Effect.fn(function* (flags) {
      const standardInput = yield* Effect.tryPromise({
        try: dependencies.readStandardInput,
        catch: () => new InvalidInputError({ reason: "Unable to read research input" }),
      });

      const request =
        standardInput.trim().length > 0
          ? decodeResearchInput(standardInput)
          : (() => {
              const selectedQuestion = resolveRequiredArgumentInput(
                "--question",
                flags.question,
                flags.questionArgument,
              );
              const selectedRfc = resolveArgumentInput("--rfc", flags.rfc, flags.rfcArgument);
              return selectedRfc === undefined
                ? decodeResearchRequest({
                    schemaVersion,
                    question: selectedQuestion,
                    rfc: null,
                    searchTerms: flags.searchTerms,
                  })
                : decodeResearchRequest({
                    schemaVersion,
                    question: selectedQuestion,
                    rfc: selectedRfc,
                    searchTerms: flags.searchTerms.length === 0 ? undefined : flags.searchTerms,
                  });
            })();

      const result = yield* Effect.tryPromise({
        try: () =>
          executeResearch(
            request,
            operationOptions(flags.cacheDirectory, flags.datatrackerApiUrl, flags.typeSafeApiUrl),
            dependencies,
          ),
        catch: (error) => error,
      });
      yield* writeWarnings(result.warnings);
      yield* writeStdout(
        resolveOutputFormat(flags.format, standardInput.trim().length > 0) === "human"
          ? renderEvidenceBundle(result.value)
          : JSON.stringify(result.value),
      );
    }),
  ).pipe(
    Command.withDescription("Research an RFC question from versioned JSON input"),
    Command.withExamples([
      {
        command: "rfc research < question.json",
        description: "Use canonical JSON from standard input",
      },
      {
        command: 'rfc research "What does RFC 9110 require?" RFC9110',
        description: "Use human-friendly positional arguments when standard input is empty",
      },
    ]),
  );

  const authLoginCommand = Command.make(
    "login",
    {
      format,
      stdin: credentialFromStdin,
      fromStdin: credentialFromStdinAlias,
    },
    Effect.fn(function* ({ format, stdin, fromStdin }) {
      const input = yield* Effect.tryPromise({
        try: stdin || fromStdin ? dependencies.readStandardInput : dependencies.promptCredential,
        catch: (error) => error,
      });
      const result = yield* Effect.tryPromise({
        try: () => addStoredCredential(dependencies.credentialStore, input),
        catch: (error) => error,
      });

      if (resolveOutputFormat(format) === "human") {
        yield* writeStdout(
          result.replaced
            ? "TypeSafe API key replaced in the platform credential store"
            : "TypeSafe API key stored in the platform credential store",
        );
        yield* writeStdout(`Service: ${result.service}`);
        yield* writeStdout(`Name: ${result.name}`);
        return;
      }

      yield* writeStdout(JSON.stringify(result));
    }),
  ).pipe(Command.withDescription("Store or replace the TypeSafe API key"));

  const authRemoveCommand = Command.make(
    "remove",
    { format },
    Effect.fn(function* ({ format }) {
      const result = yield* Effect.tryPromise({
        try: () => removeStoredCredential(dependencies.credentialStore),
        catch: (error) => error,
      });
      if (resolveOutputFormat(format) === "human") {
        yield* writeStdout(
          result.removed
            ? "TypeSafe API key removed from the platform credential store"
            : "No TypeSafe API key was configured",
        );
        yield* writeStdout(`Service: ${result.service}`);
        yield* writeStdout(`Name: ${result.name}`);
        return;
      }
      yield* writeStdout(JSON.stringify(result));
    }),
  ).pipe(Command.withDescription("Remove the stored TypeSafe API key"));

  const authCommand = Command.make(
    "auth",
    { format },
    Effect.fn(function* ({ format }) {
      const result = yield* Effect.tryPromise({
        try: () => executeAuthStatus(dependencies),
        catch: (error) => error,
      });
      yield* writeStdout(
        resolveOutputFormat(format) === "human" ? renderAuthStatus(result) : JSON.stringify(result),
      );
    }),
  ).pipe(
    Command.withDescription("Inspect or manage the TypeSafe API key in the OS credential manager"),
    Command.withSubcommands([authLoginCommand, authRemoveCommand]),
  );

  const costsCommand = Command.make(
    "costs",
    { format },
    Effect.fn(function* ({ format }) {
      const totals = yield* Effect.tryPromise({
        try: dependencies.readUsage,
        catch: (error) => error,
      });
      yield* writeStdout(
        resolveOutputFormat(format) === "human"
          ? renderUsageTotals(totals)
          : JSON.stringify(totals),
      );
    }),
  ).pipe(Command.withDescription("Print cumulative per-user RFC usage costs"));

  const mcpCommand = Command.make(
    "mcp",
    { cacheDirectory, datatrackerApiUrl, typeSafeApiUrl },
    Effect.fn(function* (flags) {
      yield* Effect.tryPromise({
        try: () =>
          runRfcMcpServer(
            operationOptions(flags.cacheDirectory, flags.datatrackerApiUrl, flags.typeSafeApiUrl),
            dependencies,
            (error) =>
              dependencies.writeStderr(`${JSON.stringify(toRfcOperationErrorEnvelope(error))}\n`),
          ),
        catch: (error) => error,
      });
    }),
  ).pipe(
    Command.withDescription(
      "Serve the self-describing RFC agent surface over the Model Context Protocol on stdio",
    ),
  );

  return Command.make("rfc").pipe(
    Command.withDescription("TypeSafe RFC evidence engine"),
    Command.withSubcommands([
      authCommand,
      sourceCacheCommand,
      costsCommand,
      researchCommand,
      verifyCitationCommand,
      mcpCommand,
    ]),
  );
};

/**
 * Flag names that may carry a secret. Matched against the name only, so both
 * `--api-token=value` and a separated `--api-token value` are refused, and a
 * near miss of the documented `--api-key` spelling cannot slip through into
 * the process argument vector.
 */
const forbiddenCredentialFlagPattern =
  /^--[^=]*(?:key|token|secret|password|passwd|credential)[^=]*(?:=|$)/i;

const hasForbiddenCredentialArgument = (argv: ReadonlyArray<string>): boolean =>
  argv.some((argument) => forbiddenCredentialFlagPattern.test(argument));

/**
 * Describe a CLI parse failure without copying any argument text.
 *
 * Effect renders argument values inside its `CliError` messages — `InvalidValue`
 * embeds the rejected value verbatim — so the envelope reason is derived from
 * the failure tag alone. Callers who need specifics run the command with
 * `--help`, which is rendered to the terminal rather than into the envelope.
 *
 * @param error A CLI parse or validation failure.
 * @returns A fixed reason string that contains no argv-derived text.
 */
const safeCliErrorReason = (error: CliError.CliError): string => {
  switch (error._tag) {
    case "ShowHelp":
      return error.errors.length > 0 ? safeCliErrorReason(error.errors[0]!) : "Help requested";
    case "UnrecognizedOption":
      return "The command received an unrecognized flag";
    case "DuplicateOption":
      return "The command received the same flag more than once";
    case "MissingOption":
      return "The command is missing a required flag";
    case "MissingArgument":
      return "The command is missing a required argument";
    case "UnexpectedArgument":
      return "The command received an unexpected positional argument";
    case "InvalidValue":
      return "The command received an invalid flag or argument value";
    case "UnknownSubcommand":
      return "The command is not a known rfc subcommand";
    default:
      return "The command could not be parsed";
  }
};

const application = makeApplication(makeDefaultCliDependencies());

/**
 * Run the RFC CLI with a supplied argument vector and injectable side effects.
 *
 * @param argv Arguments after the binary name.
 * @param dependencies Process and credential boundaries for this invocation.
 * @returns Zero for a valid command result and one for a protocol or runtime failure.
 */
export const run = async (
  argv: ReadonlyArray<string>,
  dependencies: RfcCliDependencies = makeDefaultCliDependencies(),
): Promise<number> => {
  if (hasForbiddenCredentialArgument(argv)) {
    dependencies.writeStderr(
      `${JSON.stringify({
        schemaVersion,
        kind: "error",
        error: {
          code: "invalid_input",
          message: "The TypeSafe API key must be supplied through --stdin or an interactive prompt",
        },
      })}\n`,
    );
    return 1;
  }

  const renderCliOutput = argv.some(
    (argument) => argument === "--help" || argument === "-h" || argument === "--version",
  );
  const hostConsole = globalThis.console;
  const cliConsole = Object.assign(Object.create(hostConsole), {
    log: (...args: Parameters<typeof hostConsole.log>) => {
      if (renderCliOutput) hostConsole.log(...args);
    },
    error: (...args: Parameters<typeof hostConsole.error>) => {
      if (renderCliOutput) hostConsole.error(...args);
    },
  }) as Console.Console;

  try {
    const program = Command.runWith(makeApplication(dependencies), {
      version: packageMetadata.version,
      renderErrors: false,
    })(argv);

    await Effect.runPromise(
      program.pipe(
        Effect.provide(NodeServices.layer),
        Effect.provideService(Console.Console, cliConsole),
      ),
    );
    return 0;
  } catch (error) {
    const protocolError =
      CliError.isCliError(error) &&
      error._tag !== "UserError" &&
      (error._tag !== "ShowHelp" || error.errors.length > 0)
        ? new InvalidInputError({ reason: safeCliErrorReason(error) })
        : error;
    dependencies.writeStderr(`${JSON.stringify(toCliErrorEnvelope(protocolError))}\n`);
    return 1;
  }
};

/**
 * The production command tree used by package consumers and the process entrypoint.
 */
export const command = application;
