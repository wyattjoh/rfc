import { readFile } from "node:fs/promises";
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
import { readCliConfig } from "./config";
import { CliError, Command, Flag } from "effect/unstable/cli";

const format = Flag.Literals("format", ["json", "human"] as const).pipe(
  Flag.withDescription("Output format; JSON is the automation default"),
  Flag.withDefault("json" as const),
);

const cacheDirectory = Flag.String("cache-directory").pipe(
  Flag.withDescription("Directory containing the local RFC metadata cache"),
  Flag.withDefault(defaultCacheDirectory),
);

const datatrackerApiUrl = Flag.String("datatracker-api-url").pipe(
  Flag.withDescription("Datatracker API base URL used for catalog refresh"),
  Flag.optional,
);

const writeStdout = (value: string): Effect.Effect<void> =>
  Effect.sync(() => {
    process.stdout.write(`${value}\n`);
  });

const catalogStatusCommand = Command.make(
  "status",
  {
    cacheDirectory,
    format,
  },
  Effect.fn(function* ({ cacheDirectory, format }) {
    const status = yield* Effect.acquireUseRelease(
      Effect.tryPromise({
        try: () =>
          createRfcClient({
            cacheDirectory,
            catalogPath: undefined,
            modelAlias: undefined,
            typeSafeApiKey: undefined,
            typeSafeApiUrl: undefined,
          }),
        catch: (error) => error,
      }),
      (client) =>
        Effect.tryPromise({
          try: () => client.catalogStatus(),
          catch: (error) => error,
        }),
      (client) => Effect.tryPromise({ try: () => client.close(), catch: (error) => error }),
    );

    if (format === "human") {
      yield* writeStdout(`Catalog: ${status.state}`);
      yield* writeStdout(`Path: ${status.catalogPath}`);
      yield* writeStdout(`Cache: ${status.cacheIdentity}`);
      yield* writeStdout(`Fetched: ${status.refreshedAt ?? "never"}`);
      yield* writeStdout(`Age: ${status.ageMs ?? "unknown"}`);
      yield* writeStdout(`Documents: ${status.documentCount}`);
      return;
    }

    yield* writeStdout(JSON.stringify(status));
  }),
).pipe(Command.withDescription("Inspect local RFC metadata catalog freshness"));

const catalogRefreshCommand = Command.make(
  "refresh",
  {
    cacheDirectory,
    datatrackerApiUrl,
    format,
  },
  Effect.fn(function* ({ cacheDirectory, datatrackerApiUrl, format }) {
    const client = yield* Effect.tryPromise({
      try: () =>
        createRfcClient({
          cacheDirectory,
          catalogPath: undefined,
          datatrackerApiUrl: Option.getOrUndefined(datatrackerApiUrl),
          modelAlias: undefined,
          typeSafeApiKey: undefined,
          typeSafeApiUrl: undefined,
        }),
      catch: (error) => error,
    });

    const result = yield* Effect.acquireUseRelease(
      Effect.succeed(client),
      (activeClient) =>
        Effect.tryPromise({ try: () => activeClient.catalogRefresh(), catch: (error) => error }),
      (activeClient) =>
        Effect.tryPromise({ try: () => activeClient.close(), catch: (error) => error }),
    );

    if (format === "human") {
      yield* writeStdout(`Catalog: ${result.state}`);
      yield* writeStdout(`Path: ${result.catalogPath}`);
      yield* writeStdout(`Documents: ${result.documentCount}`);
      return;
    }

    yield* writeStdout(JSON.stringify(result));
  }),
).pipe(Command.withDescription("Refresh the local RFC metadata catalog"));

const catalogCommand = Command.make("catalog").pipe(
  Command.withDescription("Manage the local RFC metadata catalog"),
  Command.withSubcommands([catalogStatusCommand, catalogRefreshCommand]),
);

const question = Flag.String("question").pipe(
  Flag.withDescription("Short question used when standard input is not supplied"),
  Flag.optional,
);

const rfc = Flag.String("rfc").pipe(
  Flag.withDescription("Known RFC identifier for a short interactive request"),
  Flag.optional,
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

const readStandardInput = async (): Promise<string> => {
  if (process.stdin.isTTY) {
    return "";
  }
  return readFile("/dev/stdin", "utf8");
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
    throw new InvalidInputError({ reason: "Citation input must use schema version 1" });
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
  const offset = Number(value);
  if (!Number.isSafeInteger(offset) || offset < 0) {
    throw new InvalidInputError({ reason: "Citation offset must be a non-negative integer" });
  }
  return offset;
};

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
      try: readStandardInput,
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
              schemaVersion,
              rfc: flags.rfc.value,
              claim: flags.claim.value,
              quote: flags.quote.value,
              offset: Option.isSome(flags.offset) ? parseCitationOffset(flags.offset.value) : null,
            });
          })();

    const cliConfig = yield* Effect.tryPromise({
      try: async () => readCliConfig(),
      catch: (error) =>
        new ConfigurationError({
          reason: error instanceof Error ? error.message : "Unknown configuration error",
        }),
    });

    const client = yield* Effect.tryPromise({
      try: () =>
        createRfcClient({
          cacheDirectory: flags.cacheDirectory,
          catalogPath: undefined,
          datatrackerApiUrl: Option.getOrUndefined(flags.datatrackerApiUrl),
          modelAlias: cliConfig.modelAlias,
          policyPreset: cliConfig.policyPreset,
          typeSafeApiKey: cliConfig.apiKey,
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
    typeSafeApiUrl,
  },
  Effect.fn(function* (flags) {
    const standardInput = yield* Effect.tryPromise({
      try: readStandardInput,
      catch: () => new InvalidInputError({ reason: "Unable to read research input" }),
    });

    const request =
      standardInput.trim().length > 0
        ? decodeResearchInput(standardInput)
        : Option.isSome(flags.question)
          ? decodeResearchRequest({
              schemaVersion,
              question: flags.question.value,
              rfc: Option.getOrUndefined(flags.rfc) ?? null,
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

    const client = yield* Effect.tryPromise({
      try: () =>
        createRfcClient({
          cacheDirectory: flags.cacheDirectory,
          catalogPath: undefined,
          datatrackerApiUrl: Option.getOrUndefined(flags.datatrackerApiUrl),
          modelAlias: cliConfig.modelAlias,
          policyPreset: cliConfig.policyPreset,
          typeSafeApiKey: cliConfig.apiKey,
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

const application = Command.make("rfc").pipe(
  Command.withDescription("TypeSafe RFC evidence engine"),
  Command.withSubcommands([catalogCommand, researchCommand, verifyCitationCommand]),
);

/**
 * Run the RFC CLI with a supplied argument vector.
 *
 * @param argv Arguments after the binary name.
 * @returns Zero for a valid command result and one for a protocol or runtime failure.
 */
export const run = async (argv: ReadonlyArray<string>): Promise<number> => {
  const renderCliOutput = argv.some(
    (argument) => argument === "--help" || argument === "-h" || argument === "--version",
  );
  const hostConsole = globalThis.console;
  const cliConsole = Object.assign(Object.create(hostConsole), {
    log: (...args: Parameters<typeof hostConsole.log>) => {
      if (renderCliOutput) {
        hostConsole.log(...args);
      }
    },
    error: (...args: Parameters<typeof hostConsole.error>) => {
      if (renderCliOutput) {
        hostConsole.error(...args);
      }
    },
  }) as Console.Console;

  try {
    const program = Command.runWith(application, {
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
    process.stderr.write(`${JSON.stringify(toErrorEnvelope(protocolError))}\n`);
    return 1;
  }
};

/**
 * The command tree used by tests and the process entrypoint.
 */
export const command = application;
