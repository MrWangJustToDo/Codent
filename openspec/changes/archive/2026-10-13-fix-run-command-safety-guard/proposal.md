## Why

`run_command` with no caller `timeout` hits a hard 30s wall inside the `@codent/node` CoreEnv:
`waitForChildProcess` falls back to `MIN_SAFETY_TIMEOUT_MS = 30_000`, rejects, and
`runNativeCommand` converts the rejection into a normal-looking `exitCode: 1` result whose `stderr`
names a cause it never verified — "stdio handles held open by detached descendant".

Log evidence (1374 intact, no-timeout rows across `.agents/logs`): the maximum duration is
30027ms and **every** command that crosses 30s lands in `[30003, 30027]ms` — the wall, not a real
failure, is what users see. The guard conflates two situations and names only one:

- (a) a process **legitimately still running** past the bound (what actually happens), and
- (b) a process that already exited but whose pipe a descendant holds open.

Because the observed failures are all (a), fixing only the exit-vs-close semantics would change the
wording of the message and nothing else — the command still dies at 30s. The default bound is the
one thing that removes the symptom.

## What Changes

- `run_command` SHALL have an effective deadline: a configurable default applied when the caller
  omits `timeout`, so a long command takes the real timeout path (kill the process tree, settle as
  a typed timeout) instead of the misdiagnosed safety wall. The caller `timeout` still overrides.
- The CoreEnv safety guard SHALL become a true last resort:
  - judge the deadline on process **exit** (not stream `close`), with a short drain grace so
    trailing output is still captured;
  - on trigger, kill the **process tree** (not only the shell), preserving partial stdout/stderr;
  - report the effective bound and the fact that the process was still running — it SHALL NOT name
    an unverified "detached descendant";
  - SHALL NOT fabricate an exit code (`-1`, the existing "not finished" value, not `1`).
- A guard reason SHALL NOT be dropped when the command also produced stderr: both the reason and
  the real stderr are surfaced.
- The guard timer SHALL be cleared when the process settles.

## Capabilities

### New Capabilities

- `command-execution`: the foreground command execution contract — the effective deadline
  (default + caller override), the last-resort safety guard, output fidelity (partial stdout/stderr
  preserved), and honest exit-code reporting.

### Modified Capabilities

<!-- none: tool-timeout-contract covers tool-declared deadlines (unchanged); command-jobs covers
     background jobs (unchanged). The foreground CoreEnv execution semantics were unspecified. -->

## Impact

- Affected code: `packages/node/src/environment/shell.ts` (`waitForChildProcess`, `spawnCommand`
  timeout wiring), `packages/node/src/environment/native-run.ts` (guard → result mapping),
  `packages/core/src/agent/tools/run-command-tool.ts` (default deadline) and its tool-config/env
  source, plus run_command rendering/logging.
- New validator: `validate:run-command-safety-guard` — the guard path currently has **zero**
  coverage.
- No wire/API break: `run_command` input/output shape is unchanged; only the value and reporting of
  a deadline-killed command change.
