## 1. Baseline and Contracts

- [x] 1.1 Inventory the current root (`AgentChatController`) and worker (`runSubagent`) lifecycles, listing every shared and duplicated concern (prepare, abort, finalize, usage, result, persistence, approvals, UI, log).
- [x] 1.2 Add `packages/core/scripts/validate-unified-agent-execution.mjs` with assertions for one managed span, a structural single-call-site check, toolset selection, task parity, task-phase projection, and scoped logs.
- [x] 1.3 Add `packages/core/src/agent/run/managed-span.ts` as a shared helper (not a layer) for the stream call plus abort/error/empty-stream normalization; do not add a top-level execution layer.
- [x] 1.4 Define the `root`, `general`, `explore`, and `internal` toolset/profile ids and their tool/UI/log attribution; keep root/child persistence and bootstrap boundaries explicit.

## 2. Unified Execution Kernel

- [x] 2.1 Extract the shared stream → abort/error/empty-stream span into `agent/run/managed-span.ts`, reusing `runAgentOnce`. Keep `AgentChatController` as the root conversation pump and `RunFinalizer` as the outcome owner.
- [x] 2.2 Route the root path through `runManagedSpan` without changing root status, chat finalization, queueing, or approval behavior; document the controller/helper boundary.
- [x] 2.3 Route explore through `runManagedSpan` while preserving current task behavior and output.
- [x] 2.4 Route internal workers (compaction/progress-summary) through the internal profile with the caller-supplied one-shot options; memory stays on `runSideTextQuery`.
- [x] 2.5 Remove the duplicated subagent catch/abort/finalization branches once the shared span passes parity checks.
- [x] 2.6 Add a temporary feature flag only if needed for staged rollout; document its removal as a release blocker.
- [x] 2.7 Keep the layer table unchanged (no new layer); update `core-code-organization`/AGENTS docs to point at `agent/run/managed-span.ts`.

## 3. Profile-Aware Construction

- [x] 3.1 Keep only the real root/child lifecycle branches (bootstrap, session store, compaction, todo) and select the toolset through `toolsetProfile`; do not introduce a profile object layer.
- [x] 3.2 Generalize `toolset-factory` to select root/general/explore/internal tool profiles without constructing unwanted tools first.
- [x] 3.3 Make the general profile opt into broad tools/extensions while excluding `ask_user`, plan/todo, and `task` by default; require host/config/permission opt-in beyond a model-supplied `task.agent`.
- [x] 3.4 Keep the explore profile read-only, extension-free, and without persistence/compaction unless explicitly configured; add the internal profile's `tools:{}`/`initialMessages`/`compactSummaryStream`/`aggregateUsageToParent`/`autoDestroy`/`maxOutputLength` options.
- [x] 3.5 Keep `task` out of the explore/internal/general toolsets so a child cannot recurse by default.
- [x] 3.6 Keep memory/skills/MCP/LSP/code-mode on root bootstrap; child construction skips them explicitly rather than via a second runner.
- [x] 3.7 Route general writes through `file-mutation-queue` so they serialize with root writes on the same path.
- [x] 3.8 Record model inheritance explicitly: child model = parent resolved model unless the profile overrides it; the selected model belongs to the child identity/session, not a profile-global singleton.

## 4. Task Adapter and Profiles

- [x] 4.1 Keep the `task` input explore-only (no `agent: "general"` exposure); document general as a deferred profile.
- [x] 4.2 Keep `runSubagent` as a task adapter over spawn + `runManagedSpan`; task result projection lives in `task-result.ts`.
- [x] 4.3 Preserve `TaskOutput` fields and existing persisted results; keep `profile` as UI-only metadata.
- [x] 4.4 Keep `begin_summary`, task phase, progress-summary fallback, and task-row streaming as explore/task projections; make progress-summary use the internal profile and never recurse.
- [x] 4.5 Update `task-prefork-middleware.ts` to start/join the same profile adapter and preserve the existing `TaskOutput` mirror.
- [x] 4.6 Update `auto-compact.ts` and other one-shot internal agent callers to use the internal toolset with their one-shot options; leave memory extraction/retrieval on `runSideTextQuery`.
- [x] 4.7 Define the general profile but leave it unreachable through `task`; its host opt-in/approval routing is a follow-up.

## 5. State, Events, and UI Projection

- [x] 5.1 Keep one base `AgentStatus` vocabulary for every profile; do not add task-only states to it.
- [x] 5.2 Derive `TaskPhase` (`running` / `summary` / `limit`) from shared run events/outcome in the explore/task projection only.
- [x] 5.3 Remove `bridgeUI`; derive task-row projection from a non-`internal` profile plus a parent task id, keep the durable UI channel for every profile, and keep child identity as `rootSessionId + agentId` (no independent child session in this change).
- [x] 5.4 Update app task rows to open a complete child panel/navigation with transcript, status, tools, and cancel; no task-row-link-only surface.
- [x] 5.5 Update ACP child projection to consume the same base status/outcome and complete child panel without adding a second lifecycle.
- [x] 5.6 Assert that task-row projection does not alter status transitions, cancellation, finalization, or logging.

## 6. Scoped Logging

- [x] 6.1 Add the required log scope (`profile`, optional `taskCallId`) to the persisted entry schema and `AgentLog` context; keep root session/agent identity in the sink binding and file path rather than duplicating it per entry. Update `logEntrySchema`, not just the TypeScript interface, so scope is not stripped.
- [x] 6.2 Keep the root `agent.log` and per-agent child files in the root session log directory; ensure each child entry is written once to its own file.
- [x] 6.3 Make the parent log record only index-only child lifecycle/link entries (`data.indexOnly: true`, created/started/phase/completed/stopped + child log path), including completion statistics, never child LLM/tool entries. The child file remains the authoritative full timeline.
- [x] 6.4 Apply profile-specific log level/retention policy without changing schema, sink, rotation, redaction, or flush behavior.
- [x] 6.5 Ensure child pending buffers flush before sink release, parent destroy cascades, and a log write failure remains non-fatal.
- [x] 6.6 Add validators for scope attribution, parent-index-only behavior, per-agent files, resume append, and flush on destroy; do not add legacy-entry compatibility tests.

## 7. Lifecycle, Concurrency, and Cancellation

- [x] 7.1 Preserve one `RunCoordinator`-owned abort controller per managed run, including general/explore/internal children.
- [x] 7.2 Preserve parent abort/destroy cascading and task-first cancellation semantics from `run-abort-ownership`.
- [x] 7.3 Preserve `task-concurrency` prefork admission, FIFO queueing, “no start before admission,” and abortability for the explore task profile.
- [x] 7.4 Define and test the complete child panel's cancel/status behavior; general approval/action state remains a follow-up with general exposure.
- [x] 7.5 Verify child cleanup on spawn failure, approval timeout, parent destroy, and process teardown.
- [x] 7.6 Assert `persistence: "none"` children create no session file and acquire no session ownership.

## 8. Validation, Compatibility, and Cleanup

- [x] 8.1 Run existing validators: `validate:task-prefork`, `validate:task-queue`, `validate:task-run-state`, `validate:run-abort-ownership`, `validate:agent-event-bus`, `validate:agent-log-timeline`, `validate:agent-log-file-sink`, `validate:event-log-bridge`, `validate:agent-session-host`, and `validate:local-agent-session`.
- [x] 8.2 Add the new `validate:unified-agent-execution` to the core validation chain and CI coverage.
- [x] 8.3 Add a local (not CI) app render-smoke assertion for task-row to complete child panel navigation, including transcript, status, tools, and cancel.
- [x] 8.4 Add an ACP subagent projection assertion for the same base status and task phase.
- [x] 8.5 Verify the default `task` remains read-only, non-recursive, and output-compatible after removing the legacy runner.
- [x] 8.6 Remove the unused execution/profile layer and duplicate catch/finalize code; keep the shared helper and task adapter.
- [x] 8.7 Update `AGENTS.md`, `packages/core/ARCHITECTURE.md`, and the affected specs to describe the shared managed span and scoped log.
- [x] 8.8 Run format, lint, typecheck, core validators, app tests, render smoke, and codent self-contained checks before archiving.
