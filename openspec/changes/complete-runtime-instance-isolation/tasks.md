## 1. Guard + run-path env wiring

- [x] 1.1 Harden `validate:runtime-env-guard`: widen `SCAN_DIRS` to the whole run path (`agent/prompt`, `agent/turn-context`, `agent/plan`, `agent/log`, `agent/extension`, `agent/skills`, `agent/memory`, `agent/subagents`, `agent/runner`, `agent/compaction`, `agent/ui` in addition to the current five); treat only `?? getEnv()` / a default parameter as a fallback (drop the bare `=` case); refresh each allowlist reason (drop `command-output-log` once wired).
- [x] 1.2 Thread the runtime env into project-instruction loading (`agent/prompt/agent-doc-loader.ts`, `agent/prompt/instruction-files.ts`, `agent/prompt/default-prompt.ts`) and turn-context re-injection (`agent/turn-context/instruction-context.ts`, `session-retrieval.ts`).
- [x] 1.3 Thread the env into the plan store (`agent/plan/plan-store.ts`), the JSONL log sink (`agent/log/jsonl-file-sink.ts` via `ManagedAgent.bindSessionLogSink`), extension + default-skill discovery (`agent/extension/paths.ts`, `extension/loader.ts`, `managers/agent-manager.ts`), and models-config paths (`models/config/models-config.ts`).
- [x] 1.4 Wire the background-job durable log writer + sweeps to the runtime env (`agent/tools/util/command-output-log.ts`, per-agent `CommandJobRegistry`); drop the stale guard allowlist entries. (Side-query usage via `sharedUsageHistory` stays ambient by design — it has no agent context; recorded on the AgentRunDeps/design inventory.)
- [x] 1.5 Build core + run the full `validate:*` set + `tsc`.

## 2. Structure

- [x] 2.1 Structure: declare the `models ↔ provider` coupling accurately with narrowed edges (`onlySources`/`onlyTargets` + a reason stating the config↔provider cycle) instead of a blanket edge; delete the dead cross-layer provider re-exports in `models/index.ts` (and re-point `src/index.ts` to `./provider`); update `validate-layer-boundaries.mjs` (drop the dead `models → runtime` edge; make `managers → runtime` / `runtime → models` / `runtime → agent` / `agent-session → runtime` `type-only`; correct reasons/paths). The deep config↔provider untangle is deliberately deferred (documented as a known bounded cycle) to avoid a risky move of central model-resolution code.
- [x] 2.2 Add `provider` + `runtime` to `validate-module-organization.mjs` `CORE_TOP_LEVEL`; prune the stale `ROOT_FILE_LAYERS` entries in `validate-layer-boundaries.mjs`.
- [x] 2.3 Fix the AGENTS.md file-structure map (add `runtime/`, remove the dead `agent/run-helpers/`), `ARCHITECTURE.md` §1.4 (add `CodentAgent`), and stale path comments (`synthetic-injection`, `command-job-registry`, `env/lsp`, `validate-plan-tools`).
- [x] 2.4 Build core + run the full `validate:*` set + `tsc`.

## 3. Docs, tooling, and the multi-runtime managed-run validator

- [ ] 3.1 Root `README.md`: remove the multi-session feature row/prose/`Ctrl+X` shortcut; drop the dead `ctrlX` label in `packages/app/src/utils/keyboard-labels.ts`.
- [ ] 3.2 Add a two-runtime managed-run assertion (extend `validate-agent-runtime-instances` or a new validator): create a session on runtime B, run it, and assert its project instructions load and its plan/log files land under B's root.
- [ ] 3.3 Run `pnpm build`, `pnpm lint`, `pnpm typecheck`, the full `validate:*` set, and `openspec validate --strict`.
- [ ] 3.4 Archive the change and sync spec deltas into `openspec/specs/`.
