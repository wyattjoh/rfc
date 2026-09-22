# Expose a safe self-describing MCP surface

**Status:** accepted

The RFC evidence engine exposes a local stdio MCP server through `rfc mcp`, using dedicated typed tools, structured results, server instructions, and a static agent-workflow resource so a model can perform RFC research without skill or CLI access. The model-facing surface deliberately excludes credential mutation and per-call cache or upstream overrides: credentials remain human-managed through the OS store, trusted operators select infrastructure overrides only when launching the process, and cache removal requires explicit confirmation. CLI and MCP adapters share operation orchestration, concise rendering, usage accounting, and safe versioned errors so their behavior does not drift; this trades literal command parity for a smaller surface that cannot redirect credential-bearing traffic or widen filesystem and network authority.
