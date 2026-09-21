# rfc — an evidence engine for IETF RFCs

`rfc` answers questions about published IETF RFCs from the actual specification text. It discovers the right RFC through the IETF Datatracker, follows `updates` and `obsoletes` relationships so an obsoleted document is never quoted as current, retrieves the canonical RFC Editor source, and returns exact quotations with their UTF-8 byte offsets and a hash of the source they came from. It runs as a CLI and as a local [Model Context Protocol](https://modelcontextprotocol.io) server, so a coding agent can cite a specification instead of recalling one.

It is precision-first by construction: when the evidence does not support an answer it says so — `partial`, `unsupported`, `needs_review`, `needs_split` — rather than producing a confident paraphrase. Nothing it returns is generated prose; every quotation is a byte range in a hashed source you can re-slice yourself.

## Status: research preview

**Automatic answering is switched off in every configuration a published user can reach.** Reaching the `answered` status requires a reviewed precision calibration, and the most recent one was **rejected** — the durable decision is committed in [`packages/rfc-core/src/precision-v2-release-decision.ts`](packages/rfc-core/src/precision-v2-release-decision.ts). Until a calibration passes review, the engine returns evidence, provenance and a non-answer status, and leaves the judgment to you.

That is the honest shape of this 0.1.0: the retrieval, provenance and citation machinery is real and tested; the headline "here is your answer" step is deliberately fail-closed. Read [`docs/adr/`](docs/adr) for why the boundaries are drawn where they are.

## Install

Requires [Bun](https://bun.sh) 1.4.2 or newer. The packages ship raw TypeScript and Bun executes it directly.

```sh
bun add --global @wyattjoh/rfc
```

Store a [TypeSafe](https://typesafe.ai) API key in your OS credential manager — macOS Keychain, Linux Secret Service, or Windows Credential Manager. The key is never accepted as a command-line argument.

```sh
rfc auth add        # prompts, or use --stdin for automation
rfc auth status
```

## Quickstart

Ask about a known RFC:

```sh
echo '{"schemaVersion":2,"question":"What must a client send in a request?","rfc":"RFC9110"}' \
  | rfc research
```

Find the RFC first when you do not know it:

```sh
echo '{"schemaVersion":2,"question":"Which RFC defines HTTP caching?","rfc":null,"searchTerms":["HTTP caching","cache control"]}' \
  | rfc research
```

Check a quotation you already have:

```sh
echo '{"schemaVersion":2,"rfc":"RFC9110","claim":"A client must send a target resource.","quote":"The client MUST send a request containing the target resource.","offset":null}' \
  | rfc verify-citation
```

Inspect cumulative global usage and estimated input cost:

```sh
rfc costs
```

Every command emits versioned JSON on stdout and a versioned error envelope on stderr. Add `--format human` for readable output.

## Use it from an MCP host

Run the server over stdio:

```sh
rfc mcp
```

Claude Code, Claude Desktop, and other MCP hosts launch that command directly:

```json
{
  "mcpServers": {
    "rfc": {
      "command": "rfc",
      "args": ["mcp"]
    }
  }
}
```

The server describes its own bounded workflow in its initialization instructions, so a connected model needs nothing else from this repository. It exposes `research_known_rfc`, `research_topic`, `verify_citation`, `source_cache_status`, `source_cache_remove` and `auth_status`. The credential is outside the model-facing surface entirely: a model can ask whether one is configured and can never read, set, or remove it.

[`packages/rfc/README.md`](packages/rfc/README.md) is the full reference for the CLI protocol, the MCP surface, credential handling, and configuration.

## Data & privacy

Using this tool sends data to third parties. Specifically:

- **To [TypeSafe](https://typesafe.ai)**, on every research or citation call: your question or claim, the quotation under review, and the passages of RFC text selected as candidate evidence. This is how the semantic judgments are made. Your API key is sent as a bearer credential.
- **To the [IETF Datatracker](https://datatracker.ietf.org)**, for discovery: RFC identifiers, and — for topic search — **your search terms verbatim in the query URL**, where they may appear in upstream request logs. The tool never derives search terms on its own and never sends your full question as one unless you write it that way.
- **To the [RFC Editor](https://www.rfc-editor.org)**, for source text: RFC numbers only.

RFC source text is cached on your machine (`~/Library/Caches/rfc-evidence-engine` on macOS) and is never redistributed by this package. Cumulative token and cost totals are written to `~/.config/rfc/usage.json`; no questions, quotations or provider output are recorded there. The credential lives only in the OS credential manager and never appears in output, diagnostics, or error envelopes.

Provider endpoint overrides must use `https` outside loopback, so the credential cannot be sent in cleartext.

## Repository layout

| Path                               | What it is                                                                                                        |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `packages/rfc`                     | The published CLI and MCP server                                                                                  |
| `packages/rfc-core`                | The published engine: discovery, currency, retrieval, evidence selection, citation                                |
| `docs/adr`                         | Architecture decision records                                                                                     |
| `CONTEXT.md`                       | Domain vocabulary                                                                                                 |
| `docs/agents`, `skills`, `.claude` | Tooling for AI agents working _on_ this repository — not product documentation, and not shipped in either package |

## Development

```sh
bun install --frozen-lockfile
bun run typecheck
bun run lint
bun test packages
```

The test suite injects Datatracker, RFC Editor, provider, clock, and credential boundaries: it needs no API key, no credential manager, and no network. `bun run evaluate:live` is the only command that calls the provider for real; it costs money and requires a stored credential.

## License

MIT — see [LICENSE](LICENSE).
