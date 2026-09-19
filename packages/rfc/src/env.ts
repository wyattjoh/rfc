import { ENV } from "varlock/env";

declare module "varlock/env" {
  interface TypedEnvSchema {
    readonly TYPESAFE_API_KEY: string;
    readonly TYPESAFE_MODEL: string;
    readonly RFC_POLICY_PRESET: string;
    readonly RFC_EVALUATION_MODEL: string;
    readonly RFC_PINNED_MODEL: string;
    readonly RFC_LIVE_EVALUATION: boolean;
    readonly RFC_AUTOMATIC_ANSWER_ENABLED: boolean;
    readonly RFC_EVALUATION_CACHE_DIRECTORY: string;
    readonly RFC_EVALUATION_OUTPUT: string;
  }
}

export { ENV };
