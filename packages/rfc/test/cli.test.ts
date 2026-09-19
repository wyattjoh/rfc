import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";

const servers: Array<ReturnType<typeof Bun.serve>> = [];

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

afterEach(() => {
  for (const server of servers.splice(0)) {
    server.stop(true);
  }
});

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
      cacheIdentity: "rfc-catalog-v1",
      fetchedAt: null,
      refreshedAt: null,
      ageMs: null,
      documentCount: 0,
    });
    expect(result.stderr).toBe("");
  });

  test("refreshes the catalog through the JSON process protocol", async () => {
    const cacheDirectory = await mkdtemp(join(tmpdir(), "rfc-cli-refresh-test-"));
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        const url = new URL(request.url);
        if (url.pathname.endsWith("/document/")) {
          return Response.json({
            meta: { limit: 500, offset: 0, total_count: 1, next: null, previous: null },
            objects: [
              {
                name: "rfc9110",
                rfc_number: 9110,
                title: "HTTP Semantics",
                abstract: "HTTP semantics.",
                resource_uri: "/api/v1/doc/document/rfc9110/",
                stream: "/api/v1/name/streamname/ietf/",
                states: [],
              },
            ],
          });
        }
        if (url.pathname.endsWith("/relateddocument/")) {
          return Response.json({
            meta: { limit: 500, offset: 0, total_count: 0, next: null, previous: null },
            objects: [],
          });
        }
        return new Response("not found", { status: 404 });
      },
    });
    servers.push(server);

    const result = await runCli([
      "catalog",
      "refresh",
      "--cache-directory",
      cacheDirectory,
      "--datatracker-api-url",
      `${server.url}api/v1/`,
    ]);

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      schemaVersion: 1,
      kind: "catalog_refresh",
      state: "fresh",
      documentCount: 1,
      cacheIdentity: "rfc-catalog-v1",
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
