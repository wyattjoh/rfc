import { describe, expect, test } from "bun:test";
import type {
  ExtensionAPI,
  ExtensionContext,
  ToolDefinition,
  ToolResultEvent,
  ToolResultEventResult,
} from "@earendil-works/pi-coding-agent";
import { rfcAgentToolMetadata, rfcPiInstructions } from "@wyattjoh/rfc/agent";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import rfcExtension from "../extensions/rfc";

const testDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = join(testDirectory, "../../..");
const extensionPath = join(testDirectory, "../extensions/rfc.ts");
const rfcCliEntry = join(repositoryRoot, "packages/rfc/src/bin.ts");
const piPackageEntry = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
const piExtensionLoaderUrl = pathToFileURL(
  join(dirname(piPackageEntry), "core/extensions/loader.js"),
).href;

type RegisteredExtension = {
  readonly tools: ReadonlyArray<ToolDefinition>;
  readonly beforeAgentStart: ((event: unknown) => void) | undefined;
  readonly toolResult: ((event: ToolResultEvent) => ToolResultEventResult | undefined) | undefined;
};

/**
 * Tools registered without `RFC_PI_LOCAL_TOOLS`: research only.
 */
const researchToolNames = [
  rfcAgentToolMetadata.research.name,
  rfcAgentToolMetadata.verifyCitation.name,
];

/**
 * Register the extension, opting in to the local cache and credential tools
 * when asked and otherwise with the opt-in variable unset.
 */
const registerExtension = (
  options: { readonly localTools: boolean } = { localTools: false },
): RegisteredExtension => {
  const tools: Array<ToolDefinition> = [];
  let beforeAgentStart: ((event: unknown) => void) | undefined;
  let toolResult: ((event: ToolResultEvent) => ToolResultEventResult | undefined) | undefined;
  const pi = {
    on: (event: string, handler: (event: never) => unknown) => {
      if (event === "before_agent_start") beforeAgentStart = handler as (event: unknown) => void;
      if (event === "tool_result") {
        toolResult = handler as (event: ToolResultEvent) => ToolResultEventResult | undefined;
      }
      return () => undefined;
    },
    registerTool: (tool: ToolDefinition) => {
      tools.push(tool);
    },
  } as unknown as ExtensionAPI;

  const original = process.env.RFC_PI_LOCAL_TOOLS;
  if (options.localTools) process.env.RFC_PI_LOCAL_TOOLS = "1";
  else delete process.env.RFC_PI_LOCAL_TOOLS;
  try {
    rfcExtension(pi);
  } finally {
    if (original === undefined) delete process.env.RFC_PI_LOCAL_TOOLS;
    else process.env.RFC_PI_LOCAL_TOOLS = original;
  }
  return { tools, beforeAgentStart, toolResult };
};

const findTool = (
  tools: ReadonlyArray<ToolDefinition>,
  name: string,
): ToolDefinition<never, never, never> => {
  const tool = tools.find((candidate) => candidate.name === name);
  if (tool === undefined) throw new Error(`The extension did not register ${name}`);
  return tool as unknown as ToolDefinition<never, never, never>;
};

/**
 * Put a stub `bunx` ahead of the real one so a tool call can be driven without
 * reaching the npm registry. The extension resolves `bunx` through PATH, so this
 * intercepts the spawn without a production-only seam.
 */
const withStubBunx = async <A>(script: string, run: () => Promise<A>): Promise<A> => {
  const directory = await mkdtemp(join(tmpdir(), "rfc-pi-stub-bunx-"));
  await writeFile(join(directory, "bunx"), script, { mode: 0o755 });
  const originalPath = process.env.PATH;
  // A developer override in the ambient environment would bypass the stub.
  const originalCommand = process.env.RFC_CLI_COMMAND;
  process.env.PATH = `${directory}:${originalPath ?? ""}`;
  delete process.env.RFC_CLI_COMMAND;
  try {
    return await run();
  } finally {
    process.env.PATH = originalPath;
    if (originalCommand !== undefined) process.env.RFC_CLI_COMMAND = originalCommand;
  }
};

/**
 * Run with `RFC_CLI_COMMAND` set to the supplied value, restoring it afterwards.
 */
const withCliCommand = async <A>(value: string, run: () => Promise<A>): Promise<A> => {
  const original = process.env.RFC_CLI_COMMAND;
  process.env.RFC_CLI_COMMAND = value;
  try {
    return await run();
  } finally {
    if (original === undefined) delete process.env.RFC_CLI_COMMAND;
    else process.env.RFC_CLI_COMMAND = original;
  }
};

/**
 * A stub CLI that records the argv it was handed and exits cleanly.
 */
const recordingCliScript = [
  "#!/bin/sh",
  ': > "$RFC_STUB_ARGV_FILE"',
  'for argument in "$@"; do printf \'%s\\n\' "$argument" >> "$RFC_STUB_ARGV_FILE"; done',
  "exit 0",
].join("\n");

const executionContext = undefined as unknown as ExtensionContext;

const runTool = (tool: ToolDefinition<never, never, never>, toolCallId: string, params: object) =>
  (
    tool.execute as unknown as (
      toolCallId: string,
      params: object,
      signal: AbortSignal | undefined,
      onUpdate: undefined,
      ctx: ExtensionContext,
    ) => Promise<unknown>
  )(toolCallId, params, undefined, undefined, executionContext).then(
    () => undefined,
    (error: unknown) => error as Error,
  );

describe("Pi RFC extension", () => {
  test("loads through Pi's Node extension loader", () => {
    const nodeScript = `
      const { loadExtensions } = await import(${JSON.stringify(piExtensionLoaderUrl)});
      const result = await loadExtensions(
        [${JSON.stringify(extensionPath)}],
        ${JSON.stringify(repositoryRoot)},
      );
      console.log(JSON.stringify({
        errors: result.errors,
        tools: result.extensions.flatMap((extension) => [...extension.tools.keys()]),
      }));
      if (result.errors.length > 0) process.exitCode = 1;
    `;
    const { RFC_PI_LOCAL_TOOLS: _localTools, ...env } = process.env;
    const result = Bun.spawnSync(["node", "--input-type=module", "--eval", nodeScript], {
      cwd: repositoryRoot,
      env,
      stderr: "pipe",
      stdout: "pipe",
    });

    expect(result.stderr.toString()).toBe("");
    const output = JSON.parse(result.stdout.toString()) as {
      readonly errors: ReadonlyArray<object>;
      readonly tools: ReadonlyArray<string>;
    };
    expect(output.errors).toEqual([]);
    expect(result.exitCode).toBe(0);
    expect(output.tools).toEqual(researchToolNames);
  });

  test("registers only the research tools by default", () => {
    const { tools } = registerExtension();

    expect(tools.map((tool) => tool.name)).toEqual(researchToolNames);
  });

  test("registers the MCP tool surface with shared names and descriptions", () => {
    const { tools, beforeAgentStart } = registerExtension({ localTools: true });

    const metadata = Object.values(rfcAgentToolMetadata);
    expect(tools.map((tool) => tool.name)).toEqual(metadata.map((tool) => tool.name));
    expect(tools.every((tool) => tool.name.startsWith("rfc_"))).toBe(true);
    expect(tools.map((tool) => tool.label)).toEqual(metadata.map((tool) => tool.title));
    expect(tools.map((tool) => tool.description)).toEqual(metadata.map((tool) => tool.description));
    expect(tools.every((tool) => tool.parameters !== undefined)).toBe(true);

    const sections: Record<string, string> = {};
    beforeAgentStart?.({ systemPromptOptions: { sections } });
    expect(sections.rfc_evidence_engine).toBe(rfcPiInstructions);
    // Pi registers no agent-workflow resource and has no MCP secret path.
    expect(rfcPiInstructions).not.toContain("MCP");
    expect(rfcPiInstructions).not.toContain("rfc://");
    expect(rfcPiInstructions).not.toContain("preflight");
  });
});

describe("research rendering", () => {
  test("sends the model compact JSON and keeps the full result in details", async () => {
    const researchResult = {
      schemaVersion: 3,
      kind: "research_result",
      answers: [
        {
          question: "What must the client send?",
          found: true,
          searched: ["RFC9110"],
          hits: [
            {
              rfc: { identifier: "RFC9110", title: "HTTP Semantics" },
              role: "requested",
              relevance: 0.93,
              verdict: "supports",
              passages: [
                {
                  quote: "The client MUST send a request.",
                  section: "3.  Requests",
                  probability: 0.9,
                  verdict: "supports",
                  provenance: {
                    sourceUrl: "https://www.rfc-editor.org/rfc/rfc9110.txt",
                    sourceHash: "fixture-source-hash",
                    offsetUnit: "utf8-byte",
                    startOffset: 10,
                    endOffset: 41,
                    fetchedAt: "2026-01-01T00:00:00.000Z",
                  },
                },
              ],
            },
          ],
        },
      ],
      diagnostics: {
        usage: { inputTokens: 20 },
        inputCost: { estimatedUsd: 0.00000084 },
        candidates: { pool: 1, ranked: 1 },
      },
    };
    const { tools } = registerExtension();
    const tool = findTool(tools, rfcAgentToolMetadata.research.name);
    const stdinFile = join(await mkdtemp(join(tmpdir(), "rfc-pi-render-")), "stdin.json");

    const execute = tool.execute as unknown as (
      toolCallId: string,
      params: object,
      signal: AbortSignal | undefined,
      onUpdate: undefined,
      ctx: ExtensionContext,
    ) => Promise<{
      readonly content: ReadonlyArray<{ readonly text: string }>;
      readonly details: { readonly structuredContent: object };
    }>;

    const result = await withStubBunx(
      [
        "#!/bin/sh",
        `cat > ${JSON.stringify(stdinFile)}`,
        `printf '%s\\n' '${JSON.stringify(researchResult)}'`,
      ].join("\n"),
      () =>
        execute(
          "render-1",
          { questions: ["What must the client send?"], rfcs: ["RFC9110"] },
          undefined,
          undefined,
          executionContext,
        ),
    );

    // The tool forwards the version-three request on standard input without
    // inventing an empty searchTerms array.
    expect(JSON.parse(await Bun.file(stdinFile).text())).toEqual({
      schemaVersion: 3,
      questions: ["What must the client send?"],
      rfcs: ["RFC9110"],
    });
    const text = result.content[0]?.text ?? "";
    expect(JSON.parse(text)).toEqual({
      answers: [
        {
          question: "What must the client send?",
          found: true,
          hits: [
            {
              rfc: "RFC9110",
              title: "HTTP Semantics",
              role: "requested",
              relevance: 0.93,
              verdict: "supports",
              passages: [
                {
                  section: "§3 Requests",
                  verdict: "supports",
                  quote: "The client MUST send a request.",
                  bytes: [10, 41],
                },
              ],
            },
          ],
        },
      ],
    });
    expect(text).not.toContain("sourceHash");
    expect(text).not.toContain("diagnostics");
    expect(result.details.structuredContent).toEqual(researchResult);
  });
});

describe("CLI failure diagnostics", () => {
  const failingCliScript = [
    "#!/bin/sh",
    "printf 'Resolving dependencies\\n' >&2",
    "printf \"error: Cannot find package 'effect'\\n\" >&2",
    "exit 7",
  ].join("\n");

  test("names the exit code and stderr when the CLI emits no error envelope", async () => {
    const { tools } = registerExtension({ localTools: true });
    const tool = findTool(tools, rfcAgentToolMetadata.authStatus.name);

    const error = await withStubBunx(failingCliScript, () => runTool(tool, "call-1", {}));

    expect(error).toBeInstanceOf(Error);
    expect(error?.message).toContain("exit 7");
    expect(error?.message).toContain("Cannot find package 'effect'");
  });

  test("carries the exit code and stderr into the tool result details", async () => {
    const { tools, toolResult } = registerExtension({ localTools: true });
    const tool = findTool(tools, rfcAgentToolMetadata.authStatus.name);

    await withStubBunx(failingCliScript, () => runTool(tool, "call-2", {}));

    expect(toolResult).toBeDefined();
    const hookResult = toolResult?.({
      type: "tool_result",
      toolName: tool.name,
      toolCallId: "call-2",
      input: {},
      content: [],
      details: {},
      isError: true,
    } as unknown as ToolResultEvent);

    expect(hookResult?.details).toMatchObject({
      exitCode: 7,
      stderr: expect.stringContaining("Cannot find package 'effect'"),
    });
  });
});

describe("CLI package spec", () => {
  test("pins the CLI to the exact version this package depends on", async () => {
    const { tools } = registerExtension({ localTools: true });
    const argvFile = join(await mkdtemp(join(tmpdir(), "rfc-pi-spec-")), "argv.txt");
    const originalArgvFile = process.env.RFC_STUB_ARGV_FILE;
    process.env.RFC_STUB_ARGV_FILE = argvFile;
    try {
      await withStubBunx(recordingCliScript, () =>
        runTool(findTool(tools, rfcAgentToolMetadata.authStatus.name), "spec-1", {}),
      );
    } finally {
      process.env.RFC_STUB_ARGV_FILE = originalArgvFile;
    }
    const spec = (await Bun.file(argvFile).text()).split("\n")[0];

    const piManifest = JSON.parse(
      await Bun.file(join(testDirectory, "../package.json")).text(),
    ) as { readonly dependencies: Record<string, string> };
    const cliManifest = JSON.parse(
      await Bun.file(join(repositoryRoot, "packages/rfc/package.json")).text(),
    ) as { readonly version: string };

    // A dist-tag would re-resolve on every call and could run a CLI this
    // package was never tested against.
    expect(spec).not.toContain("@latest");
    expect(spec).toBe(`@wyattjoh/rfc@${piManifest.dependencies["@wyattjoh/rfc"]}`);
    // The argv contract below replays against the in-repo CLI, so that CLI must
    // be the one the extension actually spawns.
    expect(spec).toBe(`@wyattjoh/rfc@${cliManifest.version}`);
  });
});

describe("RFC_CLI_COMMAND override", () => {
  test("runs the local CLI end to end instead of the published package", async () => {
    const { tools } = registerExtension({ localTools: true });
    const tool = findTool(tools, rfcAgentToolMetadata.authStatus.name);

    // A bunx that always fails sits on PATH, so this only succeeds if the
    // override took effect and the working-tree CLI ran instead.
    const error = await withStubBunx(
      ["#!/bin/sh", "printf 'bunx was used\\n' >&2", "exit 1"].join("\n"),
      () =>
        withCliCommand(JSON.stringify(["bun", rfcCliEntry]), () => runTool(tool, "override-1", {})),
    );

    expect(error?.message).toBeUndefined();
  });

  test("accepts a bare executable and reports an unusable value", async () => {
    const { tools } = registerExtension({ localTools: true });
    const tool = findTool(tools, rfcAgentToolMetadata.authStatus.name);
    const directory = await mkdtemp(join(tmpdir(), "rfc-pi-override-"));
    const stub = join(directory, "rfc-stub");
    await writeFile(stub, ["#!/bin/sh", "printf 'stub failure\\n' >&2", "exit 9"].join("\n"), {
      mode: 0o755,
    });

    const bare = await withCliCommand(stub, () => runTool(tool, "override-2", {}));
    expect(bare).toBeInstanceOf(Error);
    expect(bare?.message).toContain("exit 9");
    expect(bare?.message).toContain("stub failure");

    const unusable = await withCliCommand("[]", () => runTool(tool, "override-3", {}));
    expect(unusable?.message).toContain("RFC_CLI_COMMAND");
  });
});

describe("CLI argv contract", () => {
  // Arguments that let every tool's argv reach the CLI parser. The commands that
  // read structured standard input stop at input validation, so no tool in this
  // table performs a network request.
  const toolParameters: ReadonlyArray<{ readonly name: string; readonly params: object }> = [
    {
      name: rfcAgentToolMetadata.research.name,
      params: { questions: ["How is padding negotiated?"], searchTerms: ["Padding"] },
    },
    {
      name: rfcAgentToolMetadata.verifyCitation.name,
      params: { rfc: "RFC9110", claim: "A client sends a request", quote: "request" },
    },
    { name: rfcAgentToolMetadata.sourceCacheStatus.name, params: { rfc: "RFC9110" } },
    {
      name: rfcAgentToolMetadata.sourceCacheRemove.name,
      params: { rfc: "RFC9110", confirm: true },
    },
    { name: rfcAgentToolMetadata.authStatus.name, params: {} },
  ];

  /**
   * Parse failures are the only envelopes produced by `safeCliErrorReason` in
   * `packages/rfc/src/main.ts`, and every one of its reasons starts this way.
   */
  const parseFailurePattern = /^The command /;

  const lastEnvelope = (output: string): { readonly error?: { readonly message?: string } } => {
    const lines = output.split("\n").filter((line) => line.trim().startsWith("{"));
    const last = lines.at(-1);
    return last === undefined ? {} : (JSON.parse(last) as { error?: { message?: string } });
  };

  test("sends argv that every RFC CLI subcommand accepts", async () => {
    // Every registered tool is covered, so a tool added without an entry here
    // fails rather than skipping the contract.
    expect(toolParameters.map((entry) => entry.name)).toEqual(
      Object.values(rfcAgentToolMetadata).map((tool) => tool.name),
    );

    const { tools } = registerExtension({ localTools: true });
    const argvFile = join(await mkdtemp(join(tmpdir(), "rfc-pi-argv-")), "argv.txt");
    // A throwaway home keeps the replayed commands off the developer's real
    // source cache, which `cache remove` would otherwise mutate.
    const replayHome = await mkdtemp(join(tmpdir(), "rfc-pi-home-"));
    const originalArgvFile = process.env.RFC_STUB_ARGV_FILE;
    process.env.RFC_STUB_ARGV_FILE = argvFile;

    const rejections: Array<{ readonly tool: string; readonly message: string }> = [];
    try {
      for (const { name, params } of toolParameters) {
        const tool = findTool(tools, name);
        await withStubBunx(recordingCliScript, () => runTool(tool, `argv-${name}`, params));
        const recorded = (await Bun.file(argvFile).text())
          .split("\n")
          .filter((line) => line.length > 0);
        // The first recorded argument is the package spec handed to bunx.
        const argv = recorded.slice(1);
        expect(argv.length).toBeGreaterThan(0);

        // The in-repo CLI is the grammar under test; the extension resolves the
        // published package, so this catches drift within a release, not across
        // one.
        const replay = Bun.spawnSync(["bun", rfcCliEntry, ...argv], {
          cwd: repositoryRoot,
          env: { ...process.env, HOME: replayHome },
          stdin: new Blob([""]),
          stdout: "pipe",
          stderr: "pipe",
        });
        const envelope = lastEnvelope(`${replay.stdout.toString()}\n${replay.stderr.toString()}`);
        const message = envelope.error?.message ?? "";
        if (parseFailurePattern.test(message)) rejections.push({ tool: name, message });
      }
    } finally {
      process.env.RFC_STUB_ARGV_FILE = originalArgvFile;
    }

    expect(rejections).toEqual([]);
  });
});
