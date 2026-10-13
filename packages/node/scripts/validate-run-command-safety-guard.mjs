/**
 * Validates the foreground command deadline + CoreEnv safety-guard contract.
 *
 * Why this exists: `run_command` with no caller timeout hit a hard 30s wall inside the CoreEnv
 * safety guard, which killed a legitimately still-running command and misreported it ("did not exit
 * (stdio handles held open by detached descendant)") with a fabricated `exitCode: 1` — and, when
 * the command wrote its own stderr, dropped the reason entirely. This pins the fixed contract:
 *
 *   1. the guard is a LAST RESORT — it fires only while the process is still running, kills the
 *      tree, and names the effective bound (never an unverified "detached descendant");
 *   2. a process that EXITS while a descendant holds the stdout pipe is reported as finished (after
 *      a bounded drain grace) with its real exit code, NOT as a safety kill;
 *   3. a safety kill preserves the partial output, reports `-1`, and surfaces the reason ALONGSIDE
 *      the command's own stderr (never `stderr || reason`);
 *   4. the guard timer is cleared on settle.
 *
 * The guard bound is a process-wide constant, so these drive `waitForChildProcess` / the exported
 * failure mapping directly rather than a 30s end-to-end command.
 *
 * Run: pnpm --filter @codent/node run validate:run-command-safety-guard
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";

import { resolveRunFailure, waitForChildProcess } from "../dist/index.mjs";

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// ============================================================================
// 4. The guard timer is cleared on settle (run first, for a clean baseline)
// ============================================================================
{
  const before = process.getActiveResourcesInfo().filter((r) => r === "Timeout").length;
  const child = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: ["ignore", "pipe", "pipe"] });
  const code = await waitForChildProcess(child, 60_000);
  assert.equal(code, 0, "a child that exits resolves with its real exit code");
  const after = process.getActiveResourcesInfo().filter((r) => r === "Timeout").length;
  assert.ok(after <= before, `a settled process must leave no guard timer pending (before=${before}, after=${after})`);
  console.log("ok  guard timer cleared on settle");
}

// ============================================================================
// 3. The failure mapping: safety kill keeps output, reports -1, reason alongside stderr
// ============================================================================
{
  const reason = "safety-timeout:command did not exit within 30000ms (still running); process tree killed";

  // no command stderr → the reason becomes stderr
  const noStderr = resolveRunFailure({ error: new Error(reason), stdout: "partial-out", stderr: "" });
  assert.equal(noStderr.exitCode, -1, "a safety kill reports -1, not a fabricated 1");
  assert.equal(noStderr.stdout, "partial-out", "partial stdout is preserved");
  assert.match(noStderr.stderr, /30000ms/, "stderr names the effective bound");

  // command stderr present → BOTH are kept (never `stderr || reason`)
  const withStderr = resolveRunFailure({ error: new Error(reason), stdout: "out", stderr: "command-wrote-this" });
  assert.equal(withStderr.exitCode, -1);
  assert.match(withStderr.stderr, /command-wrote-this/, "the command's own stderr is preserved");
  assert.match(withStderr.stderr, /did not exit within 30000ms/, "the safety reason is also present");
  assert.doesNotMatch(withStderr.stderr, /detached descendant/i, "no unverified cause is asserted");

  // typed abort/timeout still rethrow (unchanged)
  assert.throws(
    () => resolveRunFailure({ error: new Error("timeout:5"), stdout: "", stderr: "" }),
    (e) => e.name === "ExecutionError" && e.code === "timeout",
    "a caller timeout rethrows ExecutionError('timeout')"
  );
  assert.throws(
    () => resolveRunFailure({ error: new Error("aborted"), stdout: "", stderr: "" }),
    (e) => e.name === "ExecutionError" && e.code === "aborted",
    "an abort rethrows ExecutionError('aborted')"
  );
  console.log("ok  safety kill keeps output, reports -1, reason alongside stderr");
}

// ============================================================================
// 1. The guard fires only for a still-running process, and names the bound
// ============================================================================
{
  const slow = spawn(process.execPath, ["-e", "setTimeout(() => {}, 10_000)"], {
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });

  await assert.rejects(
    () => waitForChildProcess(slow, 500),
    (err) =>
      /safety-timeout:command did not exit within 500ms/.test(err.message) && !/detached descendant/i.test(err.message),
    "a still-running process is killed with a reason naming the bound and no unverified cause"
  );
  await wait(100); // let the tree kill settle
  console.log("ok  guard fires only for a still-running process and names the bound");
}

// ============================================================================
// 2. A process that exits while a descendant holds the pipe is NOT a safety kill
// ============================================================================
{
  // The outer node exits immediately after spawning a detached grandchild that inherits its stdout
  // (fd 1) and lives 5s. So `exit` fires at ~0s while `close` is held until ~5s: exactly the case
  // the old guard misread. The drain grace must settle with the real code (~2s), not reject.
  const holder =
    "const{spawn}=require('node:child_process');" +
    "spawn(process.execPath,['-e','setTimeout(()=>{},5000)'],{stdio:['ignore',1,2],detached:true}).unref();" +
    "process.exit(0);";
  const child = spawn(process.execPath, ["-e", holder], { stdio: ["ignore", "pipe", "pipe"], detached: true });

  const started = Date.now();
  const code = await waitForChildProcess(child, 30_000);
  const elapsed = Date.now() - started;

  assert.equal(code, 0, "an exited process whose pipe is held reports its real exit code");
  assert.ok(
    elapsed < 4_000,
    `it settles by the drain grace, not by waiting out the pipe holder (elapsed=${elapsed}ms)`
  );
  console.log(`ok  exited process with a pipe-holding descendant settles at ${elapsed}ms (not a safety kill)`);
}

console.log("run-command safety-guard validation passed");
