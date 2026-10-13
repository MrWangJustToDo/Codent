## Context

`run_command` executes through the CoreEnv `runCommand`. In `@codent/node` that is
`spawnCommand` (`shell.ts`) → `waitForChildProcess`, wrapped by `runNativeCommand`
(`native-run.ts`). Two independent deadlines exist:

- the **caller timeout** (`run-command-tool` passes the model's `timeout`): `spawnCommand` starts
  a timer that calls `onAbort()` → `killProcessTree(pid)` → sets `timedOut` → throws `timeout:N` →
  `native-run` maps it to `ExecutionError("timeout", "Command timed out after Nms")`. This path is
  correct and already kills the process group.
- the **safety guard** (`waitForChildProcess`): a last-resort used when `close` never fires. When
  no caller timeout is present, `safetyTimeoutMs` is `undefined` and the guard defaults to
  `MIN_SAFETY_TIMEOUT_MS = 30_000`.

The guard was added for a real edge (a detached descendant holding the stdout pipe after the shell
exits, so `close` never arrives). But as written it also fires for a plainly still-running command,
and it reports that edge as if it were the cause. `runNativeCommand`'s catch then does
`stderr: stderr || String(err)` and `exitCode: 1`, so the guard surfaces either as a misdiagnosed
`stderr` line (when the command wrote no stderr) or not at all (when it did).

## Goals / Non-Goals

**Goals:**

- Remove the user-visible failure: a no-timeout foreground command that finishes after ~30s must
  not be killed and misreported.
- Make the safety guard a true last resort with honest, actionable reporting.
- Preserve the command's partial stdout/stderr whenever a deadline or guard ends it.
- Report a real exit code (or `-1`), never a fabricated `1`.

**Non-Goals:**

- Changing the tool input/output schema, or the `run_in_background` path (`spawnDetachedCommand`).
- Making foreground commands unbounded (a deadline is still needed to bound a hung shell).
- Reworking the `ExecutionError` type to carry output (see Decisions).

## Decisions

**1. The symptom is fixed by giving `run_command` an effective default deadline — not by raising
the safety bound.** Priority matters: changing `close`→`exit` only fixes the "exited but pipe
still open" case (b); the observed failures are all "still running past the bound" (a), where
`exit` has not fired either, so the guard fires identically. Only a real deadline removes them.
Routing through the **caller timeout** path (not a larger `MIN_SAFETY_TIMEOUT_MS`) is deliberate:
that path already kills the process tree and yields an actionable
`ExecutionError("timeout", "Command timed out after Nms")`, whereas raising the wall just moves a
misdiagnosed death. The guard stays as a backstop for a shell that never exits.

- The default is configurable (env/tool-config), documented in the tool description, and overridden
  by the caller `timeout`. Chosen default: large enough not to race normal builds/tests, small
  enough to bound a hang.
- Alternatives considered: raise `MIN_SAFETY_TIMEOUT_MS` only (rejected — moves the wall, keeps the
  misdiagnosis); remove the guard (rejected — a native shell that never exits would hang the run).

**2. The guard judges the deadline on `exit`, with a short `close` drain grace.**
"Has the process finished?" is an `exit` question; `close` only means "output drained". Resolve the
deadline on `exit`, then wait a bounded grace for `close` to capture trailing bytes. Resolving on
`exit` alone (without the grace) would truncate the tail — rejected.

**3. On guard trigger: kill the process tree, keep partial output, report the bound, `exitCode: -1`.**
`killProcessTree(pid, "SIGKILL")` (already used by the timeout path) instead of `child.kill`, so the
`pnpm`/`node`/`tail` descendants — the very processes that hold the pipe — are reaped. The
`CommandResult` carries the accumulated `stdout` and the real `stderr`; the guard reason is surfaced
**alongside** them (not as `stderr || reason`), and `exitCode` is `-1` (the schema's existing "not
finished" value — `run-command-tool`'s cancel branch already uses it). The message names the
effective bound and that the process was still running.

**4. `ExecutionError` is not extended.** Its signature is `(code, message, cause?)` with no output
fields; extending it would ripple across local/remote boundaries for one guard. Keeping the
`CommandResult` return shape (with honest fields) is the smaller change.

**5. Clear the guard timer on settle.** `waitForChildProcess` never `clearTimeout`s, leaving a
pending 30s timer after every successful command (keeps the event loop alive; benign for the TUI,
wasteful for one-shot runs).

## Risks / Trade-offs

- [Default deadline kills a legitimately longer command] → it is configurable and caller-overridable,
  and the failure is now an actionable timeout, not a misdiagnosis. Document the default in the tool
  description so the model can raise it.
- [`exit` before `close` loses the tail] → keep the drain grace and only stop waiting on `exit`.
- [Detached long-lived processes (dev servers) are still killed] → unchanged: those belong to
  `run_in_background`, which does not use this path.
- [`exitCode` 1 → -1 changes rendering/log assertions] → the new validator pins the contract; the
  cancel branch already renders -1, so formatters handle it.

## Migration Plan

1. `@codent/node`: `waitForChildProcess` — resolve on `exit`, drain-close grace, `killProcessTree`
   on trigger, `clearTimeout`, accurate message; `spawnCommand` passes the effective bound.
2. `@codent/node`: `native-run` — surface the guard reason alongside real stderr, `exitCode: -1`,
   keep partial output.
3. `@codent/core`: `run_command` — apply the configurable default deadline when the caller omits
   `timeout`; document it.
4. Add `validate:run-command-safety-guard` and wire it into the suite.
5. Build / lint / typecheck / validators.

Rollback is per-step; the wire contract is unchanged.

## Open Questions

- The exact default value and its source (`RUN_COMMAND_TIMEOUT_MS` env vs `toolConfig`).
- Whether a guard trigger should also emit a distinct telemetry/marker so the UI can label it as a
  safety kill rather than a plain non-zero exit.
