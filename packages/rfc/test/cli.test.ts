import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

const repositoryRoot = join(import.meta.dir, "../../..");

const runCli = async (
  args: Array<string>,
  input: string | undefined = undefined,
  environment: NodeJS.ProcessEnv = {
    ...process.env,
    TYPESAFE_API_KEY: "fixture-key",
  },
): Promise<{ readonly exitCode: number; readonly stdout: string; readonly stderr: string }> => {
  const child = Bun.spawn(["bun", "run", "packages/rfc/src/bin.ts", ...args], {
    cwd: repositoryRoot,
    stdin: input === undefined ? undefined : "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: environment,
  });

  if (input !== undefined && child.stdin !== undefined) {
    child.stdin.write(input);
    child.stdin.end();
  }

  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);

  return { exitCode, stdout, stderr };
};

describe("rfc process protocol", () => {
  test("writes a versioned catalog status response to stdout", async () => {
    const cacheDirectory = await mkdtemp(join(tmpdir(), "rfc-cli-test-"));
    const result = await runCli(["catalog", "status", "--cache-directory", cacheDirectory]);

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      schemaVersion: 1,
      kind: "catalog_status",
      state: "missing",
      catalogPath: join(cacheDirectory, "catalog.json"),
      refreshedAt: null,
      ageMs: null,
    });
    expect(result.stderr).toBe("");
  });

  test("writes versioned input failures to stderr and exits nonzero", async () => {
    const result = await runCli(
      ["research", "--question", "ignored"],
      JSON.stringify({ schemaVersion: 2, question: "What is HTTP?", rfc: null }),
    );

    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(JSON.parse(result.stderr)).toEqual({
      schemaVersion: 1,
      kind: "error",
      error: {
        code: "invalid_input",
        message: "Research input must use schema version 1",
      },
    });
  });

  test("contains Varlock failures in the versioned stderr protocol", async () => {
    const environment = { ...process.env };
    delete environment.TYPESAFE_API_KEY;

    const result = await runCli(["catalog", "status"], undefined, environment);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(JSON.parse(result.stderr)).toEqual({
      schemaVersion: 1,
      kind: "error",
      error: {
        code: "configuration_error",
        message: "Unable to load required Varlock configuration",
      },
    });
  });

  test("maps malformed convenience flags to invalid input", async () => {
    const result = await runCli(["research", "--question"]);
    const envelope = JSON.parse(result.stderr);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(envelope.error.code).toBe("invalid_input");
  });
});
