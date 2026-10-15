# agent-lifecycle-events

## Purpose

AgentEventBus lifecycle notifications: emission contracts, payload shapes, relationship to ExtensionEventBus, and Event→Log as the sole core wildcard consumer.
## Requirements
### Requirement: Lifecycle tool events are independent of extensions

The system SHALL emit `agent:tool-start` before each tool invocation and SHALL emit exactly one of `agent:tool-end` or `agent:tool-error` after each tool invocation as observer events on the unified `AgentEventBus`, whether or not an `ExtensionRunner` is present. Interceptor handlers MUST NOT gate lifecycle tool event emission.

#### Scenario: Tool completes without extension runner

- **WHEN** a tool finishes successfully and no `ExtensionRunner` is configured
- **THEN** the `AgentEventBus` receives `agent:tool-start` followed by `agent:tool-end` with `tool_name` and duration metadata

#### Scenario: Tool fails without extension runner

- **WHEN** a tool throws or returns an error path and no `ExtensionRunner` is configured
- **THEN** the `AgentEventBus` receives `agent:tool-start` followed by `agent:tool-error` with error text

#### Scenario: Extension deny still emits lifecycle start

- **WHEN** an extension sets skip/deny on `tool:before:*`
- **THEN** `agent:tool-start` has already been emitted as an observer event on the `AgentEventBus` before interception completes

### Requirement: Compaction start events match compaction kind

The system SHALL emit `compaction:auto-start` only for auto-compaction and `compaction:reactive-start` only for reactive compaction. A reactive compact attempt MUST NOT also emit `compaction:auto-start`.

#### Scenario: Auto compact start
- **WHEN** auto-compaction begins because the token threshold is exceeded
- **THEN** the AgentEventBus emits `compaction:auto-start` and does not emit `compaction:reactive-start`

#### Scenario: Reactive compact start
- **WHEN** reactive compaction begins after a context-overflow recovery path (classified by the provider's stable `code` first, prose fallback)
- **THEN** the AgentEventBus emits `compaction:reactive-start` exactly once for that attempt and does not emit `compaction:auto-start`

### Requirement: Session restore and subagent destroy emit lifecycle events

The system SHALL emit `session:restore` after a session is successfully restored onto a managed agent. The system SHALL emit `subagent:destroyed` when a subagent managed agent is destroyed or auto-destroyed.

#### Scenario: Resume session emits restore
- **WHEN** `ManagedAgent.restoreSession` successfully loads session data
- **THEN** the AgentEventBus emits `session:restore` with the session id in the event data

#### Scenario: Destroy subagent emits destroyed
- **WHEN** a subagent is removed via destroy / autoDestroy
- **THEN** the AgentEventBus emits `subagent:destroyed` for that subagent id

### Requirement: Approval requests log only via Event→Log

When tool approvals become pending, the system SHALL emit `agent:tool-approval-request` and MUST NOT also write a duplicate approval entry through the log emission seam at the status-controller emit site. The built-in log extension's bus subscription SHALL be the sole path that turns that event into a log entry, and the status controller MUST NOT call the seam's approval logging directly.
#### Scenario: Approval pending produces one log path
- **WHEN** `syncApprovals` observes one or more tools needing approval
- **THEN** each pending tool causes an `agent:tool-approval-request` emission and the status controller does not write an approval entry directly through the seam

### Requirement: Subagent completed payload includes summary

When a subagent run finishes successfully, the system SHALL emit `subagent:completed` with a typed `payload.summary` field (string) suitable for Event→Log formatting, plus `iterations` (number), `durationMs` (number), and a `usage` token snapshot from the subagent run result. Event→Log SHALL prefer `payload.summary` when composing the log message and SHALL include the run statistics in the entry data.

#### Scenario: Completed event includes summary for logging
- **WHEN** a subagent finishes successfully and emits `subagent:completed`
- **THEN** the event envelope includes `payload.summary` as a string and Event→Log uses that field for the log line

#### Scenario: Completed subagent logs run statistics
- **WHEN** a subagent completes after 3 iterations, 12 seconds, with recorded token usage
- **THEN** the `subagent:completed` payload includes `iterations: 3`, a `durationMs` of approximately 12000, and a `usage` object, and the bridged log entry carries these fields

### Requirement: Architecture docs describe extension observation model

`packages/core/ARCHITECTURE.md` SHALL describe the current middleware stack (`extensions-middleware`), SHALL NOT document `.agent-hooks` / HookRegistry as supported customization, SHALL document the unified `AgentEventBus` model (single registry with observer `emit` and interceptor `intercept` dispatch modes, retained values, scoped routing, and the `AgentSession` channel projection) instead of the former dual-bus split, SHALL document the extension message-transform surface (`registerMessageTransformer`) as a non-bus capability alongside the bus-backed interceptors, and SHALL document extension-declared dispatch order (`ExtensionAPI.order`) as the mechanism that orders the dispatch-ordered extension surfaces.

#### Scenario: Doc middleware list matches buildAgentRunner

- **WHEN** a reader follows ARCHITECTURE §3.3 middleware order
- **THEN** the listed stack matches `buildAgentRunner` in `run-agent.ts`, ending with extensions middleware rather than hooks middleware

#### Scenario: Doc describes the unified bus

- **WHEN** a reader follows the ARCHITECTURE event-model section
- **THEN** it documents one `AgentEventBus` with observer and interceptor modes and the session channel projection, and does not describe `AgentTelemetryBus` and `ExtensionEventBus` as separate systems

#### Scenario: Doc separates bus-backed from non-bus extension surfaces

- **WHEN** a reader follows the extension interception section
- **THEN** the interceptor pattern list contains only bus-backed hook names, and the message-transform registration is described in its own right with its ordering, wire-only, and cache-bypass contracts

#### Scenario: Doc states the order contract once

- **WHEN** a reader follows the ARCHITECTURE extension section to learn where an extension runs
- **THEN** it states the direction (lower first), the tie-break (load sequence), the surfaces `order` governs, and the surfaces it deliberately does not, without requiring the reader to consult a second document

### Requirement: Approval resolution emits lifecycle event

The system SHALL emit `agent:tool-approval-resolved` on the AgentEventBus exactly once per pending approval when it is resolved — whether by user decision or by command-safety auto-decision. The event payload SHALL include `tool_call_id`, `tool_name`, `decision` (`approved` | `denied`), and `reason` when a reason exists. The built-in log extension SHALL be the sole path that turns this event into an `approval` category log entry.

#### Scenario: Command-safety auto-deny emits resolution
- **WHEN** command-safety automatically denies a shell command tool call
- **THEN** `agent:tool-approval-resolved` is emitted with `decision: "denied"` and a reason, and exactly one `approval` log entry is written by the log extension

### Requirement: Lifecycle events use typed envelope
AgentEventBus emissions covered by this spec (tool lifecycle, compaction kind, session restore, subagent destroy/completed, approval requests) SHALL use the shared typed AgentEvent envelope (`ts`, `agentId`, `parentId?`, `payload`) instead of loosely typed `data` bags. Existing emission timing and exclusivity contracts remain in force.

#### Scenario: Approval request uses payload envelope
- **WHEN** tools need approval and `agent:tool-approval-request` is emitted
- **THEN** the event includes typed `payload` fields required by Event→Log
- **AND** the status controller still does not call `log.approval` directly


### Requirement: Extension dispatch order is part of the loading contract

The system SHALL record each extension's load sequence at load time and SHALL make it available
alongside the extension's declared `order`, so that dispatch-ordered surfaces can be resolved to a
deterministic sequence without re-deriving load order from the loader's discovery rules. Discovery
order (which file resolves for a duplicated extension id) and dispatch order (which position the
extension runs in) SHALL remain separate concerns and MUST NOT be defined in terms of one another.

#### Scenario: Load sequence is recorded, not re-derived

- **WHEN** an extension is loaded
- **THEN** its load sequence is recorded at that moment, and dispatch ordering consumes the record rather than the loader's directory-scan order

#### Scenario: Discovery order does not decide dispatch position

- **WHEN** two extensions with the same declared `order` are discovered from different directories and loaded in a sequence
- **THEN** their dispatch position follows the recorded load sequence, and no dispatch rule reads the discovery order


### Requirement: The extension catalog reports effective dispatch order

The extension catalog SHALL carry each extension's effective dispatch order and SHALL list entries in
dispatch order, so that an ordering conflict is observable at runtime rather than only in source.
The reported value SHALL be the effective one (declared, or the default when undeclared).

#### Scenario: Catalog order matches dispatch order

- **WHEN** a consumer reads the extension catalog and separately observes interceptor dispatch
- **THEN** the catalog's entry order is consistent with the observed dispatch order

#### Scenario: Catalog exposes the effective value

- **WHEN** an extension declares no order
- **THEN** the catalog reports the effective default position rather than omitting the field
