#!/usr/bin/env bun

import { loadVarlock } from "./varlock-bootstrap";

const argv = process.argv.slice(2);

if (await loadVarlock(import.meta.dir)) {
  // This import must stay after Varlock has resolved and validated configuration
  // so no application module can read configuration before the boundary runs.
  const { run } = await import("./main");
  process.exitCode = await run(argv);
} else {
  process.exitCode = 1;
}
