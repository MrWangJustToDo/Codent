# agent-log-timeline Specification

## Purpose

The Event→Log timeline: how AgentEventBus events become AgentLog entries (level, category, message formatting), what each event maps to, and how a run's entries are scoped and ordered in the on-disk journal.

## Requirements

### Requirement: Log core is persistence-only

The log emission seam SHALL be persistence-only: every accepted entry is handed to the log extension for writing and nothing else. It MUST NOT maintain an unbounded in-memory entries ring or expose query APIs (`getEntries`, `getCount`, `filter`, `recent`, `errors`, `issues`), console output (`toConsole`), or serialization helpers (`toJSON`, `fromJSON`, `toString`).

The seam's role SHALL be the **pre-registration fallback**: it accepts entries only while an agent has no policy-resolvable binding (agent construction, extension activation), and MUST stop being the write path once the agent is registered. `run` scoping MUST NOT be seam state: the run identity travels on the event envelope and is stamped by the policy layer.

The seam MAY retain a bounded pending buffer of entries emitted before the log extension has bound a sink, and MUST drain and discard that buffer at its cap so a session with no bound sink cannot grow memory without bound. Entries retained this way SHALL be written once a sink is bound, and MUST NOT be replayed more than once. Once a sink is bound, entries flow to it directly with no queryable history retained.

#### Scenario: No in-memory accumulation

- **WHEN** a long-running session produces more entries than any fixed buffer size
- **THEN** the log object's memory footprint stays constant (only the pending buffer bounded by its cap and the transient flush buffer grow) and all entries are present in the JSONL file

#### Scenario: Pending buffer is bounded when no sink is bound

- **WHEN** an agent emits entries and no sink is ever bound
- **THEN** the retained pending buffer does not grow past its cap and the process does not accumulate entries without bound

#### Scenario: Entries emitted before the sink is bound are not lost

- **WHEN** entries are emitted during agent construction, before the log extension has bound a sink
- **THEN** those entries appear in the persisted log once the sink is bound, and appear exactly once

#### Scenario: Run identity is not seam state

- **WHEN** a run-scoped event is recorded
- **THEN** the entry's `run` field comes from the event envelope's run identity, and no `setRun`-style mutable seam state is required to produce it

### Requirement: No UI debug log channel

The agent session MUST NOT expose a `log` event channel to clients, and the app layer MUST NOT subscribe to or render log entries: the `use-agent-log` store, `bindSessionLog`, the `Debug` panel, and the `useAgentLog` adapter hook SHALL be removed. Log observability is provided exclusively by the persisted JSONL file.

#### Scenario: Session events contain no log channel
- **WHEN** a client subscribes to session SSE events (all channels)
- **THEN** no `channel: "log"` frames are ever delivered

#### Scenario: Debug panel is gone
- **WHEN** the app UI is rendered
- **THEN** no Debug panel/log view component exists and the adapter hooks type has no `useAgentLog` member

### Requirement: Hook-call echo logging is opt-in only

The middleware instrumentation layer (`instrument-middleware-log.ts`) MUST NOT write `middleware:{name}:{hook}` entries to `AgentLog` by default. Hook-call echoes SHALL only be recorded when explicitly enabled via the `MY_AGENT_LOG_HOOKS` environment flag. Lifecycle and business events MUST NOT depend on this flag.

#### Scenario: Default pipeline produces no hook echoes
- **WHEN** an agent run executes tools and LLM iterations with `MY_AGENT_LOG_HOOKS` unset
- **THEN** the persisted log contains zero entries matching `middleware:{name}:{hook}`

#### Scenario: Debug mode restores hook echoes
- **WHEN** `MY_AGENT_LOG_HOOKS` is set to a truthy value
- **THEN** middleware hook invocations are logged as before (debug level, `hooks` category)

### Requirement: Large tool payloads are summarized, not dumped

The Event→Log bridge MUST NOT inline full `tool_input`, `tool_output`, or approval `tool_input` payloads into log entries. Tool lifecycle and approval entries SHALL carry `inputBytes` / `outputBytes` numeric fields plus a truncated preview of at most 200 characters. Full tool output remains available via the existing tool-output cache path, which MAY be referenced by `outputPath` when present.

#### Scenario: Tool end entry records size and preview
- **WHEN** a `read_file` tool call returns a 40KB file content
- **THEN** the resulting `tool` category log entry contains `outputBytes` equal to the serialized size and a `outputPreview` string no longer than 200 characters, and the full content does not appear in the log entry

#### Scenario: Approval request does not inline input
- **WHEN** an approval is requested for a tool with a large input
- **THEN** the `approval` category entry contains `inputBytes` and a preview, not the full input object

### Requirement: Bootstrap logging is single-sourced

Session bootstrap information (instructions loaded, skills loaded, memory initialized, extensions activated, extension activation failures, session start) SHALL be recorded exactly once per launch: either as `session:*` lifecycle events, or as direct seam calls for facts that have no event, but never both for the same fact.

Bootstrap facts that already have an event MUST be emitted as that event. The seam MAY carry a fact only when no event exists yet, and that path MUST be replaced by an event when one is introduced.

Bootstrap entries emitted before the log extension binds its sink MUST NOT be discarded: the persisted log for a launch MUST contain the activation-failure entries for every extension that failed to activate in that launch.

#### Scenario: One bootstrap does not duplicate skill/memory lines

- **WHEN** a new agent session boots with N skills and M memories
- **THEN** the log contains the `session:skill` / `session:memory` / `session:start` entries and no duplicate direct `system`-category entries for the same facts

#### Scenario: Extension activation failures are visible in the log

- **WHEN** a session boots and one extension fails to activate
- **THEN** the persisted log for that launch contains the activation-failure entry, even though the entry is emitted before the log extension binds its sink

#### Scenario: Bootstrap summary appears once

- **WHEN** a session boots successfully
- **THEN** the persisted log contains at most one aggregated bootstrap summary entry and no per-fact duplicates of the `session:*` entries

### Requirement: Per-turn memory debug streams are silent

Memory prefetch, extraction, and consolidation `start`/`empty`/`skip` outcomes MUST NOT produce log entries at debug level. Memory errors and warnings (warn/error level) SHALL still be logged.

#### Scenario: Turn with no matching memories logs nothing
- **WHEN** a user turn triggers memory prefetch that selects zero memories
- **THEN** no `memory` category entry is written for that turn

### Requirement: LLM timeline entries carry cost and latency metrics

`llm:request` entries SHALL include `model` and `iteration`. `llm:response` entries SHALL include `model`, `iteration`, `inputTokens`, `outputTokens`, `cacheReadTokens`, `cacheWriteTokens`, `reasoningTokens`, `costUsd`, `roundElapsedMs`, `firstTokenMs`, and `finishReason`. Cost is sourced from the existing usage tracker cost accumulation; `firstTokenMs` is measured from LLM request start to the first received stream chunk.

#### Scenario: Response entry enables cost analysis
- **WHEN** an LLM iteration finishes with token usage
- **THEN** the `llm:response` entry allows computing per-call cost (costUsd), generation latency (firstTokenMs, roundElapsedMs), and reasoning share (reasoningTokens) without any other data source

### Requirement: Status transitions are logged

`AgentStatusController` SHALL emit one `agent:status` telemetry event per agent status transition, carrying `from`, `to`, and a trigger hint, so the run's state machine is reconstructable from the event stream alone. The persisted log entry for that event SHALL be produced by the policy table; a transition whose meaning is already carried by a dedicated event (run start/finish/abort, approval request/resolution, compaction) SHALL be suppressed or demoted by policy rather than recorded unconditionally.

A transition that no other event explains SHALL be recorded at `info`; a terminal transition (`error`, `aborted`) SHALL be recorded at `info`; the pump's mechanical bookkeeping transitions SHALL be suppressed by default.

#### Scenario: Run start transition is visible

- **WHEN** the controller moves the agent from `idle` to `running` and later to `responding`
- **THEN** each transition produces an `agent:status` event with `from: "idle", to: "running"` and `from: "running", to: "responding"` respectively. The *event* is the record of the transition; whether an entry is written is policy, and `run-start` / `chunk:*` are suppressed because the run lifecycle and stream events already describe the same movement.

#### Scenario: A pause nobody else records is written

- **WHEN** the agent parks on a client tool (`ask_user`) — a tool that emits no start/end event, with a suppressed projection channel
- **THEN** the `running → awaiting_user` / `awaiting_user → running` transitions are written, because suppressing them left the pause with no record at all

#### Scenario: Mechanical transitions do not duplicate dedicated events

- **WHEN** a run pauses for a tool approval (`running → waiting`, then `waiting → running`)
- **THEN** the approval request/resolution entries are the record of that pause, and the status transitions do not add a second entry that restates them

#### Scenario: Terminal outcome stays visible

- **WHEN** the agent enters `error` or `aborted`
- **THEN** one `info` entry records that transition regardless of the trigger

### Requirement: Approval resolutions are logged

Approvals SHALL be recorded as a pair of lifecycle events — `agent:tool-approval-request` and `agent:tool-approval-resolved` — and the Event→Log bridge SHALL turn them into `approval` category entries according to the policy table.

The request event SHALL carry `auto: true` when nobody is being asked (`auto` mode / plan execution answers the same approval in the same tick). The resolution event SHALL carry `source` (`user` | `auto` | `policy`), because `reason` alone could not distinguish "the operator approved this" from "the agent approved this" (2 of 12,126 resolutions in one audited corpus carried a reason).

The policy SHALL suppress the request entry when the request was auto-answered and the resolution entry when `source` is `auto`: those approvals were never put to a human, and `agent:tool-start` still records the call. A resolution by the operator or by the command-safety policy SHALL be recorded. The two suppressions read different payload fields by necessity — the request knows only what the pump knew when it asked — so a mode toggle between request and resolution can leave one row without its twin; the `mode:change` entry is the record that explains that window.

#### Scenario: User approves a tool

- **WHEN** the user approves a pending tool call
- **THEN** one `approval` entry records `decision: "approved"` and `source: "user"` for that tool call id, in addition to the original request entry

#### Scenario: Auto-answered approval records no question

- **WHEN** auto mode (or plan execution) answers the approval in the same tick
- **THEN** neither the request nor the resolution writes an entry, while `agent:tool-start` still records the call and `mode:change` records why no human was asked

#### Scenario: Command-safety decision is attributed

- **WHEN** the command-safety policy denies a `run_command` call
- **THEN** one `approval` entry records `decision: "denied"` with `source: "policy"`

### Requirement: Subagent completion carries run statistics

`subagent:completed` lifecycle events SHALL include `iterations`, `durationMs`, and a `usage` snapshot from the subagent run result, so the Event→Log entry records quantitative outcome in addition to the summary text.

#### Scenario: Completed subagent logs stats
- **WHEN** a subagent finishes after 3 iterations and 12 seconds
- **THEN** the bridged log entry contains `iterations: 3` and `durationMs` approximately 12000

### Requirement: Log entries are run-scoped

Every log entry written during an agent run SHALL carry a `run` field: a short run identifier stable for the duration of that run, enabling per-run slicing of the JSONL timeline. The identifier SHALL originate on the event envelope (`runId`) so every consumer sees the same value; entries written outside a run (bootstrap, idle-time operations) MUST omit it.

#### Scenario: Timeline slices by run

- **WHEN** a session log contains two consecutive runs
- **THEN** all entries of the first run share one `run` id, all entries of the second run share a different `run` id, and `turn:summary` closes each run's slice

#### Scenario: One run id for every consumer

- **WHEN** a run is active and two different consumers record the same run's events
- **THEN** both read the same `runId` from the envelope and neither derives its own

### Requirement: Turn summary is the canonical run outcome record

The `turn:summary` entry SHALL include: LLM call count, tool call count, input/output/cache token totals for the run, run cost in USD, total run duration, and the finish outcome (`finished` | `aborted` | `error`).

A pump that stops only because the run is waiting on the user (approval, `ask_user`) SHALL NOT be reported as a completed turn: its entry MUST NOT claim a finish outcome, and the policy MUST distinguish it from a real turn end (a distinct message or a demoted level), so `outcome` is present exactly on turns that actually ended.

#### Scenario: Finished run summary is self-sufficient

- **WHEN** a run completes normally
- **THEN** the final `chat` category summary entry answers "how long, how many calls, how many tokens, what cost, what outcome" without cross-referencing other entries

#### Scenario: Approval pause is not a turn completion

- **WHEN** a run pauses to wait for a tool approval or an `ask_user` answer
- **THEN** the recorded entry does not read as a completed turn and does not carry a finish outcome

### Requirement: Log entries derive exclusively from bus events

Every persisted log entry SHALL be produced by the Event→Log policy layer from an `AgentEventBus` event. Core MUST NOT write log entries directly from a call site once an agent is resolvable on the bus; the only exception is the pre-registration window defined by `log-extension` (agent construction, before the agent is registered).

A fact worth recording therefore requires an event and a policy entry, not a log call. This includes facts that previously had no event: agent status transitions, session title generation, mode/config changes, model switches, side-query outcomes, extension log output, and todo changes.

#### Scenario: A fact is recorded by emitting an event

- **WHEN** a subsystem performs an operation worth recording (status change, title generated, model switched, side query failed, extension wrote a log line)
- **THEN** it emits a declared event on the scoped bus, and the persisted entry appears because the policy table has an entry for that event type

#### Scenario: No hand-written entry for a bus-observable fact

- **WHEN** an operation already emits an event
- **THEN** there is no additional direct `AgentLog` call for the same fact, so the fact appears exactly once

#### Scenario: Removing a recording does not require touching call sites

- **WHEN** an operator decides an event should no longer be recorded
- **THEN** the suppression is expressed in the policy table (or by lowering its level) and no emitter changes

### Requirement: Log policy table is complete and default-silent

The policy table SHALL carry exactly one entry per `AgentEventType` — a rule, an explicit suppression (`false`), or a dedicated handler marker — and absence of an entry MUST fail compilation or a validator rather than silently recording.

Because the event registry has two halves (`AgentEvents` = telemetry + session-projection events, `AgentEventPayloadMap` = telemetry only), completeness SHALL be enforced on both: the telemetry half keeps its exhaustive typed literal, and the projection half carries its own exhaustive literal of explicit suppressions. An event classified `internal` MUST be suppressed (`false`) and MUST NOT carry a formatter, because wildcard delivery withholds internal events and such a rule could never run.

An event SHALL NOT be recorded by default merely because it exists: high-frequency or snapshot events (streaming chunks, message/turn boundaries, list snapshots, queue snapshots, job lifecycle) MUST be explicitly suppressed or demoted unless the policy opts in.

The policy table owns **category, wording and suppression**. Severity is the one field a producer may supply (`session:diagnostic.level`, `extension:log.level`): the subsystem that degraded knows whether it kept working (`debug`/`info`) or lost a capability (`warn`/`error`), and the table still decides whether the row exists at all. That exception is explicit so it cannot be read as "the emitter decides everything".

#### Scenario: New event cannot be silently unrecorded

- **WHEN** a new telemetry or projection event type is added and the policy table has no entry for it
- **THEN** the build (typed tables) or `validate:*` fails, so "we forgot to decide" is visible

#### Scenario: Snapshot events stay out of the timeline

- **WHEN** a retained list/snapshot channel emits (`session:jobs`, `session:subagents`, `session:queues`, `session:usage`, `session:messages`)
- **THEN** no timeline entry is written for it, because its projection-table entry is an explicit suppression

#### Scenario: Internal event cannot claim a rule

- **WHEN** an event is classified `internal` in the extension visibility table
- **THEN** its policy entry is `false`, so the table never documents a recording that wildcard delivery makes impossible

### Requirement: No new hand-written log call sites

A `validate:*` guard SHALL fail when a direct `AgentLog` emission (`debug` / `info` / `warn` / `error` / `eventEntry`) is added outside a declared allowlist. The allowlist SHALL be a list of FILES (not directory prefixes), each with a stated reason, and SHALL contain only the seam itself, the crash/exit path, the policy/sink implementation modules, and the subagent parent-index mirror whose write is deliberately not a second event.

#### Scenario: New direct call fails the guard

- **WHEN** a module outside the allowlist calls `log.info(...)` (or any other seam method)
- **THEN** the guard fails with the file and line, and the fix is to emit an event or add a policy entry
