/**
 * Validates the `run_command` deadline contract — the spec's `command-execution` requirements that
 * are NOT the CoreEnv safety guard (those are covered by `@codent/node`'s
 * `validate-run-command-safety-guard.mjs`):
 *
 *   1. `resolveDefaultCommandTimeout` yields the default, honours `RUN_COMMAND_TIMEOUT_MS`, and
 *      clamps a sub-1000ms / non-numeric / unreadable value back to the default.
 *   2. `isTimeoutError` classifies a typed timeout (local OR remote-reconstructed).
 *   3. `buildTimedOutCommandResult` keeps partial stdout/stderr and reports `-1` / `timedOut` /
 *      `timeoutMs` / `success:false`, leaving `stderr` as the command's own output.
 *   4. end-to-end: the tool INJECTS the effective deadline into `coreEnv.runCommand` when the caller
 *      omits `timeout` (default, then `RUN_COMMAND_TIMEOUT_MS`), and a deadline-killed command
 *      returns a NORMAL result carrying its partial output instead of throwing it away.
 *   5. the PRESENTERS name the deadline: the UI's `formatToolOutput` renders `Command timed out
 *      after Nms` instead of the crash-looking `Exit code: -1` — and the model output carries the
 *      same reason (the `toModelOutput` shape is asserted through `commandTimeoutNotice`).
 *
 * Run: pnpm --filter @codent/core run validate:command-deadline
 */

import assert from "node:assert/strict";

import {
  buildTimedOutCommandResult,
  createRunCommandTool,
  isTimeoutError,
  resolveDefaultCommandTimeout,
} from "../dist/dev.mjs";
import { ExecutionError, formatToolOutput } from "../dist/index.mjs";

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
  assert.equal(isTimeoutError(new ExecutionError("timeout", "Command timed out after 1ms")), true);
  assert.equal(isTimeoutError({ code: "timeout" }), true, "remote-reconstructed shape");
  assert.equal(isTimeoutError(new ExecutionError("aborted", "Command aborted")), false, "abort is not a timeout");
  assert.equal(isTimeoutError(new Error("boom")), false);
  assert.equal(isTimeoutError(undefined), false);
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
  assert.equal(withStderr.timeoutMs, 5_000, "the deadline travels structurally");
  assert.equal(withStderr.stdout, "out", "partial stdout is preserved");
  assert.equal(withStderr.stderr, "cmd-err", "stderr stays the command's own output — the reason is structural");
  assert.equal(withStderr.cachedOutputPath, null);
  console.log("ok  timed-out result shape keeps partial output");
}

// ============================================================================
// 3b. The UI presenter NAMES the deadline instead of the crash-looking `Exit code: -1`
// ============================================================================
{
  const output = buildTimedOutCommandResult({
    command: "sleep 999",
    stdout: "partial-line",
    stderr: "real-err",
    timeoutMs: 300_000,
    durationMs: 300_000,
    cachedOutputPath: null,
  });
  const rendered = formatToolOutput(output, "run_command");
  assert.ok(!/Exit code/.test(rendered), `a deadline kill has no exit code to report, got: ${rendered}`);
  assert.match(rendered, /Command timed out after 300000ms/, "the presenter names the bound");
  assert.match(rendered, /partial-line/, "and keeps the partial output");
  assert.match(rendered, /real-err/, "and the command's own stderr");
  assert.ok(!/timed out/.test(String(output.stderr)), "the reason is not duplicated into stderr");

  // A genuine failure is untouched — no reason may be invented for it.
  const failed = formatToolOutput(
    { command: "false", stdout: "", stderr: "boom", exitCode: 1, durationMs: 5, success: false },
    "run_command"
  );
  assert.match(failed, /Exit code: 1/, "a real failure still reports its code");
  assert.ok(!/timed out/.test(failed), "and is not relabelled as a timeout");
  console.log("ok  UI presenter names the deadline (no `Exit code: -1`)");
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
  assert.equal(def.out.timeoutMs, DEFAULT, "the elapsed deadline travels on the result");
  assert.match(formatToolOutput(def.out, "run_command"), /timed out/, "and the presenter names it");

  const override = await run({ RUN_COMMAND_TIMEOUT_MS: "60000" });
  assert.equal(override.seenTimeout, 60_000, "RUN_COMMAND_TIMEOUT_MS is injected into runCommand");
  console.log("ok  end-to-end: injected deadline + partial output on kill");
}

console.log("command-deadline validation passed");
