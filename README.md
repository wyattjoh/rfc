# rfc — an evidence engine for IETF RFCs

`rfc` answers questions about published IETF RFCs from the actual specification text. It discovers candidate RFCs through the IETF Datatracker, follows `updates` and `obsoletes` relationships, retrieves the canonical RFC Editor source, ranks which RFCs and sections bear on each question, and returns the exact paragraphs with their UTF-8 byte offsets and source hash. It runs as a CLI and as a local [Model Context Protocol](https://modelcontextprotocol.io) server, so a coding agent can cite a specification instead of recalling one.

It does retrieval and relevance judgment only; the caller does the reasoning and writes the answer. For each question it reports whether an answer was found, which RFCs were searched, and up to three exact passages per relevant RFC, each labelled `supports`, `partial`, `says_nothing`, or `contradicts`. Every quotation is a byte range in a hashed source you can re-slice yourself. See [ADR 0005](docs/adr/0005-jev-ranked-retrieval-without-research-statuses.md) for the design.

> [!IMPORTANT]
> **Status: research preview**
>
> The ranking floors and selection limits are uncalibrated working values. The retrieval, provenance, and citation machinery is tested, but a passage the tool did not select is never read, so treat `found: false` as "not found in these RFCs", not as proof that no RFC says it.

## Run

Requires [Bun](https://bun.sh) 1.4.2 or newer. The packages ship raw TypeScript and Bun executes it directly. Run the latest published CLI through `bunx`; no global installation is required.

Store a [TypeSafe](https://typesafe.ai) API key in your OS credential manager — macOS Keychain, Linux Secret Service, or Windows Credential Manager. The key is never accepted as a command-line argument.

```sh
bunx @wyattjoh/rfc@latest auth login # prompts, or use --stdin for automation
bunx @wyattjoh/rfc@latest auth
```

## Quickstart

Human invocations print readable output by default. Repeat `-q` once per fact you need, and name RFCs with `-r` or discover them with `--search-term`:

```sh
bunx @wyattjoh/rfc@latest research \
  -q "What does the 429 status code mean?" \
  -q "Which header says how long to wait?" \
  -r RFC6585 -r RFC9110
bunx @wyattjoh/rfc@latest research -q "How long may a cache reuse a response?" \
  --search-term "HTTP caching"
bunx @wyattjoh/rfc@latest verify-citation RFC9110 \
  "A client must send a target resource." \
  "The client MUST send a request containing the target resource."
bunx @wyattjoh/rfc@latest cache status RFC9110
bunx @wyattjoh/rfc@latest costs
```

The equivalent long flags are available, including `--question`, `--rfc`, `--claim`, and `--quote`. Pass `--format json` when a human-style invocation needs machine-readable output.

Agents and programs can send the version-three JSON protocol on standard input. Structured standard input selects JSON output by default:

```sh
echo '{"schemaVersion":3,"questions":["What must a client send in a request?"],"rfcs":["RFC9110"]}' \
  | bunx @wyattjoh/rfc@latest research

echo '{"schemaVersion":3,"questions":["How long may a cache reuse a response?"],"searchTerms":["HTTP caching"]}' \
  | bunx @wyattjoh/rfc@latest research

echo '{"schemaVersion":3,"rfc":"RFC9110","claim":"A client must send a target resource.","quote":"The client MUST send a request containing the target resource.","offset":null}' \
  | bunx @wyattjoh/rfc@latest verify-citation
```

Errors remain versioned JSON envelopes on standard error for both input styles.

## Install the Claude Code plugin

The repository is a Claude Code marketplace containing the `rfc` plugin. The plugin bundles the RFC lookup skill and starts the latest published MCP server through `bunx`, so Bun 1.4.2 or newer must be available:

```sh
claude plugin marketplace add wyattjoh/rfc
claude plugin install rfc@wyattjoh-rfc --scope user
```

Authenticate once outside Claude Code, then start a fresh session:

```sh
bunx @wyattjoh/rfc@latest auth login
```

The plugin exposes the MCP tools automatically and registers the skill as `/rfc:rfc-lookup`. For local development, validate and load the checkout directly:

```sh
claude plugin validate . --strict
claude --plugin-dir .
```

## Install the Pi package

The published `@wyattjoh/rfc-pi` Pi package registers the MCP server's `rfc_research`, `rfc_verify_citation`, and `rfc_source_text` tools with the same names, labels, descriptions, and input constraints, plus bounded workflow instructions without the MCP-only rules; set `RFC_PI_LOCAL_TOOLS=1` to also register the cache and credential tools. It invokes the exact CLI version pinned by the package for each tool call rather than running an MCP transport, so Bun 1.4.2 or newer must be available. It also includes the RFC lookup skill:

```sh
pi install npm:@wyattjoh/rfc-pi
```

Load the checkout directly while developing:

```sh
pi -e .
```

Review the repository before installation: Pi extensions execute with the user's full system permissions. The extension retains the same credential boundary as the CLI and MCP server; it can inspect credential status but cannot add, reveal, or remove the key.

## Use it from another MCP host

Run the server over stdio:

```sh
bunx @wyattjoh/rfc@latest mcp
```

Claude Code, Claude Desktop, and other MCP hosts launch that command directly:

```json
{
  "mcpServers": {
    "rfc": {
      "command": "bunx",
      "args": ["@wyattjoh/rfc@latest", "mcp"]
    }
  }
}
```

The server describes its own workflow in its initialization instructions, so a connected model needs nothing else from this repository. It exposes `rfc_research`, `rfc_verify_citation`, `rfc_source_text`, `rfc_source_cache_status`, `rfc_source_cache_remove` and `rfc_auth_status`. The credential is outside the model-facing surface entirely: a model can ask whether one is configured and can never read, set, or remove it.

[`packages/rfc/README.md`](packages/rfc/README.md) is the full reference for the CLI protocol, the MCP surface, credential handling, and configuration.

## Optional full-text topic search

By default, topic discovery matches each search term as a literal substring of an RFC title or abstract through the Datatracker. That finds an RFC only when you can name it close to its title: `Retry-After` matches nothing, even though RFC 9110 defines it.

The IETF runs the full-text search backend behind the search box on [rfc-editor.org](https://www.rfc-editor.org), which also indexes keywords and published RFC body text. Pointing this tool at it makes `Retry-After` resolve to RFC 9110. Measured over twelve realistic terms, full-text search found the intended RFC in the top twenty every time, where the title/abstract filters found six.

It is **off by default and ships with no credential**. That backend carries no documented contract for programmatic use, sits behind bot management, and belongs to the IETF, so enabling it is your decision and the key is yours to supply and rotate:

```sh
export RFC_SEARCH_API_KEY="<search-only key>"
export RFC_SEARCH_API_URL="https://typesense.ietf.org/"   # optional, this is the default
rfc research -q "How long should a client wait before retrying?" --search-term "Retry-After"
```

or per invocation:

```sh
rfc research --rfc-search-api-key "<key>" --search-term "Retry-After" ...
```

If a search request fails for any reason — revoked key, rate limit, outage, bot challenge, changed index — discovery **falls back to the Datatracker title/abstract queries** rather than failing. The fallback is reported as `topicSearchFallback` in retrieval diagnostics, so a result that found nothing while degraded is distinguishable from a term that genuinely matches nothing.

## Data & privacy

Using this tool sends data to third parties. Specifically:

- **To [TypeSafe](https://typesafe.ai)**, when semantic evaluation is required: research sends your questions, candidate RFC titles and abstracts, section previews, and the paragraphs of selected sections; citation verification sends your claim and quotation. Some results, such as empty discovery or an absent quotation, return without contacting TypeSafe. Your API key is sent as a bearer credential.
- **To the [IETF Datatracker](https://datatracker.ietf.org)**, for discovery: RFC identifiers, and — for topic search — **your search terms verbatim in the query URL**, where they may appear in upstream request logs. The tool never derives search terms on its own and never sends your full question as one unless you write it that way.
- **To the IETF RFC search service**, only if you enable full-text topic search: the same search terms verbatim, to a different IETF host with its own access logs. Your search key is sent as a request header and never appears in URLs, diagnostics, or traces.
- **To the [RFC Editor](https://www.rfc-editor.org)**, for source text: RFC numbers only.

RFC source text is cached on your machine (`~/Library/Caches/rfc-evidence-engine` on macOS) and is never redistributed by this package. Cumulative token and cost totals are written to `~/.config/rfc/usage.json`; no questions, quotations or provider output are recorded there. The credential lives only in the OS credential manager and never appears in output, diagnostics, or error envelopes.

Provider endpoint overrides must use `https` outside loopback, so the credential cannot be sent in cleartext.

## Repository layout

| Path                     | What it is                                                                                 |
| ------------------------ | ------------------------------------------------------------------------------------------ |
| `packages/rfc`           | The published CLI and MCP server                                                           |
| `packages/rfc-core`      | The published engine: discovery, currency, retrieval, ranking, passage selection, citation |
| `packages/rfc-pi`        | The published native Pi extension and RFC lookup skill                                     |
| `docs/adr`               | Architecture decision records                                                              |
| `CONTEXT.md`             | Domain vocabulary                                                                          |
| `skills/rfc-lookup`      | Claude Code plugin link to the lookup skill published from `packages/rfc-pi`               |
| `docs/agents`, `.claude` | Tooling for AI agents working _on_ this repository — not product documentation             |

## Development

```sh
bun install --frozen-lockfile
bun run typecheck
bun run lint
bun test packages
```

The test suite injects Datatracker, RFC Editor, provider, clock, and credential boundaries: it needs no API key, no credential manager, and no network.

## License

MIT — see [LICENSE](LICENSE).
