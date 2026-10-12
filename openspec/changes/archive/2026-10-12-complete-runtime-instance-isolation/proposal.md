# Change: Complete runtime-instance isolation

## Why

`add-agent-runtime-instances` made the agent runtime instantiable (`CodentAgent` + internal
`AgentRuntime`), but a five-dimension audit found the isolation is incomplete: several run-path
modules still read the process-global `getEnv()`, the env guard that was supposed to prevent exactly
that has blind spots that hid them, and the structure/validators/docs drifted from the new planes.
A single-runtime host hides all of it because ambient == runtime; a second runtime in the same
process does not.

## What Changes

- **Run-path env wiring.** Thread the runtime env into the remaining ambient readers so a second
  runtime works: project instructions (`agent/prompt/*`), the plan store (`agent/plan/plan-store.ts`),
  the JSONL session log sink (`agent/log/jsonl-file-sink.ts`), extension + default-skill discovery
  (`agent/extension/paths.ts`, `extension/loader.ts`, `managers/agent-manager.ts`), turn-context
  re-injection (`agent/turn-context/*`), models-config paths (`models/config/models-config.ts`),
  memory budgeting, and side-query usage history.
- **Guard hardening.** `validate:runtime-env-guard` SHALL scan the whole run path (not five
  directories), SHALL treat only an explicit fallback (`?? getEnv()`, default parameter) as allowed
  (not a bare `const env = getEnv()`), and its allowlist reasons SHALL be current.
- **Structure.** Break the `models ↔ provider` import cycle, drop the unused `models → runtime` edge,
  make the `managers → runtime` / `runtime → models` etc. edges honest (`type-only` where that is all
  they are), remove the cross-layer `models/index.ts` provider re-export, register `provider`/`runtime`
  in the module-organization doc-path gate, and fix the AGENTS.md file-structure map.
- **Tooling/docs.** Remove the stale multi-session / `Ctrl+X` claims from the root `README.md`, drop
  the dead `ctrlX` keyboard label, and correct stale path comments left by the moves.
- **New coverage.** Add a validator that runs a real managed agent on a second runtime and asserts its
  project instructions load and its plan/log files land under its own root (the guarantee the audit
  found untested).

## Impact

- Affected specs: `agent-runtime-instances`, `core-code-organization`
- Affected code: `packages/core/src/agent/{prompt,turn-context,plan,log,extension,skills,memory}`,
  `packages/core/src/{models,provider,managers}`, `packages/core/scripts/*`, docs (`AGENTS.md`,
  `README.md`, `packages/core/ARCHITECTURE.md`).
