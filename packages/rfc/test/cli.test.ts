import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { hashRfcSource } from "@wyattjoh/rfc-core";

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

    const human = await runCli([
      "catalog",
      "status",
      "--cache-directory",
      cacheDirectory,
      "--format",
      "human",
    ]);
    expect(human.exitCode).toBe(0);
    expect(human.stderr).toBe("");
    expect(human.stdout).toContain("Catalog: missing");
    expect(human.stdout).toContain(`Path: ${join(cacheDirectory, "catalog.json")}`);
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

  test("writes successful research evidence as versioned JSON", async () => {
    const cacheDirectory = await mkdtemp(join(tmpdir(), "rfc-cli-research-test-"));
    const sourceText =
      "1. Requirements\n\nThe client MUST send a request containing the target resource.\n";
    const fetchedAt = new Date().toISOString();
    const sourceHash = hashRfcSource(sourceText);
    await mkdir(join(cacheDirectory, "sources"), { recursive: true });
    await writeFile(
      join(cacheDirectory, "catalog.json"),
      JSON.stringify({
        schemaVersion: 1,
        kind: "rfc_catalog",
        cacheIdentity: "rfc-catalog-v1",
        fetchedAt,
        documents: [
          {
            identifier: "RFC9110",
            rfcNumber: 9110,
            title: "HTTP Semantics",
            abstract: "HTTP semantics.",
            status: "published",
            stream: "ietf",
            canonicalUrl: "https://datatracker.ietf.org/doc/rfc9110/",
            updates: [],
            updatedBy: [],
            obsoletes: [],
            obsoletedBy: [],
          },
        ],
      }),
    );
    await writeFile(
      join(cacheDirectory, "sources", `${sourceHash}.json`),
      JSON.stringify({
        schemaVersion: 1,
        kind: "rfc_source_content",
        contentHash: sourceHash,
        text: sourceText,
      }),
    );
    await writeFile(
      join(cacheDirectory, "sources", "RFC9110.json"),
      JSON.stringify({
        schemaVersion: 1,
        kind: "rfc_source_index",
        identifier: "RFC9110",
        rfcNumber: 9110,
        sourceUrl: "https://www.rfc-editor.org/rfc/rfc9110.txt",
        contentHash: sourceHash,
        fetchedAt,
      }),
    );

    let modelCalls = 0;
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        if (new URL(request.url).pathname !== "/systemone") {
          return new Response("not found", { status: 404 });
        }
        modelCalls += 1;
        const answers = Object.fromEntries([
          [
            "question_atomicity",
            {
              type: "choice",
              choice: "atomic",
              probabilities: { atomic: 0.99, compound: 0.01 },
              confidence: 0.99,
            },
          ],
          ...Array.from({ length: 8 }, (_, index) => [
            `passage_${index}`,
            modelCalls % 2 === 1
              ? { type: "noul", noul: 0.99 }
              : {
                  type: "choice",
                  choice: "direct_answer",
                  probabilities: {
                    direct_answer: 0.99,
                    partial_answer: 0.005,
                    background_only: 0.001,
                    contradictory: 0.001,
                    irrelevant: 0.003,
                  },
                  confidence: 0.99,
                },
          ]),
        ]);
        return Response.json({
          model: "jev-1.13.0",
          answers,
          usage: { input_tokens: 10, output_tokens: 6 },
        });
      },
    });
    servers.push(server);

    const result = await runCli(
      [
        "research",
        "--cache-directory",
        cacheDirectory,
        "--typesafe-api-url",
        server.url.toString(),
      ],
      JSON.stringify({ schemaVersion: 1, question: "What must the client send?", rfc: "9110" }),
      {
        ...process.env,
        TYPESAFE_API_KEY: "fixture-key",
        TYPESAFE_MODEL: "jev-latest",
        RFC_POLICY_PRESET: "precision-v1",
      },
    );

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    const response = JSON.parse(result.stdout);
    expect(response.status).toBe("answered");
    expect(response.rfc.identifier).toBe("RFC9110");
    expect(response.evidence[0].provenance.sourceUrl).toBe(
      "https://www.rfc-editor.org/rfc/rfc9110.txt",
    );
    expect(response.diagnostics.resolvedModel).toBe("jev-1.13.0");

    const human = await runCli(
      [
        "research",
        "--cache-directory",
        cacheDirectory,
        "--typesafe-api-url",
        server.url.toString(),
        "--format",
        "human",
      ],
      JSON.stringify({ schemaVersion: 1, question: "What must the client send?", rfc: "9110" }),
      {
        ...process.env,
        TYPESAFE_API_KEY: "fixture-key",
        TYPESAFE_MODEL: "jev-latest",
        RFC_POLICY_PRESET: "precision-v1",
      },
    );
    expect(human.exitCode).toBe(0);
    expect(human.stderr).toBe("");
    expect(human.stdout).toContain("Status: answered");
    expect(human.stdout).toContain("RFC: RFC9110");
    expect(human.stdout).toContain("The client MUST send");
    expect(modelCalls).toBe(4);
  });

  test("returns every valid non-answer status successfully through JSON process semantics", async () => {
    const cases = [
      { status: "partial", question: "What must the client send?" },
      { status: "unsupported", question: "What must the client send?" },
      { status: "needs_review", question: "What must the client send?" },
      { status: "needs_split", question: "What must the client send?" },
    ] as const;
    let caseIndex = 0;
    let requestCount = 0;
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        requestCount += 1;
        const payload = (await request.json()) as {
          readonly questions: Readonly<Record<string, unknown>>;
        };
        const currentCase = cases[caseIndex];
        if (currentCase === undefined) return new Response("unexpected case", { status: 500 });
        const isSelection = Object.prototype.hasOwnProperty.call(
          payload.questions,
          "question_atomicity",
        );
        const compound = currentCase.status === "needs_split";
        const answers = Object.fromEntries(
          Object.keys(payload.questions).map((key) => {
            if (key === "question_atomicity") {
              return [
                key,
                {
                  type: "choice",
                  choice: compound ? "compound" : "atomic",
                  probabilities: compound
                    ? { atomic: 0.01, compound: 0.99 }
                    : { atomic: 0.99, compound: 0.01 },
                  confidence: 0.99,
                },
              ];
            }
            if (isSelection) {
              return [
                key,
                {
                  type: "noul",
                  noul: currentCase.status === "unsupported" ? 0.1 : 0.99,
                },
              ];
            }
            const uncertain = currentCase.status === "needs_review";
            const relation = currentCase.status === "partial" ? "partial_answer" : "direct_answer";
            const probability = uncertain ? 0.5 : 0.99;
            const remainder = (1 - probability) / 4;
            return [
              key,
              {
                type: "choice",
                choice: relation,
                probabilities: {
                  direct_answer: relation === "direct_answer" ? probability : remainder,
                  partial_answer: relation === "partial_answer" ? probability : remainder,
                  background_only: remainder,
                  contradictory: remainder,
                  irrelevant: remainder,
                },
                confidence: uncertain ? 0.5 : 0.99,
              },
            ];
          }),
        );
        return Response.json({
          model: "jev-1.13.0",
          answers,
          usage: { input_tokens: 10, output_tokens: 6 },
        });
      },
    });
    servers.push(server);

    for (const currentCase of cases) {
      const cacheDirectory = await mkdtemp(join(tmpdir(), "rfc-cli-status-test-"));
      const sourceText =
        "1. Requirements\\n\\nThe client MUST send a request containing the target resource.\\n";
      const fetchedAt = new Date().toISOString();
      const sourceHash = hashRfcSource(sourceText);
      await mkdir(join(cacheDirectory, "sources"), { recursive: true });
      await writeFile(
        join(cacheDirectory, "catalog.json"),
        JSON.stringify({
          schemaVersion: 1,
          kind: "rfc_catalog",
          cacheIdentity: "rfc-catalog-v1",
          fetchedAt,
          documents: [
            {
              identifier: "RFC9110",
              rfcNumber: 9110,
              title: "HTTP Semantics",
              abstract: "HTTP semantics.",
              status: "published",
              stream: "ietf",
              canonicalUrl: "https://datatracker.ietf.org/doc/rfc9110/",
              updates: [],
              updatedBy: [],
              obsoletes: [],
              obsoletedBy: [],
            },
          ],
        }),
      );
      await writeFile(
        join(cacheDirectory, "sources", `${sourceHash}.json`),
        JSON.stringify({
          schemaVersion: 1,
          kind: "rfc_source_content",
          contentHash: sourceHash,
          text: sourceText,
        }),
      );
      await writeFile(
        join(cacheDirectory, "sources", "RFC9110.json"),
        JSON.stringify({
          schemaVersion: 1,
          kind: "rfc_source_index",
          identifier: "RFC9110",
          rfcNumber: 9110,
          sourceUrl: "https://www.rfc-editor.org/rfc/rfc9110.txt",
          contentHash: sourceHash,
          fetchedAt,
        }),
      );

      const result = await runCli(
        [
          "research",
          "--cache-directory",
          cacheDirectory,
          "--typesafe-api-url",
          server.url.toString(),
        ],
        JSON.stringify({ schemaVersion: 1, question: currentCase.question, rfc: "9110" }),
        {
          ...process.env,
          TYPESAFE_API_KEY: "fixture-key",
          TYPESAFE_MODEL: "jev-latest",
          RFC_POLICY_PRESET: "precision-v1",
        },
      );

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
      expect(JSON.parse(result.stdout)).toMatchObject({
        schemaVersion: 1,
        kind: "evidence_bundle",
        status: currentCase.status,
      });
      caseIndex += 1;
    }

    expect(requestCount).toBe(6);
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
