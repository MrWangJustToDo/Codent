## Why

`@codent/core` already shares `RunFinalizer`, `RunCoordinator`, abort ownership, `ManagedAgent`, `runAgentOnce`, tool factories, the event bus, usage, and logging between root and subagent runs. The remaining duplication is narrower but structural:

1. construction-time `parentId ? ... : ...` branches (`agent-factory.ts`);
2. result projection (`run-stats.ts`, `progress-summary.ts`, `subagentResultToTaskOutput`);
3. UI bridging (`bridgeUI`, `summaryHub`, `parentTaskToolCallId` conditionals);
4. child log-sink binding (`attachSink` in `spawnSubagent`).

Every new profile/background/resumable capability otherwise adds another branch to those four seams. This change shares the **managed run span** and keeps agent kind/toolset as configuration; the task adapter and projections become thinner, and `AgentChatController` remains the root conversation pump.

This change unifies the shared managed-run span at the core level: root and child runs use one stream/abort/error helper and one base state machine; agent kind/toolset decides capabilities, while root queueing and child task projection stay explicit. The existing `task` contract (read-only explore only, summary + status flags) remains the compatibility baseline.

## What Changes

- Keep `root` / `general` / `explore` / `internal` as agent-kind/toolset ids, not as a second execution loop.
- Introduce `agent/run/managed-span.ts`, a helper (not a layer) that owns the stream call plus shared abort/error/empty-stream normalization. `AgentChatController` remains the root conversation pump; `runSubagent` remains the child task adapter. Both call the helper; `runAgentOnce` remains the lower-level stream consumer.
- Make `task` a thin child-agent adapter over the same managed span:
  - `explore` is the only task profile exposed in this change and preserves the existing read-only tools, `begin_summary`, summary/status flags, progress-summary fallback, and task-row UX.
  - `general` is defined as a profile for the unified kernel but SHALL NOT be exposed through `task` yet. It remains unreachable until a follow-up adds a host/config/permission opt-in and child-approval routing.
  - A task outcome is projected from the shared run outcome, not produced by a second runner.
- Replace the `bridgeUI` boolean with an explicit rule: a non-`internal` child with a parent task id streams into the parent task row; every agent still has its durable UI channel. A child in this change has an `agentId` under the root session, not an independent child session.
- Provide the complete child panel/navigation for a projected child, rather than only a task-row link. The panel is a view over the child `ManagedAgent`; it is not a second session.
- Do not preserve old event/log schemas or old log entries. Event and log contracts may break in this change; new consumers only need the target schema. No compatibility shim is required.
- Unify state and events:
  - Base `AgentStatus` transitions are shared by all profiles.
  - Task phase (`running` / `summary` / `limit`) is a task projection, not a second state machine. A future general profile may add a task action state when it is exposed.
  - Parent abort/destroy, depth limits, concurrency admission, and child cancellation follow one parent-child contract.
- Unify logging:
  - One `LogEntry` schema for every profile, with a required scope carrying `profile` and optional `taskCallId`; root/agent identity comes from the sink path.
  - Root log at `.agents/logs/<rootSessionId>/agent.log`; child agents write independent per-agent files under the same root log directory; the parent log records explicit index-only lifecycle links (`data.indexOnly: true`) and does not duplicate child content.
  - Profile changes log level/retention/visibility, never the schema or sink mechanism.
- Parameterize agent construction by profile: bootstrap, session persistence, compaction, todo/plan availability, extensions, and approval policy are profile capabilities instead of `parentId ? root : child` hard branches.
- Mark internal module moves/renames as **BREAKING** (internal-only): `runSubagent` stops being an independent runner and becomes an explore task adapter; the shared span lives in `agent/run/`; general remains deferred.
- Preserve current external `task` output shape; `profile` is UI-only metadata. Existing persisted task results remain readable; old logs/events are not part of the compatibility target.

## Capabilities

### New Capabilities

- `unified-agent-execution`: one managed span, base state machine, agent-kind/toolset configuration, task adapter, parent-child lifecycle, UI projection, and scoped logging for root/general/explore/internal agents.

### Modified Capabilities

- `log-extension`: the persisted entry schema adds the required `scope` object and the parent-log `data.indexOnly` marker; old pre-scope entries/events are not required to remain readable.

## Impact

- Affected code:
  - `packages/core/src/agent/run/managed-span.ts` — shared stream/abort/error helper
  - `packages/core/src/agent/run/run-agent-skeleton.ts` — promoted to the shared run path
  - `packages/core/src/agent/subagent/` — `run-subagent.ts` becomes a thin profile adapter; task phase/progress summary remain explore projections
  - `packages/core/src/managers/agent-factory.ts`, `toolset-factory.ts`, `agent-manager.ts`, `managed-agent.ts` — toolset/profile-id construction and lifecycle
  - `packages/core/src/managers/controllers/agent-chat-controller.ts` — root conversation pump invokes the shared managed span; interactive policy remains root-only
  - `packages/core/src/managers/middleware/task-prefork-middleware.ts` — prefork start/join uses the task profile adapter and keeps admission semantics
  - `packages/core/src/agent/subagent/progress-summary.ts` and `agent/compaction/auto-compact.ts` — their internal worker calls use the internal profile, never recursively spawn an explore task
  - `packages/core/src/agent-session/` — scoped child identity and complete child panel (Ctrl+T); general approval projection is deferred with general exposure
  - `packages/core/src/agent/log/` — scope-aware log resolution and parent lifecycle index
  - `packages/core/src/agent/tools/util/file-mutation-queue.ts` — general writes share the root workspace mutation queue
  - `packages/app` / `@codent/acp` — consume the same status/task/log projections and the complete child panel; general child approvals are deferred with general exposure
- Affected APIs:
  - `task` input remains explore-only in this change; no `agent: "general"` exposure yet
  - `TaskOutput.profile` is UI-only metadata by default; it is not part of the model-visible output unless a caller explicitly opts in
  - internal `runSubagent`/subagent config changes are **BREAKING** for core-internal callers
  - `AgentSession.getSummaryStreamSnapshot` / `listSummaryStreamSnapshots` are renamed to
    `getAgentStreamSnapshot` / `listAgentStreamSnapshots`; this is **BREAKING** for external
    `AgentSession` implementers (the local and HTTP hosts are updated together)
  - no new public host runtime is required; `AgentSession` remains the host-facing contract
- Affected specs:
  - new `unified-agent-execution`
  - existing `task-concurrency`, `run-abort-ownership`, `agent-event-bus`, `agent-lifecycle-events`, and `agent-log-timeline` remain in force; `log-extension` gets an explicit delta for the scoped schema
  - `session-http-parity` gets the AgentStream snapshot rename in the current spec
- Out of scope for this change:
  - exposing `general` through `task`; its host opt-in and child-approval routing are a follow-up
  - independent, resumable child sessions (every child remains a `ManagedAgent` under the root session)
  - background task execution and cross-process job recovery
  - changing the default read-only behavior of `task`
  - backward compatibility for old event/log schemas or log entries
