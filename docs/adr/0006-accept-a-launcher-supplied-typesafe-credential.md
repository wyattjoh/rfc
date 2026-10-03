# Accept a launcher-supplied TypeSafe credential

**Status:** accepted

The CLI composition root accepts the TypeSafe API key from the `RFC_TYPESAFE_API_KEY` process environment variable ahead of the `Bun.secrets` store, so a trusted launcher can supply the key without a separate `rfc auth login` step. The Claude Code plugin declares the key as required, sensitive user configuration: Claude Code collects it when the plugin is enabled, keeps it in the platform credential store, and injects it only into the MCP server process environment. The overlay changes reads alone; `auth login` and `auth remove` still write and delete the stored key, and blank values fall back to the store. The core still never reads environment variables, the model-facing surface still cannot read, set, or remove the key, and `bunfig.toml` still keeps `.env` files out of the process. This trades the key's exclusive residence in the OS store for single-step plugin installation; the value is now readable from the MCP process environment by the same OS user, which the store's own access model already permits.

This supersedes the "one injectable `Bun.secrets` credential boundary" portion of [ADR-0001](./0001-rfc-evidence-engine-boundaries.md) and the "credentials remain human-managed through the OS store" portion of [ADR 0003](./0003-expose-a-safe-self-describing-mcp-surface.md).
