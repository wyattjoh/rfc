# `@wyattjoh/rfc-pi`

Native [Pi](https://pi.dev) integration for the RFC Evidence Engine. The package registers the six `rfc_*` tools, adds the bounded RFC lookup workflow to the system prompt, and includes the `/rfc-lookup` skill.

## Install

Requires Bun 1.4.2 or newer:

```sh
pi install npm:@wyattjoh/rfc-pi@latest
```

Authenticate the latest published CLI once before using semantic tools:

```sh
bunx @wyattjoh/rfc@latest auth login
bunx @wyattjoh/rfc@latest auth
```

The extension runs `bunx @wyattjoh/rfc@latest` for each tool call. Credentials remain in the OS credential manager and are never exposed to Pi or accepted through tool input.

Review the package before installation: Pi extensions execute with the user's full system permissions.
