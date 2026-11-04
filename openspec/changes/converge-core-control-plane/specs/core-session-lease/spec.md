## ADDED Requirements

### Requirement: One lease owns session identity and ownership

Each live root agent SHALL own exactly one `SessionLease` that represents its disk-session attachment. The lease SHALL expose an explicit state (`unclaimed`, `claimed`, `restoring`, `active`, `draining`, `released`), the session id, a monotonic `generation`, and the owning agent id. Only the lease SHALL mutate: the in-memory ownership table, the empty-session reservation, the restore placeholder, the log-sink binding or the persistence baseline. Code outside the session domain SHALL observe those facts through the lease rather than by writing the underlying stores.

#### Scenario: First attach

- **WHEN** a root agent is created with no resume target
- **THEN** its lease transitions `unclaimed → claimed → active`, and the ownership table contains exactly one claim for the resulting session id

#### Scenario: Resume target

- **WHEN** a session is created with `resumeSessionId`
- **THEN** the lease claims that id for the agent (`claimed`), enters `restoring` while the transcript loads, and becomes `active` only at the commit

#### Scenario: Concurrent claim

- **WHEN** a second live root attempts to claim a session id already owned by a live lease
- **THEN** the claim fails before any transcript or log write, and the existing lease is unchanged

### Requirement: The switch is one rollbackable transaction

A session switch (`new`, `resume`, `clone`, `fork`) SHALL run through one transaction with ordered phases: stop producers and drain queued writes → read/restore the target → commit the target lease → reset transient state → rebind sidecars (log sink, background work, subagents) → release the leaving session. Each phase SHALL have a defined rollback or completion rule; the commit phase SHALL be the single point after which the target is current.

#### Scenario: Failure before commit

- **WHEN** reading or restoring the target fails before the commit
- **THEN** the leaving session remains the active lease, ownership and log sink are unchanged, and its transcript is reloaded from its own disk record

#### Scenario: Failure after commit

- **WHEN** a post-commit step fails
- **THEN** the target remains adopted (the switch is not reported as a failed switch), the failure is reported, and no write targets the leaving session

#### Scenario: Exactly-once ownership

- **WHEN** a switch completes
- **THEN** exactly one live lease exists for the agent, the leaving session's claim is released, and the target's claim is held by that agent

### Requirement: Lease owns generation and the persistence baseline

The lease SHALL increment its `generation` at commit and SHALL be the source of the session generation used by `Epoch`. The persistence baseline (what has already been written to disk) SHALL be reset by the lease at commit, using the transcript that was actually written, so a read-side repair can never be considered "already persisted" when it is not.

#### Scenario: Restore repair is persisted

- **WHEN** a resumed session's interrupted background command/task or half-open tool call is repaired during restore
- **THEN** the repaired transcript is written before the baseline is reset, and a subsequent switch does not resurface the pre-repair `running` handle

#### Scenario: Old epoch after commit

- **WHEN** an operation captured an epoch before the switch and resumes after the commit
- **THEN** `epoch.isCurrent()` is false because the lease generation advanced

### Requirement: Reservations and placeholders are lease-internal

An empty-session reservation written while resolving a reusable session SHALL be released only when this lease created it and the create failed. A restore placeholder SHALL be usable only by its own lease and SHALL NOT accept a write. Resume targets SHALL never have their reservation released by a create that did not make it.

#### Scenario: Create fails after reserving

- **WHEN** `createManagedAgent` fails after this create reserved an empty session for reuse
- **THEN** the reservation is released and the session is immediately reusable again

#### Scenario: Resume target is not reserved

- **WHEN** a create uses an explicit `resumeSessionId` or the latest-session path
- **THEN** it does not write or release a reservation for that id

### Requirement: Background work reset is part of the transaction

The session switch SHALL await background-work reset (killing job processes and removing their records) before completing, so a re-resume of the leaving id cannot race a late deletion against a fresh restore.

#### Scenario: Immediate re-resume

- **WHEN** the user runs `/new` and immediately `/resume` to the leaving session id
- **THEN** the leaving session's job records are settled before the new restore starts, and the restored records are not deleted by the previous reset

### Requirement: Lifecycle services receive ports, not the agent

The session lifecycle SHALL depend on narrow ports — run control, transcript, mode state and sidecars — instead of a host object that reaches every agent subsystem. The former 38-member `SessionLifecycleHost` SHALL be reduced to at most four ports whose methods are owned by the lease or by the subsystem they describe; no port SHALL expose the owning `ManagedAgent`.

#### Scenario: Port audit

- **WHEN** the session domain is compiled in isolation
- **THEN** it imports port types only, and no port type or implementation references `ManagedAgent`

#### Scenario: Test with fakes

- **WHEN** a unit test drives a switch
- **THEN** it provides fake run/transcript/mode/sidecar ports without constructing an agent
