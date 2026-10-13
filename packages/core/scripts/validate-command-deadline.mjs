/**
 * Validates the `run_command` deadline contract — the spec's `command-execution` requirements that
 * are NOT the CoreEnv safety guard (those are covered by `@codent/node`'s
 * `validate-run-command-safety-guard.mjs`):
 *
 *   1. `resolveDefaultCommandTimeout` yields the default, honours `RUN_COMMAND_TIMEOUT_MS`, and
 *      clamps a sub-1000ms / non-numeric / unreadable value back to the default.
 *   2. `isCommandTimeoutError` classifies a typed timeout (local OR remote-reconstructed).
 *   3. `buildTimedOutCommandResult` keeps partial stdout/stderr, reports `-1`/`timedOut`/`success:false`.
 *   4. end-to-end: the tool INJECTS the effective deadline into `coreEnv.runCommand` when the caller
 *      omits `timeout` (default, then `RUN_COMMAND_TIMEOUT_MS`), and a deadline-killed command
 *      returns a NORMAL result carrying its partial output instead of throwing it away.
 *
 * Run: pnpm --filter @codent/core run validate:command-deadline
 */

import assert from "node:assert/strict";

import {
  buildTimedOutCommandResult,
  createRunCommandTool,
  isCommandTimeoutError,
  resolveDefaultCommandTimeout,
} from "../dist/dev.mjs";
import { ExecutionError } from "../dist/index.mjs";

const DEFAULT = 300_000;
const envWith = (vars) => ({ getEnv: async () => vars });

// ============================================================================
// 1. Default deadline resolution
// ============================================================================
{
  assert.equal(await resolveDefaultCommandTimeout(envWith({})), DEFAULT, "no env → default");
  assert.equal(
    await resolveDefaultCommandTimeout(envWith({ RUN_COMMAND_TIMEOUT_MS: "60000" })),
    60_000,
    "RUN_COMMAND_TIMEOUT_MS overrides"
  );
  assert.equal(
    await resolveDefaultCommandTimeout(envWith({ RUN_COMMAND_TIMEOUT_MS: "500" })),
    DEFAULT,
    "a sub-1000ms value is clamped to the default"
  );
  assert.equal(
    await resolveDefaultCommandTimeout(envWith({ RUN_COMMAND_TIMEOUT_MS: "abc" })),
    DEFAULT,
    "a non-numeric value falls back to the default"
  );
  assert.equal(
    await resolveDefaultCommandTimeout({
      getEnv: async () => {
        throw new Error("env unavailable");
      },
    }),
    DEFAULT,
    "an unreadable env falls back to the default"
  );
  console.log("ok  default deadline resolution (default / override / clamp)");
}

// ============================================================================
// 2. Timeout classification
// ============================================================================
{
  assert.equal(isCommandTimeoutError(new ExecutionError("timeout", "Command timed out after 1ms")), true);
  assert.equal(isCommandTimeoutError({ code: "timeout" }), true, "remote-reconstructed shape");
  assert.equal(
    isCommandTimeoutError(new ExecutionError("aborted", "Command aborted")),
    false,
    "abort is not a timeout"
  );
  assert.equal(isCommandTimeoutError(new Error("boom")), false);
  assert.equal(isCommandTimeoutError(undefined), false);
  console.log("ok  timeout classification (typed, remote shape, negatives)");
}

// ============================================================================
// 3. Timed-out result shape keeps partial output
// ============================================================================
{
  const withStderr = buildTimedOutCommandResult({
    command: "x",
    stdout: "out",
    stderr: "cmd-err",
    timeoutMs: 5_000,
    durationMs: 42,
    cachedOutputPath: null,
  });
  assert.equal(withStderr.exitCode, -1, "-1 is the 'not finished' value");
  assert.equal(withStderr.success, false);
  assert.equal(withStderr.timedOut, true);
  assert.equal(withStderr.stdout, "out", "partial stdout is preserved");
  assert.match(withStderr.stderr, /cmd-err/, "the command's own stderr is preserved");
  assert.match(withStderr.stderr, /timed out after 5000ms/, "the timeout reason is present alongside it");

  const noStderr = buildTimedOutCommandResult({
    command: "x",
    stdout: "",
    stderr: "   ",
    timeoutMs: 5_000,
    durationMs: 1,
    cachedOutputPath: "/c.txt",
  });
  assert.match(noStderr.stderr, /timed out after 5000ms/, "with no stderr, the reason is the stderr");
  assert.equal(noStderr.cachedOutputPath, "/c.txt");
  console.log("ok  timed-out result shape keeps partial output");
}

// ============================================================================
// 4. End-to-end: the deadline is injected, and a kill yields partial output
// ============================================================================
{
  const run = async (envVars) => {
    let seenTimeout;
    const coreEnv = {
      rootPath: "/x",
      getEnv: async () => envVars,
      runCommand: async (_cmd, opts) => {
        seenTimeout = opts.timeout;
        opts.onStdout?.("partial-line\n");
        throw new ExecutionError("timeout", "Command timed out");
      },
    };
    const out = await createRunCommandTool().execute({ command: "x" }, { toolCallId: "t", context: { coreEnv } });
    return { seenTimeout, out };
  };

  const def = await run({});
  assert.equal(
    def.seenTimeout,
    DEFAULT,
    "the default deadline is injected into runCommand when the caller omits timeout"
  );
  assert.equal(def.out.timedOut, true, "a deadline-killed command yields a result, not a thrown error");
  assert.equal(def.out.exitCode, -1);
  assert.equal(def.out.success, false);
  assert.equal(def.out.stdout, "partial-line\n", "partial stdout survives to the result");
  assert.match(def.out.stderr, /timed out/, "the result names the timeout");

  const override = await run({ RUN_COMMAND_TIMEOUT_MS: "60000" });
  assert.equal(override.seenTimeout, 60_000, "RUN_COMMAND_TIMEOUT_MS is injected into runCommand");
  console.log("ok  end-to-end: injected deadline + partial output on kill");
}

console.log("command-deadline validation passed");
