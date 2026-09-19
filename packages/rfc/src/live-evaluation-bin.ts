#!/usr/bin/env bun

import { join } from "node:path";
import { loadVarlock } from "./varlock-bootstrap";

if (await loadVarlock(join(import.meta.dir, "../../.."))) {
  const { runLiveEvaluation } = await import("./live-evaluation");
  try {
    process.exitCode = await runLiveEvaluation();
  } catch (error) {
    const { toErrorEnvelope } = await import("@wyattjoh/rfc-core");
    process.stderr.write(`${JSON.stringify(toErrorEnvelope(error))}\n`);
    process.exitCode = 1;
  }
} else {
  process.exitCode = 1;
}
