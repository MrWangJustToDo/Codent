## ADDED Requirements

### Requirement: The concurrent task cap is configurable per agent

The system SHALL expose a per-agent configuration for the maximum number of `task` subagents that
may run concurrently under one parent, and SHALL default to 4 when it is not set. A configured value
below 1 SHALL be treated as 1.

#### Scenario: Default cap

- **WHEN** a parent agent is created without a configured cap
- **THEN** at most 4 of its `task` subagents run concurrently

#### Scenario: Configured cap

- **WHEN** a parent agent is created with a configured cap of N
- **THEN** at most N of its `task` subagents run concurrently

#### Scenario: Non-positive cap is clamped

- **WHEN** a cap below 1 is configured
- **THEN** the effective cap is 1

### Requirement: Runs beyond the cap queue and roll forward

The pre-fork SHALL admit `task` runs up to the cap and queue the rest FIFO; a queued run SHALL start
as soon as an admitted run frees a slot, not serially and not all at once.

#### Scenario: Fifth task waits then runs

- **WHEN** more `task` calls arrive in one turn than the cap allows
- **THEN** the first cap-many start together and each additional call starts on an earlier run's completion

### Requirement: A queued run does not start until admitted

A `task` run that is queued behind the cap SHALL NOT begin — and SHALL NOT emit its start — until it
acquires a concurrency slot, so a waiting task never appears to be running (and does not time) while
it merely waits.

#### Scenario: Waiting task has not started

- **WHEN** a `task` call is queued behind the cap
- **THEN** its start is not emitted until it is admitted

#### Scenario: The eager tool-phase start is deferred

- **WHEN** the tools phase begins for a `task` call the pre-fork already owns
- **THEN** the eager tool-phase start is not emitted for it (the pre-fork emits the start on admission)
