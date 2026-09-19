import { ENV } from "varlock/env";

declare module "varlock/env" {
  interface TypedEnvSchema {
    readonly TYPESAFE_API_KEY: string;
    readonly TYPESAFE_MODEL: string;
    readonly RFC_POLICY_PRESET: string;
  }
}

export { ENV };
