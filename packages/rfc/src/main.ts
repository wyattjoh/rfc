import { readFile } from "node:fs/promises";
import {
  ConfigurationError,
  InvalidInputError,
  createRfcClient,
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
      return;
    }

    yield* writeStdout(JSON.stringify(status));
  }),
).pipe(Command.withDescription("Inspect local RFC metadata catalog freshness"));

const catalogCommand = Command.make("catalog").pipe(
  Command.withDescription("Manage the local RFC metadata catalog"),
  Command.withSubcommands([catalogStatusCommand]),
);

const question = Flag.String("question").pipe(
  Flag.withDescription("Short question used when standard input is not supplied"),
  Flag.optional,
);

const rfc = Flag.String("rfc").pipe(
  Flag.withDescription("Known RFC identifier for a short interactive request"),
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

const researchCommand = Command.make(
  "research",
  {
    question,
    rfc,
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
          cacheDirectory: undefined,
          catalogPath: undefined,
          modelAlias: cliConfig.modelAlias,
          typeSafeApiKey: cliConfig.apiKey,
          typeSafeApiUrl: undefined,
        }),
      catch: (error) => error,
    });

    yield* Effect.acquireUseRelease(
      Effect.succeed(client),
      (activeClient) =>
        Effect.tryPromise({ try: () => activeClient.research(request), catch: (error) => error }),
      (activeClient) =>
        Effect.tryPromise({ try: () => activeClient.close(), catch: (error) => error }),
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
      command: 'rfc research --question "What does RFC 9110 require?" --rfc RFC9110',
      description: "Use convenience flags when standard input is empty",
    },
  ]),
);

const application = Command.make("rfc").pipe(
  Command.withDescription("TypeSafe RFC evidence engine"),
  Command.withSubcommands([catalogCommand, researchCommand]),
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
