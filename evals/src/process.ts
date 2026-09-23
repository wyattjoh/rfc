import type { Subprocess } from "bun";

/**
 * How a waited-on process ended.
 */
export type ProcessEnd = {
  /**
   * Exit code, or null when the process was killed by a signal it did not handle.
   */
  exitCode: number | null;
  /**
   * True when the deadline passed and the process had to be stopped.
   */
  timedOut: boolean;
};

/**
 * Waits for `proc`, sending SIGTERM at `timeoutMs` and SIGKILL `graceMs` later
 * if it is still running. The timeout is tracked here rather than inferred from
 * the exit: Pi traps SIGTERM and exits 143 on its own, so its exit looks like an
 * ordinary failure.
 */
export const waitWithTimeout = async (
  proc: Subprocess,
  timeoutMs: number,
  graceMs = 10_000,
): Promise<ProcessEnd> => {
  let timedOut = false;
  const term = setTimeout(() => {
    timedOut = true;
    proc.kill("SIGTERM");
  }, timeoutMs);
  const kill = setTimeout(() => proc.kill("SIGKILL"), timeoutMs + graceMs);
  try {
    const exitCode = await proc.exited;
    return { exitCode: proc.signalCode === null ? exitCode : null, timedOut };
  } finally {
    clearTimeout(term);
    clearTimeout(kill);
  }
};
