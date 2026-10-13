## 1. CoreEnv safety guard (`@codent/node`)

- [x] 1.1 `shell.ts` — `waitForChildProcess`: judge completion on the child's **exit** event, then allow a short bounded drain grace (`DRAIN_GRACE_MS`) for `close` to capture trailing output; `clearTimeout` the guard + drain timers on every settle path.
- [x] 1.2 `shell.ts` — on guard trigger: kill the **process tree** via `killProcessTree(pid, "SIGKILL")`, and reject with an accurate reason naming the effective bound (drop the unverified "detached descendant" cause).
- [x] 1.3 `shell.ts` — `spawnCommand`: the caller timeout path stays primary (kills the tree, throws `timeout:`); the guard bound is `max(MIN_SAFETY_TIMEOUT_MS, timeout*1000 + margin)` only as a backstop, and fires only while the process has not exited.
- [x] 1.4 `native-run.ts` — factor the failure mapping into `resolveRunFailure`: preserve partial `stdout` and the real `stderr`, surface the guard reason **alongside** stderr (never `stderr || reason`), return `exitCode: -1` for a safety kill; keep the `aborted` / `timeout:` rethrow.
- [x] 1.5 Build `@codent/node` + `tsc --noEmit`.

## 2. run_command effective deadline (`@codent/core`)

- [x] 2.1 `run-command-tool.ts` — apply a configurable default `timeout` when the caller omits one (`DEFAULT_RUN_COMMAND_TIMEOUT_MS = 300_000`); the caller's `timeout` still overrides.
- [x] 2.2 Source the default from the runtime env (`RUN_COMMAND_TIMEOUT_MS` via `coreEnv.getEnv()`, clamped to >= 1000ms), falling back to the constant; documented in the tool `description` and the `timeout` field.
- [x] 2.3 (optional) — resolved without a schema change: a safety kill is already distinguishable by `exitCode: -1` plus a reason naming the bound; no new marker field was added.
- [x] 2.4 Build `@codent/core` + `tsc --noEmit`.
- [x] 2.5 `run-command-tool` — catch the typed timeout at the tool layer and return a normal result carrying the partial stdout/stderr + a timeout notice (`timedOut: true`, `exitCode: -1`, `success: false`), symmetric with the cancel branch — the spec's "Partial output survives" (since `ExecutionError` deliberately carries no output). Memoize `RUN_COMMAND_TIMEOUT_MS` per tool instance so `--remote-env` does not pay a `getEnv()` round-trip per command.

## 3. Validator (zero coverage today)

- [x] 3.1 Add `packages/node/scripts/validate-run-command-safety-guard.mjs` (+ `validate:run-command-safety-guard` in `packages/node/package.json`).
- [x] 3.2 Assert the guard contract: a child still running past a short bound is killed with a reason naming the bound and no unverified cause; a child that **exits** while a descendant holds the pipe is NOT a safety kill (settles by the drain grace with its real code); a safety kill keeps partial stdout, reports `-1`, and keeps the reason alongside the command's own stderr; no guard timer remains pending after a normal completion.
- [x] 3.3 Factor the `native-run` guard mapping into the exported `resolveRunFailure` so it is directly testable (a 30s end-to-end command would be needed otherwise).
- [x] 3.4 Confirm the glob-discovered runner picks it up (`node scripts/run-all-validators.mjs --dir packages/node` → 5/0).
- [x] 3.5 Add `validate:command-deadline` (core): the default deadline is injected into `runCommand` when the caller omits `timeout`; `RUN_COMMAND_TIMEOUT_MS` overrides it and a sub-1000 / non-numeric / unreadable value clamps to the default; `isCommandTimeoutError` classifies a typed timeout (local + remote shape); and a deadline-killed command returns its partial output instead of throwing it away.

## 4. Verification

- [x] 4.1 `pnpm build` / `pnpm lint` / `pnpm typecheck` clean.
- [x] 4.2 Node (5/0) + core (181/0/2) validator suites green.
- [x] 4.3 `openspec validate fix-run-command-safety-guard --strict` passes.
- [x] 4.4 `pnpm --filter @codent/app run validate:render-smoke` passes (it had gone unrun since `d5ff664d`).
