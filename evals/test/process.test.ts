import { describe, expect, test } from "bun:test";
import { waitWithTimeout } from "../src/process";

const sh = (script: string) =>
  Bun.spawn(["sh", "-c", script], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });

describe("waitWithTimeout", () => {
  test("reports a normal exit without a timeout", async () => {
    expect(await waitWithTimeout(sh("exit 3"), 5_000)).toEqual({ exitCode: 3, timedOut: false });
  });

  test("flags a timeout even when the process traps SIGTERM and exits 143, like Pi", async () => {
    const end = await waitWithTimeout(sh('trap "exit 143" TERM; sleep 30 & wait'), 200, 5_000);
    expect(end).toEqual({ exitCode: 143, timedOut: true });
  });

  test("force-kills a process that ignores SIGTERM after the grace period", async () => {
    const started = Date.now();
    const end = await waitWithTimeout(sh('trap "" TERM; while :; do sleep 0.05; done'), 200, 300);
    expect(end).toEqual({ exitCode: null, timedOut: true });
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});
