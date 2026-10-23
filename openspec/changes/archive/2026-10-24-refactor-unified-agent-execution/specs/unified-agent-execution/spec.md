## Purpose

Every agent kind reaches the model through one managed span, so a root turn, a `task` child and an internal one-shot share execution, abort/error normalization and one status vocabulary instead of each keeping its own lifecycle. This capability fixes that boundary — what the shared helper owns, what stays with each pump and adapter, how child runs are projected and logged — and names the host, event and log contracts unification may not change.

## ADDED Requirements

### Requirement: All agent kinds use one managed span

Root, general, explore, and internal agents SHALL use one shared managed span for each stream: LLM/tool execution, abort/error normalization, and the root empty-stream guard. `AgentChatController` SHALL remain the root conversation pump that owns queueing, user input, approval waits, and deciding when to start another run. The task adapter SHALL call the same helper and MUST NOT introduce a second stream implementation or a second base lifecycle.

#### Scenario: Root and task share the run path

- **WHEN** the root agent runs a turn and a `task` child agent runs in the same process
- **THEN** both runs use the same managed-span helper and the same base `AgentStatus` transitions, while the root's queue/approval pump remains outside it

#### Scenario: Root turn contains multiple runs

- **WHEN** a root turn pauses for approval and later resumes
- **THEN** each resumed span is one managed-span call, and the chat pump decides when to start it

#### Scenario: Root waiting is an outcome

- **WHEN** a root run pauses for tool approval or `ask_user`
- **THEN** the shared outcome is `waiting`, not `finished`, and the task projection is not applied

#### Scenario: Internal workers do not bypass the kernel

- **WHEN** compaction or another one-shot agent-loop caller needs an internal agent
- **THEN** it runs as the `internal` profile through the same kernel, with no UI projection

#### Scenario: Single kernel is structurally asserted

- **WHEN** the structural validator inspects the core package
- **THEN** only the managed-span helper calls the run/stream entrypoint, and `runSubagent` no longer calls `runAgentOnce` directly

#### Scenario: Memory remains a structured side query

- **WHEN** memory extraction or retrieval runs
- **THEN** it continues through `runSideTextQuery` and does not enter the agent loop or the internal toolset

### Requirement: Shared managed span is a helper, not a layer

The shared run helper SHALL live in `agent/run/managed-span.ts` and SHALL own only the
`runAgentOnce` call plus abort/error/empty-stream normalization. It MUST NOT become a new top-level
layer, a profile framework, or a second finalizer. `AgentChatController` and `runSubagent` remain the
owners of their respective pumps/adapters and MUST call the helper.

#### Scenario: Root and task use the helper

- **WHEN** the root pump and a task child each execute a stream
- **THEN** both call `agent/run/managed-span.ts`, and no `execution/` layer exists

#### Scenario: Helper does not own task state

- **WHEN** a child run is projected into a task row
- **THEN** task phase, progress summary and result projection remain in the child adapter, not the helper

### Requirement: Profiles select capabilities, not state machines

An agent kind/toolset id SHALL select tools; task-row projection SHALL be derived from the profile plus a parent task id. Root/child construction SHALL keep the real persistence, bootstrap, compaction and todo boundaries explicit. An agent kind MUST NOT select a separate status vocabulary, event bus, log schema, or abort/finalize implementation.

#### Scenario: Explore stays read-only

- **WHEN** the `explore` profile is selected
- **THEN** its toolset is read-only and its approvals require no user interaction

#### Scenario: General profile is defined but not exposed

- **WHEN** a caller inspects or invokes `task` in this change
- **THEN** only the explore profile is available; there is no `task.agent = "general"` input and general is unreachable through the task tool

#### Scenario: General excludes headless-incompatible tools

- **WHEN** the general profile is defined for the unified kernel
- **THEN** `ask_user`, plan/todo tools, and `task` are excluded by default, and a model-supplied profile choice alone cannot authorize it

#### Scenario: Profile does not fork observation

- **WHEN** a general or explore child emits a status/tool/LLM event
- **THEN** the event uses the existing AgentEventBus envelope and scope, not a profile-specific event type

### Requirement: The default task contract is preserved

The `task` tool SHALL remain a child-agent adapter. Its only exposed profile SHALL be `explore`, preserving the read-only toolset, `begin_summary`, task phase, progress-summary fallback, and the existing `TaskOutput` fields (`summary`, `reachedLimit`, `incomplete`, `aborted`, `usage`, `subagentId`). The task projection SHALL carry `TaskPhase` (`running` / `summary` / `limit`). `TaskOutput.profile` is UI-only metadata by default. Additive fields such as `profile` MAY be added.

#### Scenario: Existing task call is unchanged

- **WHEN** a caller invokes `task` with only `prompt` and `description`
- **THEN** it runs the explore profile and returns the existing summary plus status-flag contract

#### Scenario: General is not selectable through task

- **WHEN** a caller tries to select a general task profile
- **THEN** the task surface does not expose that choice in this change

#### Scenario: Task phase is a projection

- **WHEN** an explore child calls `begin_summary` or reaches its step budget
- **THEN** the task projection changes to `summary` or `limit`, while the child's base `AgentStatus` remains the shared vocabulary

### Requirement: Internal workers preserve one-shot options

The internal profile SHALL support the options currently used by non-task callers: caller-supplied tools (including `{}`), `initialMessages`, `compactSummaryStream`, `aggregateUsageToParent`, `autoDestroy`, and `maxOutputLength`. `task-prefork-middleware` SHALL start/join through the same task profile adapter; `progress-summary` and `auto-compact` SHALL use the internal profile and MUST NOT recursively spawn an explore task.

#### Scenario: Progress summary does not recurse

- **WHEN** an explore child is incomplete and the progress-summary fallback runs
- **THEN** the summarizer runs as the internal profile with caller-supplied tools, and it cannot spawn another progress summary

#### Scenario: Prefork uses the same adapter

- **WHEN** a task call is eagerly pre-forked while arguments stream
- **THEN** the prefork starts the same child profile adapter that the task tool later joins, and produces the same `TaskOutput` shape

### Requirement: Parent-child lifecycle is one contract

Every child agent SHALL use the parent's run/abort ownership rules. Parent abort and destroy SHALL cascade to running children; a task-bound child SHALL retain the task-first cancellation semantics; queued child runs SHALL NOT start or emit start events before admission. The profile layer SHALL enforce a maximum child depth and MUST NOT allow unbounded recursive task creation. General child approvals SHALL be projected into the parent `AgentSession` snapshot so the host can answer or reject them; an unsupported host SHALL use a typed default-deny path.

#### Scenario: Parent abort stops a child

- **WHEN** the parent run is aborted while an explore child is running
- **THEN** the child stops through the same run coordinator path and the task settles as aborted with its stop reason

#### Scenario: General cannot recurse by default

- **WHEN** the general profile is defined
- **THEN** the task tool is excluded from its toolset and depth is enforced at the profile boundary

#### Scenario: Queued child is not running

- **WHEN** `task` calls exceed the configured concurrency cap
- **THEN** a queued child does not start and does not emit a started event until admitted

#### Scenario: Child does not acquire session ownership

- **WHEN** an explore or internal child runs with `persistence: "none"`
- **THEN** it creates no session file and acquires no session ownership

### Requirement: UI projection is separate from state

Every agent run SHALL retain a durable UI channel. A non-`internal` child with a `parentTaskToolCallId` SHALL stream into the parent task row; an `internal` child, or a child without a task id, SHALL keep its channel internal. There is no separate projection policy value. The complete child panel is a separate view. A child `ManagedAgent` remains under the root session. Projection MUST NOT change status, cancellation, finalization, logging, or tool behavior.

#### Scenario: Task row does not own state

- **WHEN** an explore child is projected to the parent task row
- **THEN** its run state still comes from the shared status/finalizer, not from the row projection

#### Scenario: Explore child panel is complete

- **WHEN** an explore child is projected as a child panel
- **THEN** the parent task row opens a complete child panel/navigation with transcript, status, tools, and cancel, the child keeps one durable channel, and no independent child session is created

#### Scenario: Internal projection is silent

- **WHEN** an internal worker runs
- **THEN** it does not project into a task row and emits no task/chat UI surface

### Requirement: Logging is one schema with explicit scope

All profiles SHALL write the same `LogEntry` schema through `AgentLog` and the log extension. Every new entry SHALL carry a scope with the non-derivable `profile` and, when applicable, `taskCallId`; root session and agent identity come from the sink binding and the `<rootSessionId>/<agentId>.log` path. Profile policy MAY set levels or retention but MUST NOT change the entry schema, sink mechanism, rotation, redaction, or flush behavior. This change does not preserve compatibility with old log entries or old event names.

#### Scenario: Child entries are attributable

- **WHEN** an explore child writes a tool entry
- **THEN** the entry carries the `explore` profile and its task call id, and is written once to the child's log file under the root session directory

#### Scenario: Parent log is an index

- **WHEN** a child is created, starts, changes task phase, completes, or stops
- **THEN** the parent log receives an index-only lifecycle/link entry with the child id and log path, marked `data.indexOnly: true`, including the existing `subagent:completed` statistics (`iterations`, `durationMs`, `usage`), but not a duplicate of the child's LLM/tool entries

#### Scenario: Same schema for all profiles

- **WHEN** a root, general, explore, and internal entry are compared
- **THEN** they share the same level/category/entry schema, and only the scope and policy values differ

#### Scenario: Bridge projection does not alter logging

- **WHEN** a child is projected to the task row or is an internal worker
- **THEN** its log entries remain identical in schema and destination

### Requirement: Host, event, and log layout contracts remain coherent

The unified path SHALL preserve the `AgentSession` host contract, the AgentEventBus scoping/envelope, the task concurrency rules, and the abort ownership rules. It SHALL use the target log layout `.agents/logs/<rootSessionId>/agent.log` plus per-agent child files in the same root directory. Old event names and old log entries do not need to remain readable.

#### Scenario: Host observes the session API

- **WHEN** a host reads a root or child `AgentSession` snapshot
- **THEN** it receives session identity, status, messages, queues, usage, and subagent summaries without reading the shared helper

#### Scenario: Child log layout

- **WHEN** a child writes its first entry
- **THEN** the root log remains `agent.log` and the child gets an independent file in the same root log directory
