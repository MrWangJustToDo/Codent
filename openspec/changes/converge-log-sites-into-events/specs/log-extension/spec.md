## MODIFIED Requirements

### Requirement: Log entries are emitted through a non-removable seam

Logging MUST remain available when no extension is active: during workspace/agent construction, before extension loading, and while an extension is failing to activate. Core SHALL therefore keep a thin always-on emission seam that performs level filtering and envelope construction and calls the log extension's sink.

That seam SHALL be scoped to the **pre-registration window**. Once an agent is resolvable on the bus, facts MUST be recorded by emitting events and applying the policy table; the seam MUST NOT remain the general write path, and the log policy MUST NOT depend on a second, parallel set of call sites.

The seam MUST NOT be an extension itself, MUST NOT be disableable, and MUST NOT require an activated extension to function. A failure inside the log extension MUST NOT prevent the agent from running: a log-persistence failure SHALL be non-fatal and MUST NOT propagate into the agent loop.

#### Scenario: Extension activation failure is still recorded

- **WHEN** an extension fails to activate and core records the failure through the seam
- **THEN** the failure appears in the persisted log, even though the log extension is itself an extension

#### Scenario: Seam is not an extension

- **WHEN** a consumer inspects the registered extensions
- **THEN** the emission seam is not among them, and disabling every registered extension does not remove the ability to record that they were disabled

#### Scenario: Log failure does not break the run

- **WHEN** the log extension's write path throws or its environment lacks the filesystem primitives it needs
- **THEN** the agent run completes normally and the failure does not surface as a run error

#### Scenario: Post-registration facts are event-driven

- **WHEN** an agent is registered and a fact worth recording occurs
- **THEN** it is emitted as an event and recorded through the policy table, with no direct seam call at the emitting site

### Requirement: Log resolution is bound per agent by core

Because session identity is core's and changes on resume, core SHALL own **resolution** — which agent's log an entry belongs to, and the session-derived directory — and SHALL pass the binding to the log extension. The log extension SHALL own **presentation** (filename, path shape within the bound directory, rotation, boundary markers). A subagent's entries SHALL be written to an independent file inside its owning session's directory.

Resolution MUST be available **before** the agent is registered, because bootstrap (extension activation, documentation, skills, MCP, memory) runs during construction. Core SHALL therefore bind the agent's log target to its bus scope before bootstrap begins, and keep that binding resolvable through teardown after the registry entry is gone.

#### Scenario: Resumed session appends to the same file

- **WHEN** a session is restored and the agent resumes under the same session id
- **THEN** the log extension writes to the session's existing directory and file, with a session-boundary divider rather than a new directory

#### Scenario: Subagent gets its own file in the parent directory

- **WHEN** a subagent emits entries
- **THEN** they are written to a file named for the subagent inside the parent session's log directory, and the parent's file is unaffected

#### Scenario: Bootstrap events resolve to the constructing agent

- **WHEN** an event is emitted during agent construction, before the agent is registered
- **THEN** it is attributed to that agent's log and persisted, instead of being dropped as unresolvable

#### Scenario: Teardown events stay attributed

- **WHEN** an agent has left the registry but its async teardown is still emitting
- **THEN** those events are attributed to its own log and never to the parent's sink
