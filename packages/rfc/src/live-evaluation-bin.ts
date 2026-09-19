#!/usr/bin/env bun

import { runLiveEvaluation } from "./live-evaluation";
import { toCliErrorEnvelope } from "./main";

try {
  // Invoking this dedicated binary is the explicit live-evaluation opt-in.
  process.exitCode = await runLiveEvaluation({
    credentialStore: undefined,
    enable: true,
  });
} catch (error) {
  process.stderr.write(`${JSON.stringify(toCliErrorEnvelope(error))}\n`);
  process.exitCode = 1;
}
