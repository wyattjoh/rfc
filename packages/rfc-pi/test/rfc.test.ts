import { describe, expect, test } from "bun:test";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { rfcAgentToolMetadata, rfcMcpInstructions } from "@wyattjoh/rfc";
import rfcExtension from "../extensions/rfc";

describe("Pi RFC extension", () => {
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
