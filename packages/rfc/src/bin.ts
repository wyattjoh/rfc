#!/usr/bin/env bun

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

const loadVarlock = async (): Promise<boolean> => {
  try {
    const result = execSyncVarlock("load --format json-full --compact", {
      callerDir: import.meta.dir,
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

const argv = process.argv.slice(2);

if (await loadVarlock()) {
  // This import must stay after Varlock has resolved and validated configuration
  // so no application module can read configuration before the boundary runs.
  const { run } = await import("./main");
  process.exitCode = await run(argv);
} else {
  process.exitCode = 1;
}
