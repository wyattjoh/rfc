# `@wyattjoh/rfc`

The private `rfc` package exposes the RFC evidence engine's agent-facing CLI.

## Process protocol

Catalog commands write versioned JSON responses to standard output by default:

```sh
rfc catalog status
rfc catalog refresh
rfc catalog refresh --format human
```

`catalog refresh` follows the paginated Datatracker RFC and relationship APIs, then atomically replaces the local version-one catalog. A failed refresh leaves the previous cache untouched. `catalog status` reports missing, fresh, or stale state, the cache identity, fetch time, age, and document count.

Research accepts canonical JSON on standard input:

```json
{
  "schemaVersion": 1,
  "question": "What does RFC 9110 require?",
  "rfc": "RFC9110"
}
```

When standard input contains non-whitespace input, it is authoritative and convenience flags are ignored. When standard input is empty, `--question` and `--rfc` provide the short interactive form. JSON is always the automation default; human rendering is an explicit opt-in.

Errors are versioned JSON envelopes on standard error and return a nonzero exit code. Valid domain outcomes use standard output and a zero exit code.

## Configuration

Varlock is loaded and validated before the application module for every command. The committed `.env.schema` declares the sensitive required `TYPESAFE_API_KEY`; catalog status does not make a provider request, but it still requires the validated configuration boundary. Missing configuration is reported as a versioned JSON error envelope. Bun's automatic dotenv loading is disabled in `bunfig.toml`.
