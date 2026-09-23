import { realpathSync } from "node:fs";
import { join } from "node:path";
import { evalsDir, repoRoot } from "./paths";

/**
 * One configuration of Pi under test.
 */
export type Arm = {
  /**
   * Stable id used in result paths and CLI flags.
   */
  id: ArmId;
  /**
   * Short code shown in the report.
   */
  code: string;
  /**
   * Human-readable name shown in the report.
   */
  name: string;
};

/**
 * Ids of the two arms the suite compares.
 */
export type ArmId = "web" | "web-rfc";

/**
 * Pi plus pi-web-access, and the same plus this checkout's rfc extension.
 */
export const arms: ReadonlyArray<Arm> = [
  { id: "web", code: "W", name: "Web only" },
  { id: "web-rfc", code: "WR", name: "Web + rfc" },
];

/**
 * Narrows a CLI string to a known arm id.
 */
export const isArmId = (value: string): value is ArmId => arms.some((arm) => arm.id === value);

// Bun installs packages as symlinks into node_modules/.bun; Pi resolves an
// extension's own dependencies from its real path, so hand it that.
const webAccessExtension = (): string =>
  join(realpathSync(join(evalsDir, "node_modules", "pi-web-access")), "index.ts");

const rfcExtension = join(repoRoot, "packages", "rfc-pi", "extensions", "rfc.ts");

/**
 * Extension flags and environment for one arm.
 */
export const armSetup = (
  id: ArmId,
): { extensionArgs: Array<string>; env: Record<string, string> } => {
  const web = ["-e", webAccessExtension()];
  if (id === "web") return { extensionArgs: web, env: {} };
  return {
    extensionArgs: [...web, "-e", rfcExtension],
    env: {
      RFC_CLI_COMMAND: JSON.stringify(["bun", join(repoRoot, "packages", "rfc", "src", "bin.ts")]),
    },
  };
};
