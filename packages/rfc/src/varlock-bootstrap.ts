import { execSyncVarlock } from "varlock/exec-sync-varlock";
import { initVarlockEnv } from "varlock/env";
import { Schema } from "effect";

const schemaVersion = 1 as const;
const BootstrapErrorEnvelopeSchema = Schema.Struct({
  schemaVersion: Schema.Literal(schemaVersion),
  kind: Schema.Literal("error"),
  error: Schema.Struct({
    code: Schema.Literal("configuration_error"),
    message: Schema.String,
  }),
});

const writeConfigurationError = (): void => {
  const envelope = Schema.decodeUnknownSync(BootstrapErrorEnvelopeSchema)({
    schemaVersion,
    kind: "error",
    error: {
      code: "configuration_error",
      message: "Unable to load required Varlock configuration",
    },
  });
  process.stderr.write(`${JSON.stringify(envelope)}\n`);
};

/**
 * Resolve and validate Varlock before importing the application module.
 *
 * @param callerDir Directory used as the Varlock project-resolution anchor.
 * @returns Whether Varlock loaded a validated environment.
 */
export const loadVarlock = async (callerDir: string): Promise<boolean> => {
  try {
    const result = execSyncVarlock("load --format json-full --compact", {
      callerDir,
      fullResult: true,
      showLogsOnError: false,
    });
    const loadedEnvironment = JSON.parse(result.stdout) as unknown;
    (
      globalThis as typeof globalThis & { __varlockLoadedEnv: unknown | undefined }
    ).__varlockLoadedEnv = loadedEnvironment;
    initVarlockEnv();
    await import("varlock/patch-console");
    return true;
  } catch {
    writeConfigurationError();
    return false;
  }
};
