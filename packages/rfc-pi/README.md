# `@wyattjoh/rfc-pi`

Native [Pi](https://pi.dev) integration for the RFC Evidence Engine. The package registers the six `rfc_*` tools, adds the bounded RFC lookup workflow to the system prompt, and includes the `/rfc-lookup` skill.

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

## Running a local CLI

Set `RFC_CLI_COMMAND` to exercise a working-tree CLI without publishing it. Accepts a JSON array for a command with arguments, or a bare executable path:

```sh
export RFC_CLI_COMMAND='["bun","/path/to/rfc/packages/rfc/src/bin.ts"]'
```

Unset, the pinned published package is used. The variable chooses an executable, so treat it the way you treat `PATH`.

Review the package before installation: Pi extensions execute with the user's full system permissions.
