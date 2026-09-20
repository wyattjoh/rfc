import {
  ConfigurationError,
  InvalidInputError,
  createRfcClient,
  decodeCitationVerificationRequest,
  decodeResearchRequest,
  defaultCacheDirectory,
  schemaVersion,
  toErrorEnvelope,
} from "@wyattjoh/rfc-core";
import { NodeServices } from "@effect/platform-node";
import { Console, Effect, Option } from "effect";
import { CliError, Command, Flag } from "effect/unstable/cli";
import { automaticAnswerActivationFor, readCliConfig } from "./config";
import {
  CredentialInputError,
  CredentialMissingError,
  CredentialStoreError,
  addStoredCredential,
  makeDefaultCredentialStore,
  removeStoredCredential,
  resolveStoredCredential,
  storedCredentialStatus,
  type CredentialStore,
} from "./credentials";

/**
 * Injectable side effects used by the CLI composition root.
 *
 * Production uses process streams and Bun.secrets. Tests provide all five
 * functions so they never touch the operator's credential manager or terminal.
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
   * Construct the RFC client for one command invocation.
   *
   * Process-protocol tests substitute a stub here so they can assert decoding,
   * rendering, and exit status without reproducing retrieval internals.
   */
  readonly createClient: typeof createRfcClient;
}

const format = Flag.Literals("format", ["json", "human"] as const).pipe(
  Flag.withDescription("Output format; JSON is the automation default"),
  Flag.withDefault("json" as const),
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
  Flag.withDescription("Short question used when standard input is not supplied"),
  Flag.optional,
);

const rfc = Flag.String("rfc").pipe(
  Flag.withDescription("Known RFC identifier for a short interactive request"),
  Flag.optional,
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

const quote = Flag.String("quote").pipe(
  Flag.withDescription("Exact RFC quotation to verify when standard input is not supplied"),
  Flag.optional,
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

const readProcessStandardInput = async (): Promise<string> => {
  if (process.stdin.isTTY) return "";
  const chunks: Array<string> = [];
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
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
          if (value.length > 0) {
            value = value.slice(0, -1);
            process.stderr.write("\b \b");
          }
          continue;
        }
        if (character < " ") continue;
        value += character;
        process.stderr.write("*");
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
  createClient: createRfcClient,
});

const credentialErrorEnvelope = (error: unknown): object | undefined => {
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

/**
 * Map a CLI or core failure to a safe versioned process envelope.
 *
 * @param error Rejected operation value.
 * @returns An envelope that never contains credential values or platform error text.
 */
export const toCliErrorEnvelope = (error: unknown): object =>
  credentialErrorEnvelope(error) ?? toErrorEnvelope(error);

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

const makeApplication = (dependencies: RfcCliDependencies) => {
  const writeStdout = (value: string): Effect.Effect<void> =>
    Effect.sync(() => dependencies.writeStdout(`${value}\n`));

  const verifyCitationCommand = Command.make(
    "verify-citation",
    {
      cacheDirectory,
      datatrackerApiUrl,
      format,
      rfc,
      claim,
      quote,
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
              if (
                Option.isNone(flags.rfc) ||
                Option.isNone(flags.claim) ||
                Option.isNone(flags.quote)
              ) {
                throw new InvalidInputError({
                  reason:
                    "Citation verification requires JSON standard input or --rfc, --claim, and --quote",
                });
              }
              return decodeCitationRequest({
                schemaVersion: 2,
                rfc: flags.rfc.value,
                claim: flags.claim.value,
                quote: flags.quote.value,
                offset: Option.isSome(flags.offset)
                  ? parseCitationOffset(flags.offset.value)
                  : null,
              });
            })();

      const cliConfig = yield* Effect.tryPromise({
        try: async () => readCliConfig(),
        catch: (error) =>
          new ConfigurationError({
            reason: error instanceof Error ? error.message : "Unknown configuration error",
          }),
      });
      const apiKey = yield* Effect.tryPromise({
        try: () => resolveStoredCredential(dependencies.credentialStore),
        catch: (error) => error,
      });

      const client = yield* Effect.tryPromise({
        try: () =>
          dependencies.createClient({
            cacheDirectory: flags.cacheDirectory,
            datatrackerApiUrl: Option.getOrUndefined(flags.datatrackerApiUrl),
            modelAlias: cliConfig.modelAlias,
            policyPreset: cliConfig.policyPreset,
            automaticAnswerActivation: automaticAnswerActivationFor(cliConfig),
            typeSafeApiKey: apiKey,
            typeSafeApiUrl: Option.getOrUndefined(flags.typeSafeApiUrl),
          }),
        catch: (error) => error,
      });

      const result = yield* Effect.acquireUseRelease(
        Effect.succeed(client),
        (activeClient) =>
          Effect.tryPromise({
            try: () => activeClient.verifyCitation(request),
            catch: (error) => error,
          }),
        (activeClient) =>
          Effect.tryPromise({ try: () => activeClient.close(), catch: (error) => error }),
      );

      if (flags.format === "human") {
        yield* writeStdout(`Verdict: ${result.verdict}`);
        yield* writeStdout(`RFC: ${result.rfc.identifier}`);
        yield* writeStdout(`Quote: ${result.quote}`);
        yield* writeStdout(
          `Offsets: ${result.provenance.startOffset ?? "unknown"}-${result.provenance.endOffset ?? "unknown"}`,
        );
        yield* writeStdout(`Section: ${result.provenance.section ?? "unknown"}`);
        return;
      }

      yield* writeStdout(JSON.stringify(result));
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
          'rfc verify-citation --rfc RFC9110 --claim "The client sends a request" --quote "The client MUST send a request"',
        description: "Verify a short interactive citation",
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
      rfc,
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
          : Option.isSome(flags.question)
            ? Option.isSome(flags.rfc)
              ? decodeResearchRequest({
                  schemaVersion,
                  question: flags.question.value,
                  rfc: flags.rfc.value,
                  searchTerms: flags.searchTerms.length === 0 ? undefined : flags.searchTerms,
                })
              : decodeResearchRequest({
                  schemaVersion,
                  question: flags.question.value,
                  rfc: null,
                  searchTerms: flags.searchTerms,
                })
            : (() => {
                throw new InvalidInputError({
                  reason: "Research requires JSON standard input or --question",
                });
              })();

      const cliConfig = yield* Effect.tryPromise({
        try: async () => readCliConfig(),
        catch: (error) =>
          new ConfigurationError({
            reason: error instanceof Error ? error.message : "Unknown configuration error",
          }),
      });
      const apiKey = yield* Effect.tryPromise({
        try: () => resolveStoredCredential(dependencies.credentialStore),
        catch: (error) => error,
      });

      const client = yield* Effect.tryPromise({
        try: () =>
          dependencies.createClient({
            cacheDirectory: flags.cacheDirectory,
            datatrackerApiUrl: Option.getOrUndefined(flags.datatrackerApiUrl),
            modelAlias: cliConfig.modelAlias,
            policyPreset: cliConfig.policyPreset,
            automaticAnswerActivation: automaticAnswerActivationFor(cliConfig),
            typeSafeApiKey: apiKey,
            typeSafeApiUrl: Option.getOrUndefined(flags.typeSafeApiUrl),
          }),
        catch: (error) => error,
      });

      const result = yield* Effect.acquireUseRelease(
        Effect.succeed(client),
        (activeClient) =>
          Effect.tryPromise({ try: () => activeClient.research(request), catch: (error) => error }),
        (activeClient) =>
          Effect.tryPromise({ try: () => activeClient.close(), catch: (error) => error }),
      );

      if (flags.format === "human") {
        yield* writeStdout(`Status: ${result.status}`);
        yield* writeStdout(`RFC: ${result.rfc?.identifier ?? "none discovered"}`);
        for (const context of result.contexts ?? []) {
          yield* writeStdout(
            `Context: ${context.role} ${context.document.identifier} (${context.state})`,
          );
        }
        for (const passage of result.evidence) {
          yield* writeStdout(`Section: ${passage.provenance.section ?? "unknown"}`);
          yield* writeStdout(`Quote: ${passage.quote}`);
        }
        return;
      }

      yield* writeStdout(JSON.stringify(result));
    }),
  ).pipe(
    Command.withDescription("Research an RFC question from versioned JSON input"),
    Command.withExamples([
      {
        command: "rfc research < question.json",
        description: "Use canonical JSON from standard input",
      },
      {
        command: 'rfc research --question "What does RFC 9110 require?" --rfc RFC9110',
        description: "Use convenience flags when standard input is empty",
      },
    ]),
  );

  const authAddCommand = Command.make(
    "add",
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

      if (format === "human") {
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

  const authStatusCommand = Command.make(
    "status",
    { format },
    Effect.fn(function* ({ format }) {
      const result = yield* Effect.tryPromise({
        try: () => storedCredentialStatus(dependencies.credentialStore),
        catch: (error) => error,
      });
      if (format === "human") {
        yield* writeStdout(`Credential: ${result.configured ? "configured" : "not configured"}`);
        yield* writeStdout(`Service: ${result.service}`);
        yield* writeStdout(`Name: ${result.name}`);
        return;
      }
      yield* writeStdout(JSON.stringify(result));
    }),
  ).pipe(Command.withDescription("Inspect TypeSafe credential configuration without revealing it"));

  const authRemoveCommand = Command.make(
    "remove",
    { format },
    Effect.fn(function* ({ format }) {
      const result = yield* Effect.tryPromise({
        try: () => removeStoredCredential(dependencies.credentialStore),
        catch: (error) => error,
      });
      if (format === "human") {
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

  const authCommand = Command.make("auth").pipe(
    Command.withDescription("Manage the TypeSafe API key in the OS credential manager"),
    Command.withSubcommands([authAddCommand, authStatusCommand, authRemoveCommand]),
  );

  return Command.make("rfc").pipe(
    Command.withDescription("TypeSafe RFC evidence engine"),
    Command.withSubcommands([authCommand, researchCommand, verifyCitationCommand]),
  );
};

const hasForbiddenCredentialArgument = (argv: ReadonlyArray<string>): boolean =>
  argv.some((argument) => /^--(?:api-key|typesafe-api-key)(?:=|$)/i.test(argument));

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
      version: "0.1.0",
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
        ? new InvalidInputError({ reason: error.message })
        : error;
    dependencies.writeStderr(`${JSON.stringify(toCliErrorEnvelope(protocolError))}\n`);
    return 1;
  }
};

/**
 * The production command tree used by package consumers and the process entrypoint.
 */
export const command = application;
