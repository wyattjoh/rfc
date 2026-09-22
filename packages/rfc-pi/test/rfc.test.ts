import { describe, expect, test } from "bun:test";
import type {
  ExtensionAPI,
  ExtensionContext,
  ToolDefinition,
  ToolResultEvent,
  ToolResultEventResult,
} from "@earendil-works/pi-coding-agent";
import { rfcAgentToolMetadata, rfcMcpInstructions } from "@wyattjoh/rfc/agent";
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

const registerExtension = (): RegisteredExtension => {
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

  rfcExtension(pi);
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
  process.env.PATH = `${directory}:${originalPath ?? ""}`;
  try {
    return await run();
  } finally {
    process.env.PATH = originalPath;
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
    const result = Bun.spawnSync(["node", "--input-type=module", "--eval", nodeScript], {
      cwd: repositoryRoot,
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
    expect(output.tools).toEqual(Object.values(rfcAgentToolMetadata).map((tool) => tool.name));
  });

  test("registers the MCP tool surface with shared names and descriptions", () => {
    const { tools, beforeAgentStart } = registerExtension();

    const metadata = Object.values(rfcAgentToolMetadata);
    expect(tools.map((tool) => tool.name)).toEqual(metadata.map((tool) => tool.name));
    expect(tools.every((tool) => tool.name.startsWith("rfc_"))).toBe(true);
    expect(tools.map((tool) => tool.label)).toEqual(metadata.map((tool) => tool.title));
    expect(tools.map((tool) => tool.description)).toEqual(metadata.map((tool) => tool.description));
    expect(tools.every((tool) => tool.parameters !== undefined)).toBe(true);

    const sections: Record<string, string> = {};
    beforeAgentStart?.({ systemPromptOptions: { sections } });
    expect(sections.rfc_evidence_engine).toBe(rfcMcpInstructions);
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
    const { tools } = registerExtension();
    const tool = findTool(tools, rfcAgentToolMetadata.authStatus.name);

    const error = await withStubBunx(failingCliScript, () => runTool(tool, "call-1", {}));

    expect(error).toBeInstanceOf(Error);
    expect(error?.message).toContain("exit 7");
    expect(error?.message).toContain("Cannot find package 'effect'");
  });

  test("carries the exit code and stderr into the tool result details", async () => {
    const { tools, toolResult } = registerExtension();
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
    const { tools } = registerExtension();
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

describe("CLI argv contract", () => {
  // Arguments that let every tool's argv reach the CLI parser. The commands that
  // read structured standard input stop at input validation, so no tool in this
  // table performs a network request.
  const toolParameters: ReadonlyArray<{ readonly name: string; readonly params: object }> = [
    {
      name: rfcAgentToolMetadata.researchKnownRfc.name,
      params: { question: "What must a client send?", rfc: "RFC9110" },
    },
    {
      name: rfcAgentToolMetadata.researchTopic.name,
      params: { question: "How is padding negotiated?", searchTerms: ["Padding"] },
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

    const { tools } = registerExtension();
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
