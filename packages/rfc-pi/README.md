# `@wyattjoh/rfc-pi`

Native [Pi](https://pi.dev) integration for the RFC Evidence Engine. The package registers the `rfc_research`, `rfc_verify_citation`, and `rfc_source_text` tools, adds the RFC lookup workflow to the system prompt, and includes the `/rfc-lookup` skill.

Tool results reach the model as compact JSON: per question, `found`, and ranked hits with RFC, title, role, relevance, verdict, and passages (`section`, `verdict`, exact `quote`, and UTF-8 `bytes` range). The complete version-three result, including diagnostics and provenance, stays in the tool result details.

## Install

Requires Bun 1.4.2 or newer:

```sh
pi install npm:@wyattjoh/rfc-pi
```

Authenticate the latest published CLI once before using semantic tools:

```sh
bunx @wyattjoh/rfc@latest auth login
bunx @wyattjoh/rfc@latest auth
```

Each tool call runs the CLI through `bunx`, pinned to the exact `@wyattjoh/rfc` version this package depends on rather than a dist-tag, so a call never re-resolves against the registry and never runs a CLI this package was not tested against. Credentials remain in the OS credential manager and are never exposed to Pi or accepted through tool input.

## Full RFC source text

Use `rfc_source_text` only when the full RFC text is explicitly required or requested; prefer the research and citation tools for ordinary questions. With just `rfc`, it returns the source hash, total UTF-8 byte length, and parsed headings with half-open byte ranges, not the text. Give both `startOffset` and `endOffset` to retrieve that exact, untruncated slice (citation ranges use the same offsets). Pass `expectedSourceHash` on later reads so a revalidated source change fails rather than mixing snapshots.

## Local cache and credential tools

`rfc_source_cache_status`, `rfc_source_cache_remove`, and `rfc_auth_status` are not registered by default, because research never needs them and every registered tool is resent to the model on each request. Set `RFC_PI_LOCAL_TOOLS=1` before starting Pi to register them:

```sh
export RFC_PI_LOCAL_TOOLS=1
```

## Running a local CLI

Set `RFC_CLI_COMMAND` to exercise a working-tree CLI without publishing it. Accepts a JSON array for a command with arguments, or a bare executable path:

```sh
export RFC_CLI_COMMAND='["bun","/path/to/rfc/packages/rfc/src/bin.ts"]'
```

Unset, the pinned published package is used. The variable chooses an executable, so treat it the way you treat `PATH`.

Review the package before installation: Pi extensions execute with the user's full system permissions.
