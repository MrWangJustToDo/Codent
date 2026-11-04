## ADDED Requirements

### Requirement: Agent state has three explicit axes

Agent state SHALL be represented by three independent axes: `LifecyclePhase` (`created`, `bootstrapping`, `ready`, `busy`, `draining`, `destroyed`), `RunPhase` (`idle`, `preparing`, `streaming`, `tooling`, `compacting`, `finalizing`) and `WaitKind` (`none`, `approval`, `question`). The existing `AgentStatus` wire value SHALL be a pure projection of those axes plus the error text; its value set SHALL NOT change.

#### Scenario: Projection is deterministic

- **WHEN** the same phase/run/wait combination is projected twice
- **THEN** the resulting `AgentStatus` is identical and no hidden state participates

#### Scenario: Wire compatibility

- **WHEN** a host reads `AgentSessionSnapshot.status`
- **THEN** it receives one of the existing `AgentStatus` values and does not need to know the axes

### Requirement: One transition table owns state changes

All state changes SHALL go through a single `transition(event)` entry with an explicit allowed-transition table. Callers SHALL NOT assign a status string directly. An illegal transition SHALL throw in development/tests and be recorded (without corrupting state) in production.

#### Scenario: Illegal transition is rejected

- **WHEN** a caller attempts `destroyed → streaming`
- **THEN** development builds throw, production records the attempt, and the state remains `destroyed`

#### Scenario: Single writer

- **WHEN** core is searched outside the state module for direct status assignment
- **THEN** no assignment remains, and the control-plane writer gate fails if one is reintroduced

### Requirement: Terminal, active and wait are derived, not overlapping sets

`isTerminal` and `isActive` SHALL be derived from the axes and SHALL NOT be defined as two overlapping status sets. A run paused on the user SHALL be "waiting", not simultaneously "terminal" and "active". A failed or aborted turn that still owns an unanswered `ask_user` SHALL project `awaiting_user`, not `error`/`aborted`.

#### Scenario: Paused run

- **WHEN** a run is waiting for an approval or a client question
- **THEN** it is active-for-cancellation but not terminal, and the derived predicates agree with the axes

#### Scenario: Failed turn with a pending question

- **WHEN** a stream fails while a valid `ask_user` is still unanswered
- **THEN** the projection is `awaiting_user`, the error text is retained, and new input queues behind the question

### Requirement: Compaction is a phase, not a terminal status

Running compaction SHALL be represented by `RunPhase.compacting` (or an equivalent operation lease) and SHALL NOT require a dedicated `AgentStatus` value that competes with stream outcomes. Finishing a stream while a compaction is owned SHALL leave the compaction state intact until its owner closes it.

#### Scenario: Manual compaction

- **WHEN** `/compact` starts while no pump is live
- **THEN** the run phase is `compacting`, user input is deferred, and the status projection explains the busy state without a second state machine

#### Scenario: Stream finish during compaction

- **WHEN** an auto-compaction is in flight and the surrounding stream reaches a finish
- **THEN** the finish does not overwrite the compaction phase; the compaction's owner restores the run phase when it ends

### Requirement: State events replace status triggers

Status transition call sites SHALL emit a small closed set of transition events (prepare, stream start, stream end, pause, resume, interrupt, compaction start, compaction end, teardown) instead of the current per-call trigger strings. Log policy and consumers SHALL read the transition event, and the projection SHALL carry the same information to hosts.

#### Scenario: Log explains the transition

- **WHEN** a run pauses for approval
- **THEN** one transition event records the pause with its source, and the log row is derived from that event rather than a free-form trigger
