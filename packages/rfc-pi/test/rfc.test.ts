import { describe, expect, test } from "bun:test";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { rfcAgentToolMetadata, rfcMcpInstructions } from "@wyattjoh/rfc/agent";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import rfcExtension from "../extensions/rfc";

const testDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = join(testDirectory, "../../..");
const extensionPath = join(testDirectory, "../extensions/rfc.ts");
const piPackageEntry = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
const piExtensionLoaderUrl = pathToFileURL(
  join(dirname(piPackageEntry), "core/extensions/loader.js"),
).href;

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
    const tools: Array<ToolDefinition> = [];
    let beforeAgentStart: ((event: unknown) => void) | undefined;
    const pi = {
      on: (event: string, handler: (event: unknown) => void) => {
        if (event === "before_agent_start") beforeAgentStart = handler;
        return () => undefined;
      },
      registerTool: (tool: ToolDefinition) => {
        tools.push(tool);
      },
    } as unknown as ExtensionAPI;

    rfcExtension(pi);

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
