import { Schema } from "effect";

/**
 * The stable Bun credential-store service used by the RFC CLI.
 */
export const credentialStoreService = "com.wyattjoh.rfc" as const;

/**
 * The stable Bun credential-store name used for the TypeSafe API key.
 */
export const credentialStoreName = "typesafe-api-key" as const;

/**
 * The version shared by authentication command responses.
 */
export const authSchemaVersion = 2 as const;

/**
 * The operation being performed against the platform credential manager.
 */
export const CredentialStoreOperationSchema = Schema.Literals(["get", "set", "delete"]);

/**
 * A platform credential-manager operation.
 */
export type CredentialStoreOperation = Schema.Schema.Type<typeof CredentialStoreOperationSchema>;

/**
 * The safe categories used to classify platform credential-manager failures.
 */
export const CredentialStoreFailureKindSchema = Schema.Literals([
  "unavailable",
  "denied",
  "storage",
  "deletion",
]);

/**
 * A safe platform credential-manager failure category.
 */
export type CredentialStoreFailureKind = Schema.Schema.Type<
  typeof CredentialStoreFailureKindSchema
>;

/**
 * A credential-manager error that deliberately contains no provider secret or
 * platform error message.
 */
export class CredentialStoreError extends Schema.TaggedError<CredentialStoreError>()(
  "CredentialStoreError",
  {
    operation: CredentialStoreOperationSchema,
    kind: CredentialStoreFailureKindSchema,
  },
) {}

/**
 * Signals that no TypeSafe API key is configured in the credential manager.
 */
export class CredentialMissingError extends Schema.TaggedError<CredentialMissingError>()(
  "CredentialMissingError",
  {},
) {}

/**
 * Signals that authentication input was not a single non-empty credential.
 */
export class CredentialInputError extends Schema.TaggedError<CredentialInputError>()(
  "CredentialInputError",
  {
    reason: Schema.String,
  },
) {}

/**
 * The options identifying one native Bun secret.
 */
export interface BunSecretsOptions {
  /**
   * Stable service identifier.
   */
  readonly service: string;
  /**
   * Stable account/name identifier.
   */
  readonly name: string;
}

/**
 * The narrow native Bun.secrets surface required by the CLI.
 *
 * Keeping this interface separate from Bun.secrets makes the credential
 * boundary replaceable in deterministic tests and embedded callers.
 */
export interface BunSecretsApi {
  /**
   * Retrieve a stored value, or null when it is absent.
   */
  readonly get: (options: BunSecretsOptions) => Promise<string | null>;
  /**
   * Store or overwrite a value.
   */
  readonly set: (options: BunSecretsOptions & { readonly value: string }) => Promise<void>;
  /**
   * Delete a value and report whether it existed.
   */
  readonly delete: (options: BunSecretsOptions) => Promise<boolean>;
}

/**
 * The deep credential-store interface used by authentication and provider
 * construction. It intentionally does not expose service or name parameters:
 * every operation targets the one documented TypeSafe credential identity.
 */
export interface CredentialStore {
  /**
   * Retrieve the TypeSafe API key, or null when absent.
   */
  readonly get: () => Promise<string | null>;
  /**
   * Store or overwrite the TypeSafe API key.
   */
  readonly set: (value: string) => Promise<void>;
  /**
   * Delete the TypeSafe API key and report whether it existed.
   */
  readonly delete: () => Promise<boolean>;
}

/**
 * The public identity of the credential used by auth status and mutation
 * results. It contains no credential value or derivative.
 */
export interface CredentialStoreIdentity {
  /**
   * Stable service identifier.
   */
  readonly service: typeof credentialStoreService;
  /**
   * Stable name identifier.
   */
  readonly name: typeof credentialStoreName;
}

/**
 * The documented credential-store identity.
 */
export const credentialStoreIdentity: CredentialStoreIdentity = Object.freeze({
  service: credentialStoreService,
  name: credentialStoreName,
});

const nativeOptions: BunSecretsOptions = credentialStoreIdentity;

const errorText = (error: unknown): string => {
  if (typeof error !== "object" || error === null) return "";
  const candidate = error as {
    readonly code?: unknown;
    readonly name?: unknown;
    readonly message?: unknown;
  };
  return [candidate.code, candidate.name, candidate.message]
    .filter((value): value is string => typeof value === "string")
    .join(" ")
    .toLowerCase();
};

const failureKindFor = (
  operation: CredentialStoreOperation,
  error: unknown,
): CredentialStoreFailureKind => {
  const text = errorText(error);
  if (
    /access.?denied|permission|not authorized|unauthori[sz]ed|forbidden|eacces|eperm/.test(text)
  ) {
    return "denied";
  }
  if (
    /unavailable|not found|not running|unsupported|not implemented|keychain.*(?:unavailable|not found|not running)|secret service.*(?:unavailable|not found|not running)|credential manager.*(?:unavailable|not found|not running)|libsecret.*(?:unavailable|not found|not running)|no such service/.test(
      text,
    )
  ) {
    return "unavailable";
  }
  return operation === "delete" ? "deletion" : operation === "set" ? "storage" : "unavailable";
};

const runStoreOperation = async <A>(
  operation: CredentialStoreOperation,
  action: () => Promise<A>,
): Promise<A> => {
  try {
    return await action();
  } catch (error) {
    if (error instanceof CredentialStoreError) throw error;
    throw new CredentialStoreError({
      operation,
      kind: failureKindFor(operation, error),
    });
  }
};

/**
 * Construct the RFC credential boundary over an injectable Bun.secrets-like
 * implementation.
 *
 * @param secrets Native Bun.secrets or a deterministic replacement.
 * @returns A credential store scoped to the documented service/name pair.
 */
export const makeCredentialStore = (secrets: BunSecretsApi = Bun.secrets): CredentialStore => ({
  get: () => runStoreOperation("get", () => secrets.get(nativeOptions)),
  set: (value) => runStoreOperation("set", () => secrets.set({ ...nativeOptions, value })),
  delete: () => runStoreOperation("delete", () => secrets.delete(nativeOptions)),
});

/**
 * Construct the production credential boundary backed by Bun's OS credential
 * manager.
 *
 * @returns A Bun.secrets-backed TypeSafe credential store.
 */
export const makeDefaultCredentialStore = (): CredentialStore => makeCredentialStore();

/**
 * Validate and normalize a credential received from an explicit input source.
 *
 * @param value Raw interactive or standard-input content.
 * @returns The single-line credential without its terminal line ending.
 * @throws CredentialInputError when input is empty or contains another line.
 */
export const normalizeCredentialInput = (value: string): string => {
  const normalized = value.replace(/\r?\n$/, "").trim();
  if (normalized.length === 0 || /[\r\n]/.test(normalized)) {
    throw new CredentialInputError({
      reason: "The TypeSafe API key must be a non-empty single line",
    });
  }
  return normalized;
};

/**
 * Read the stored key without returning it in a public result.
 *
 * @param store Injectable credential boundary.
 * @returns Whether a non-empty credential is configured.
 */
export const hasStoredCredential = async (store: CredentialStore): Promise<boolean> => {
  const value = await runStoreOperation("get", store.get);
  return value !== null && value.length > 0;
};

/**
 * Resolve the stored TypeSafe API key immediately before provider creation.
 *
 * @param store Injectable credential boundary.
 * @returns The secret value for the provider constructor.
 * @throws CredentialMissingError when no non-empty key is configured.
 */
export const resolveStoredCredential = async (store: CredentialStore): Promise<string> => {
  const value = await runStoreOperation("get", store.get);
  if (value === null || value.length === 0) {
    throw new CredentialMissingError({});
  }
  return value;
};

/**
 * Store or overwrite a TypeSafe API key and return only safe metadata.
 *
 * @param store Injectable credential boundary.
 * @param value Raw credential input.
 * @returns Versioned metadata indicating whether an existing value was replaced.
 */
export const addStoredCredential = async (
  store: CredentialStore,
  value: string,
): Promise<AuthAddResult> => {
  const normalized = normalizeCredentialInput(value);
  const existed = await hasStoredCredential(store);
  await runStoreOperation("set", () => store.set(normalized));
  return Schema.decodeUnknownSync(AuthAddResultSchema)({
    schemaVersion: authSchemaVersion,
    kind: "auth_add",
    configured: true,
    replaced: existed,
    service: credentialStoreService,
    name: credentialStoreName,
  });
};

/**
 * Return safe status information for the stored TypeSafe API key.
 *
 * @param store Injectable credential boundary.
 * @returns Whether a credential is configured and its stable store identity.
 */
export const storedCredentialStatus = async (store: CredentialStore): Promise<AuthStatus> =>
  Schema.decodeUnknownSync(AuthStatusSchema)({
    schemaVersion: authSchemaVersion,
    kind: "auth_status",
    configured: await hasStoredCredential(store),
    service: credentialStoreService,
    name: credentialStoreName,
  });

/**
 * Delete the stored TypeSafe API key without exposing its value.
 *
 * @param store Injectable credential boundary.
 * @returns A deterministic result for both existing and already-absent keys.
 */
export const removeStoredCredential = async (store: CredentialStore): Promise<AuthRemoveResult> => {
  const removed = await runStoreOperation("delete", store.delete);
  return Schema.decodeUnknownSync(AuthRemoveResultSchema)({
    schemaVersion: authSchemaVersion,
    kind: "auth_remove",
    removed,
    configured: false,
    service: credentialStoreService,
    name: credentialStoreName,
  });
};

/**
 * Versioned result emitted after storing a credential.
 */
export const AuthAddResultSchema = Schema.Struct({
  schemaVersion: Schema.Literal(authSchemaVersion),
  kind: Schema.Literal("auth_add"),
  configured: Schema.Boolean,
  replaced: Schema.Boolean,
  service: Schema.Literal(credentialStoreService),
  name: Schema.Literal(credentialStoreName),
});

/**
 * Versioned metadata emitted after storing a credential.
 */
export type AuthAddResult = Schema.Schema.Type<typeof AuthAddResultSchema>;

/**
 * Versioned result emitted by auth status.
 */
export const AuthStatusSchema = Schema.Struct({
  schemaVersion: Schema.Literal(authSchemaVersion),
  kind: Schema.Literal("auth_status"),
  configured: Schema.Boolean,
  service: Schema.Literal(credentialStoreService),
  name: Schema.Literal(credentialStoreName),
});

/**
 * Versioned safe credential status metadata.
 */
export type AuthStatus = Schema.Schema.Type<typeof AuthStatusSchema>;

/**
 * Versioned result emitted after removing a credential.
 */
export const AuthRemoveResultSchema = Schema.Struct({
  schemaVersion: Schema.Literal(authSchemaVersion),
  kind: Schema.Literal("auth_remove"),
  removed: Schema.Boolean,
  configured: Schema.Boolean,
  service: Schema.Literal(credentialStoreService),
  name: Schema.Literal(credentialStoreName),
});

/**
 * Versioned safe credential-removal metadata.
 */
export type AuthRemoveResult = Schema.Schema.Type<typeof AuthRemoveResultSchema>;
