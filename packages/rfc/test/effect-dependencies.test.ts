import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

// Published packages are installed without this repository's lockfile (for
// example through `bunx`), so every Effect package they load must be pinned
// directly. A transitive `@effect/*` dependency left to a caret range can
// resolve to a newer release that needs a newer `effect` than the pinned one.

const repositoryRoot = join(import.meta.dir, "../../..");
const publishedPackages = ["packages/rfc-core", "packages/rfc"];

type Manifest = {
  readonly name: string;
  readonly dependencies?: Record<string, string>;
};

const readManifest = (path: string): Manifest =>
  JSON.parse(readFileSync(join(path, "package.json"), "utf8")) as Manifest;

const isEffectPackage = (name: string): boolean => name === "effect" || name.startsWith("@effect/");

const effectDependencies = (manifest: Manifest): Array<[string, string]> =>
  Object.entries(manifest.dependencies ?? {}).filter(([name]) => isEffectPackage(name));

describe("published Effect dependencies", () => {
  const packageDirectories = publishedPackages.map((path) => join(repositoryRoot, path));
  const manifests = packageDirectories.map(readManifest);

  test("pin every Effect package to one exact version", () => {
    const versions = new Set<string>();
    for (const manifest of manifests) {
      for (const [name, version] of effectDependencies(manifest)) {
        expect({ package: manifest.name, name, version }).toEqual({
          package: manifest.name,
          name,
          version: expect.stringMatching(/^\d+\.\d+\.\d+$/),
        });
        versions.add(version);
      }
    }
    expect([...versions]).toHaveLength(1);
  });

  test("declare every transitive Effect package directly", () => {
    for (const directory of packageDirectories) {
      const manifest = readManifest(directory);
      const declared = new Set(effectDependencies(manifest).map(([name]) => name));
      for (const name of declared) {
        const installed = readManifest(join(directory, "node_modules", name));
        for (const [transitive] of effectDependencies(installed)) {
          expect({
            package: manifest.name,
            via: name,
            transitive,
            declared: declared.has(transitive),
          }).toEqual({
            package: manifest.name,
            via: name,
            transitive,
            declared: true,
          });
        }
      }
    }
  });
});
