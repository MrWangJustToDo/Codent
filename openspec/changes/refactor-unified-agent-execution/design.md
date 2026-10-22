## Context

`@codent/core` has two execution orchestrators today:

- the interactive root path (`AgentChatController`) with queueing, approvals, plan/todo, persistence, and compaction;
- the worker path (`runSubagent` + `task`) with a fresh context, a read-only tool profile, `begin_summary`, task phase, progress-summary fallback, and a summary result.

They already share `ManagedAgent`, `runAgentOnce`, `AgentRunner`, tool factories, `AgentEventBus`, usage tracking, and `AgentLog`. The duplication is in the **outer lifecycle**: prepare, abort/finalize, result projection, persistence policy, approval routing, and UI bridging. Adding general (writable) agents or background work by extending `runSubagent` would duplicate those concerns a third time.

The existing contracts that must survive:

- `task` defaults to a read-only exploration agent and returns summary + `reachedLimit` / `incomplete` / `aborted` flags;
- `task-concurrency` (pre-fork cap, queued runs, abortable pre-forks);
- `run-abort-ownership` (one run controller, parent → child cancellation, task-first cancellation);
- `agent-event-bus` scoping and envelope;
- `agent-log-timeline` / `log-extension` (one JSONL entry schema, session-boundary markers, per-agent files, non-fatal writes);
- `AgentSession` remains the host-facing API; no host should need `ManagedAgent` internals.

## Goals / Non-Goals

**Goals:**

- One shared managed span and one base `AgentStatus` state machine for root, general, explore, and internal agents.
- Profiles select tools, system prompt, approvals, persistence, compaction, budgets, model, and result projection.
- `task` becomes a thin adapter over a child agent; existing explore behavior and output remain the compatibility baseline.
- General (writable) agents use the same lifecycle and parent approval policy, without creating a second state controller.
- Task phase becomes a projection over the shared outcome, not a second phase machine.
- `bridgeUI` disappears; a non-`internal` child with a parent task id is projected into the parent task row. Every agent keeps its durable UI channel.
- Logging uses one schema and one sink mechanism; profile controls level/retention/visibility only.
- Existing concurrency, abort, event, and log contracts are enforced through the unified path.

**Non-Goals:**

- Independent, resumable child sessions (general/explore remain child `ManagedAgent`s under the root session in this change).
- Background task execution and cross-process job recovery.
- Changing the default read-only behavior of `task`.
- Per-profile log formats, per-profile event buses, or per-profile result contracts.
- Replacing `AgentSession` with a new public host API.

## Decisions

### 1. One managed span, not a new layer

Do **not** add an execution layer. Put the shared piece in `agent/run/managed-span.ts`:

- it calls `runAgentOnce` once per managed span;
- it attaches/reuses the durable `AgentUIChannel`;
- it normalizes abort, stream error and the root-only empty-stream guard;
- it exposes `onAbort` / `onError` / `onEmpty` callbacks for the owner.

The owners stay explicit:

- `AgentChatController` is the root conversation pump (queueing, approvals, deciding when to start the next span);
- `runSubagent` is the child task adapter (spawn, task phase, task result projection);
- `RunCoordinator` owns the abort controller; `RunFinalizer` applies the terminal outcome.

`runAgentOnce` remains the lower-level stream consumer. The helper does not own task phase, progress summary, or finalization policy. Root and child differ in their caller and projection, not in a second stream implementation.

Alternative considered: add a top-level `execution/` layer with profiles/ports. Rejected: it moved the same logic into more files, added concepts, and did not reduce the root/child boundary. The actual duplication was the stream/abort/error span, which a helper handles without a layer.

### 2. Base status stays one vocabulary; task phase is a projection

All agents use the existing `AgentStatus` (`idle`, `running`, `thinking`, `responding`, `compacting`, `waiting`, `awaiting_user`, `completed`, `error`, `aborted`).

Task UI gets a separate projection:

```ts
type TaskPhase = "running" | "summary" | "limit";
type TaskActionState = "requires_action" | null;
```

`TaskPhase` is derived/updated by the task projector from the shared run events; it is not a second status machine and does not replace `AgentStatus`. General approvals use `TaskActionState = "requires_action"` (with the base `AgentStatus` remaining `waiting`/`awaiting_user`); explore normally has `null`. `run-stats` and progress-summary remain explore result logic, not shared-span state.

Alternative considered: make `taskPhase` part of `AgentStatus`. Rejected: it would leak task-only states into root/general agents and make the status vocabulary profile-dependent.

### 3. Profiles differ by capability, not lifecycle

| Capability | root | general | explore | internal |
|---|---|---|---|---|
| Exposure | host | defined, not exposed through `task` in this change | task default | internal callers |
| Tools | full + plan/todo/task | broad, minus `ask_user`/plan/todo/`task` by default | read-only + begin_summary | caller-supplied, often `{}` |
| Approvals | interactive root policy | deferred until exposure | deny/auto | deny |
| Persistence | root session store | deferred until exposure | none | none |
| Compaction | root config | deferred until exposure | disabled by default | caller config |
| Plan/todo | enabled | deferred until exposure | disabled | disabled |
| Context | root bootstrap | fresh child | fresh child | caller-supplied / initial messages |
| UI projection | — (root chat) | deferred | task-row | none |
| Result projection | chat | deferred | task summary + flags | internal result |

`general` is an agent-kind definition for the shared span, but **`task` does not expose it in this change**. It stays unreachable until a follow-up adds host/config/permission opt-in and child-approval routing. When exposed, it will be a child `ManagedAgent` under the root, not a second session; `ask_user`, plan/todo, and `task` remain excluded by default, and writes share `file-mutation-queue`.

**General approval (future):** a general child approval must become `TaskActionState = "requires_action"` on the parent task projection and be answerable through the parent `AgentSession` snapshot. A host that cannot route it must deny/abort with a typed reason; it must never silently approve. This is designed here but not implemented in this change.

Alternative considered: give general the complete root `AgentChatController`. Rejected: that would introduce a second UI/approval pump and make parent task waits deadlock-prone. The shared span + parent approval projection is smaller and keeps one lifecycle.

### 4. `task` is an adapter, not a runner

`task` keeps its current public shape; this change does **not** add an `agent` input:

```ts
{
  prompt: string;
  description?: string;
}
```

Its execution becomes:

1. select the `explore` profile;
2. spawn/reuse a child `ManagedAgent` through the manager;
3. start the shared managed span with the explore task projection;
4. return the existing `TaskOutput` (summary, flags, usage, cached output).

`begin_summary`, progress-summary fallback, task phase/action state, and task-row streaming remain **explore task projection** concerns. `TaskOutput.profile` is UI-only metadata by default; it is not part of the model-visible output unless a caller explicitly opts in. General will reuse the same `TaskOutput` shape when a later change exposes it.

### 4b. Internal workers keep their one-shot options

The current subagent call sites outside `task-tool.ts` must not be forgotten:

- `task-prefork-middleware` starts and joins task children; it must resolve the same profile adapter and produce the same `TaskOutput` projection.
- `progress-summary` recursively invokes `runSubagent`; it must use the `internal` profile with no task row and no recursive progress fallback.
- `auto-compact` uses `runSubagent` with `tools: {}`, initial messages, and compact summary streaming; it must use the `internal` profile.
- Memory extraction/retrieval **does not enter this kernel**: it stays on `runSideTextQuery` and the `internal-structured-query` contract. The internal profile is for one-shot agent-loop work such as compaction/progress-summary, not structured side queries.

The internal caller therefore carries `initialMessages`, caller-supplied tools (including `{}`), `compactSummaryStream`, `aggregateUsageToParent`, `autoDestroy`, and `maxOutputLength` in addition to the common kernel fields. These options are profile inputs, not a second runner.

### 5. `bridgeUI` is gone; task-row projection is derived

The UI channel remains mandatory for every run (durable message source of truth). There is no
separate projection policy: a non-`internal` child with a `parentTaskToolCallId` projects into the
parent task row; an `internal` worker, or a child without a task id, keeps its channel internal.

This is a projection choice, not state control. A child can be projected to a task row without
changing its lifecycle. The complete child panel (`Ctrl+T`) is a separate view over the same child
channel, not another projection value. A future general child can use the same panel without adding
a second state machine.

**Identity in this change:** every child is a `ManagedAgent` under the root session. The sink binding names the root session and the child file names the agent id; `scope` only adds the non-derivable profile/task metadata. There is no independent child session id. If a later change introduces independent child sessions, it may add `childSessionId` to the sink binding without changing the per-entry scope.

### 6. Construction keeps root/child boundaries explicit

Keep the root/child lifecycle branches that express real ownership differences (bootstrap,
session store, compaction, todo), and select the toolset through `toolsetProfile`:

- root: full toolset + bootstrap/session/compaction/todo;
- explore: read-only toolset, no bootstrap/session/compaction/todo;
- internal: caller-supplied tools, no UI projection;
- general: broad toolset, defined but not exposed.

This is configuration at the constructor, not a second lifecycle.

The manager still owns parent/child linking and lifecycle. `spawnSubagent` accepts a toolset/profile id; `runSubagent` is the explore task adapter. General reuses the same adapter when a later change exposes it.

Model selection stays session-owned: a child uses the parent's already-resolved model unless its profile explicitly overrides it. The profile may choose a model, but the selected model is recorded on the child session/agent identity, not on a profile-global singleton.

Child agents MUST NOT create a session file or acquire session ownership; they remain in-memory `ManagedAgent`s under the root. This is an explicit invariant, not an incidental effect of the current factory branch.

### 7. Parent-child lifecycle is one contract

- One `RunCoordinator`/abort controller per managed run, including child runs.
- Parent abort cascades to running children; task-first cancellation semantics from `run-abort-ownership` remain.
- `task-concurrency` admission still applies to all `task` profiles; queued runs do not start or emit start events until admitted.
- When a later change exposes general, a general child that requests approval enters base `waiting` plus task projection `TaskActionState = "requires_action"`; the parent task remains pending. The child's pending approval must be exposed to the parent `AgentSession` snapshot (not just a boolean on the child) so the host can answer it. If the host cannot route the request, the child is denied/aborted with a typed reason; it never hangs forever.
- Child destroy flushes its log and releases its sink; parent destroy cascades.
- Depth is enforced at the profile/tool boundary; default maximum is one child level.
- `task-prefork-middleware` keeps its existing eager start/join behavior; only the underlying child start changes to the profile adapter.

### 8. Logging: one schema, scoped entries, per-agent files

Keep the current layering:

- `AgentEventBus` = runtime event transport;
- `AgentLog` = per-agent emission/bounded pending buffer;
- log extension = policy, formatting, JSONL sink, rotation, flush;
- UI projection = display only, never a log source.

Add a required `scope` to every persisted entry. Keep only the non-derivable fields; the root session and agent identity come from the sink binding and file path:

```ts
scope: {
  profile: "root" | "general" | "explore" | "internal";
  taskCallId?: string;
};
```

The child file path is `<rootSessionId>/<agentId>.log`; the log sink carries the root session and agent id, so duplicating them in every entry is unnecessary.

File layout stays compatible with the existing log extension contract:

```text
.agents/logs/<rootSessionId>/
  agent.log                 # root timeline
  <agentId>.log             # general / explore / internal child timeline
```

The child file is the authoritative child timeline: lifecycle, LLM, tool, and task entries are written there once. The parent log receives only explicit **index-only** child lifecycle/link records (created/started/phase/completed/stopped + child log path), marked `data.indexOnly: true`, including the `subagent:completed` statistics required by `agent-log-timeline` (`iterations`, `durationMs`, `usage`). An index-only copy of a lifecycle event is intentional; child LLM/tool entries are never copied into the parent log.

`bridgeUI`/task-row projection has no effect on logging. Task phase, task action state, and base status are logged as separate fields/events. This change does not preserve compatibility with old log entries or old event names; new readers only need the scoped schema. The log extension remains the only wildcard consumer and the sink/flush/rotation contracts stay in force.

Alternative considered: merge all agents into one root `agent.log`. Rejected: concurrent children interleave, attribution becomes filename/ID guesswork, and one child's log volume can rotate away the root timeline.

### 9. Migration without a permanent dual path

1. Add the shared managed-span helper and route **root** through it while preserving current behavior.
2. Route **explore** through the helper; keep `runSubagent` as a task adapter and make all task behavior identical.
3. Keep `task-prefork-middleware`, `progress-summary`, and `auto-compact` on the task/internal toolset ids; no new runner.
4. Define the **general** toolset id but keep it unreachable through `task`; its host opt-in and approval routing are a follow-up.
5. Move shared abort/error scope to the helper; keep finalization in `RunFinalizer` and delete duplicate catch branches.
6. Update app/ACP projections to consume the same status/outcome/log scope, including the complete child panel.
7. Remove the legacy `runSubagent` runner once validators assert parity.

A temporary feature flag may gate the helper during migration, but it must be removed before this change is archived.

## Risks / Trade-offs

- **General approval routing can deadlock the parent task** → define `requires_action` on the task projection, a typed host capability, and a default-deny/timeout path; general is unavailable when routing is absent.
- **Root and task behavior diverges during migration** → run existing `task-concurrency`, `run-abort-ownership`, task output, and log validators against both paths until the old path is removed.
- **Managed-span helper grows into a god object** → keep the helper to stream/abort/error only; tools, compaction, usage, events, log, and result projection remain injected services.
- **Task phase and base status drift** → derive task phase only from run events/outcome; validators assert task phase never appears in root/general snapshots.
- **Child log volume or fan-out** → per-agent files, parent index only, profile-level levels, existing rotation/flush.
- **General writes files while root is editing** → profile policy excludes `task`, uses the same workspace/approval policy, and reports conflicting edits through existing tool results; no shared mutable context.
- **Persistent child sessions are tempting but out of scope** → keep child lifetime under the root; design the session ID/scope fields so persistence can be added later without changing log schema.
- **Event duplication** → the log extension remains the only wildcard consumer; parent lifecycle index is written from explicit lifecycle events, not by re-projecting child entries.
- **General approval policy is still binary** → `command-approval-policy` currently distinguishes only `root | subagent`; when general is exposed, that decision must become profile-aware and route approval to the parent instead of falling into the subagent deny branch.

## Open Questions

- When general is exposed later, should its approval timeout default to deny or abort the task? This change specifies a typed default-deny path; the exact timeout remains host policy.
- Does `TaskOutput.profile` need a model-visible opt-in for a future non-task caller, or can it stay UI-only permanently? This change keeps it UI-only.
- Should a future independent child session reuse the same child panel or add a distinct view? This change treats the panel as a view over a root-owned child.
