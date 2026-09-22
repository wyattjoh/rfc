import { describe, expect, test } from "bun:test";
import {
  CredentialInputError,
  CredentialMissingError,
  CredentialStoreError,
  addStoredCredential,
  credentialStoreName,
  credentialStoreService,
  makeCredentialStore,
  normalizeCredentialInput,
  removeStoredCredential,
  resolveStoredCredential,
  storedCredentialStatus,
  type BunSecretsApi,
  type CredentialStore,
} from "../src/credentials";
import { run } from "../src/main";

const makeNativeSecrets = (initial: string | null = null): BunSecretsApi => {
  let value = initial;
  return {
    get: async ({ service, name }) => {
      expect(service).toBe(credentialStoreService);
      expect(name).toBe(credentialStoreName);
      return value;
    },
    set: async ({ service, name, value: next }) => {
      expect(service).toBe(credentialStoreService);
      expect(name).toBe(credentialStoreName);
      value = next;
    },
    delete: async ({ service, name }) => {
      expect(service).toBe(credentialStoreService);
      expect(name).toBe(credentialStoreName);
      const existed = value !== null;
      value = null;
      return existed;
    },
  };
};

const runAuth = async (
  args: Array<string>,
  input: string | undefined,
  credentialStore: CredentialStore,
  promptCredential: () => Promise<string> = async () => "prompt-secret",
): Promise<{ readonly exitCode: number; readonly stdout: string; readonly stderr: string }> => {
  let stdout = "";
  let stderr = "";
  const exitCode = await run(args, {
    credentialStore,
    // Auth commands never construct a client; fail loudly if that changes.
    createClient: () => {
      throw new Error("auth commands must not construct an RFC client");
    },
    readStandardInput: async () => input ?? "",
    promptCredential,
    readUsage: async () => ({
      schemaVersion: 1,
      kind: "rfc_usage_totals",
      updatedAt: "2026-01-01T00:00:00.000Z",
      operations: 0,
      pricedOperations: 0,
      unpricedOperations: 0,
      operationsWithoutInputTokens: 0,
      inputTokens: 0,
      pricedInputTokens: 0,
      unpricedInputTokens: 0,
      estimatedInputCostUsd: 0,
    }),
    recordUsage: async () => ({
      schemaVersion: 1,
      kind: "rfc_usage_totals",
      updatedAt: "2026-01-01T00:00:00.000Z",
      operations: 0,
      pricedOperations: 0,
      unpricedOperations: 0,
      operationsWithoutInputTokens: 0,
      inputTokens: 0,
      pricedInputTokens: 0,
      unpricedInputTokens: 0,
      estimatedInputCostUsd: 0,
    }),
    writeStdout: (value) => {
      stdout += value;
    },
    writeStderr: (value) => {
      stderr += value;
    },
  });
  return { exitCode, stdout, stderr };
};

describe("Bun.secrets credential boundary", () => {
  test("uses one stable service/name pair and supports add, overwrite, status, and remove", async () => {
    const native = makeNativeSecrets();
    const store = makeCredentialStore(native);

    expect(await storedCredentialStatus(store)).toMatchObject({
      schemaVersion: 2,
      kind: "auth_status",
      configured: false,
      service: credentialStoreService,
      name: credentialStoreName,
    });
    expect(await addStoredCredential(store, "first-secret")).toMatchObject({
      kind: "auth_add",
      configured: true,
      replaced: false,
      service: credentialStoreService,
      name: credentialStoreName,
    });
    expect(await resolveStoredCredential(store)).toBe("first-secret");
    expect(await addStoredCredential(store, "second-secret")).toMatchObject({
      kind: "auth_add",
      configured: true,
      replaced: true,
    });
    expect(await resolveStoredCredential(store)).toBe("second-secret");
    expect(await removeStoredCredential(store)).toMatchObject({
      kind: "auth_remove",
      removed: true,
      configured: false,
    });
    expect(await removeStoredCredential(store)).toMatchObject({
      kind: "auth_remove",
      removed: false,
      configured: false,
    });
  });

  test("rejects missing credentials without constructing a provider", async () => {
    const store = makeCredentialStore(makeNativeSecrets());
    await expect(resolveStoredCredential(store)).rejects.toBeInstanceOf(CredentialMissingError);
  });

  test("normalizes explicit stdin input and rejects multiline or empty values", () => {
    expect(normalizeCredentialInput("secret\n")).toBe("secret");
    expect(() => normalizeCredentialInput("\n")).toThrow();
    expect(() => normalizeCredentialInput("first\nsecond")).toThrow();
  });

  test("classifies platform failures without retaining their messages or secrets", async () => {
    const unavailable = makeCredentialStore({
      get: async () => {
        throw new Error("secret-value: secret service unavailable");
      },
      set: async () => undefined,
      delete: async () => false,
    });
    await expect(storedCredentialStatus(unavailable)).rejects.toMatchObject({
      _tag: "CredentialStoreError",
      operation: "get",
      kind: "unavailable",
    });

    const denied = makeCredentialStore({
      get: async () => null,
      set: async () => {
        throw new Error("secret-value: permission denied");
      },
      delete: async () => false,
    });
    const error = await addStoredCredential(denied, "secret-value").catch((failure) => failure);
    expect(error).toBeInstanceOf(CredentialStoreError);
    expect(JSON.stringify(error)).not.toContain("secret-value");
    expect(error).toMatchObject({ kind: "denied", operation: "set" });

    const deletion = makeCredentialStore({
      get: async () => "configured",
      set: async () => undefined,
      delete: async () => {
        throw new Error("credential manager write failed");
      },
    });
    await expect(removeStoredCredential(deletion)).rejects.toMatchObject({
      _tag: "CredentialStoreError",
      operation: "delete",
      kind: "deletion",
    });
  });
});

describe("authentication process protocol", () => {
  test("accepts only explicit stdin mode and never writes the key", async () => {
    let stored: string | null = null;
    const store: CredentialStore = {
      get: async () => stored,
      set: async (value) => {
        stored = value;
      },
      delete: async () => {
        const existed = stored !== null;
        stored = null;
        return existed;
      },
    };
    const secret = "stdin-secret-value";
    const result = await runAuth(
      ["auth", "login", "--stdin", "--format", "json"],
      `${secret}\n`,
      store,
    );

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).not.toContain(secret);
    expect(JSON.parse(result.stdout)).toMatchObject({
      schemaVersion: 2,
      kind: "auth_add",
      configured: true,
      replaced: false,
      service: credentialStoreService,
      name: credentialStoreName,
    });
    expect(stored as string | null).toBe(secret);
  });

  test("uses the injected prompt for interactive login and rejects non-TTY prompt fallback", async () => {
    const store = makeCredentialStore(makeNativeSecrets());
    const prompted = await runAuth(
      ["auth", "login"],
      undefined,
      store,
      async () => "prompt-secret",
    );
    expect(prompted.exitCode).toBe(0);
    expect(prompted.stdout).not.toContain("prompt-secret");

    const rejected = await runAuth(["auth", "login"], "piped-secret\n", store, async () => {
      throw new CredentialInputError({
        reason: "Interactive credential input requires a TTY; use --stdin for automation",
      });
    });
    expect(rejected.exitCode).toBe(1);
    expect(rejected.stdout).toBe("");
    expect(JSON.parse(rejected.stderr)).toMatchObject({
      error: { code: "invalid_input" },
    });
    expect(rejected.stderr).not.toContain("piped-secret");
  });

  test("bare auth and remove expose only safe metadata and deterministic absence", async () => {
    const store = makeCredentialStore(makeNativeSecrets("hidden-secret"));
    const status = await runAuth(["auth", "--format", "json"], undefined, store);
    expect(status.exitCode).toBe(0);
    expect(status.stdout).not.toContain("hidden-secret");
    expect(JSON.parse(status.stdout)).toMatchObject({ configured: true });

    const removed = await runAuth(["auth", "remove", "--format", "json"], undefined, store);
    expect(JSON.parse(removed.stdout)).toMatchObject({ removed: true, configured: false });
    const absent = await runAuth(["auth", "remove", "--format", "json"], undefined, store);
    expect(JSON.parse(absent.stdout)).toMatchObject({ removed: false, configured: false });
  });

  test("rejects the retired auth add and auth status subcommands", async () => {
    const store = makeCredentialStore(makeNativeSecrets("hidden-secret"));

    for (const args of [
      ["auth", "add"],
      ["auth", "status"],
    ]) {
      const result = await runAuth(args, undefined, store);
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toBe("");
      expect(JSON.parse(result.stderr)).toMatchObject({ error: { code: "invalid_input" } });
    }
  });

  test("maps credential-store failures and rejects argv secrets without redaction leaks", async () => {
    const secret = "argv-secret-value";
    const argv = await runAuth(["auth", "login", `--api-key=${secret}`], undefined, {
      get: async () => null,
      set: async () => undefined,
      delete: async () => false,
    });
    expect(argv.exitCode).toBe(1);
    expect(argv.stderr).not.toContain(secret);
    expect(JSON.parse(argv.stderr)).toMatchObject({ error: { code: "invalid_input" } });

    const failing: CredentialStore = {
      get: async () => null,
      set: async () => {
        throw new Error(`${secret}: permission denied`);
      },
      delete: async () => false,
    };
    const result = await runAuth(["auth", "login", "--stdin"], `${secret}\n`, failing);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).not.toContain(secret);
    expect(JSON.parse(result.stderr)).toMatchObject({
      error: { code: "credential_access_denied" },
    });
  });

  test("rejects near-miss credential flag names before the CLI parses them", async () => {
    const secret = "sk-live-near-miss-secret";
    const store: CredentialStore = {
      get: async () => null,
      set: async () => undefined,
      delete: async () => false,
    };

    for (const argument of [
      `--api-token=${secret}`,
      `--typesafe-token=${secret}`,
      `--API-KEY=${secret}`,
      `--client-secret=${secret}`,
      `--credential=${secret}`,
      "--api-token",
    ]) {
      const result = await runAuth(["auth", "login", argument], undefined, store);
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).not.toContain(secret);
      expect(JSON.parse(result.stderr)).toEqual({
        schemaVersion: 3,
        kind: "error",
        error: {
          code: "invalid_input",
          message: "The TypeSafe API key must be supplied through --stdin or an interactive prompt",
        },
      });
    }
  });

  test("leaves the engine's own flag names outside the credential deny-list", async () => {
    const store = makeCredentialStore(makeNativeSecrets("stored-secret"));

    for (const argument of [
      "--typesafe-api-url=https://example.test",
      "--datatracker-api-url=https://example.test",
      "--cache-directory=/tmp/rfc-cache",
      "--search-term=tokenizer",
      "--policy-preset=balanced",
    ]) {
      const result = await runAuth(["auth", argument], undefined, store);
      // The flag is not valid for bare `auth`, but it must fail as an
      // ordinary parse error rather than as a rejected credential argument.
      expect(result.stderr).not.toContain("must be supplied through --stdin");
    }
  });
});
