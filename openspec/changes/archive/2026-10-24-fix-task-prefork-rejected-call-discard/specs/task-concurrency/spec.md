## ADDED Requirements

### Requirement: A rejected task call discards its pre-fork at the tool phase

A registered pre-fork whose `task` call settles without executing SHALL be discarded as that call
settles, not at the next run boundary: the run is cancelled, whatever it held (a slot, or a queue
position if it never started) is released, and the orphan is reported with cause `tool-rejected`.

The trigger SHALL be "the call settled while its run was still registered", not the identity of the
refuser (extension interceptor, mode policy, cache).

#### Scenario: An extension refuses the call

- **WHEN** a `tool:before:task` interceptor sets `event.skip` for a call whose subagent already started
- **THEN** that call's run is cancelled as the call settles
- **AND** the discard is reported with cause `tool-rejected` and the subagent id it orphaned

#### Scenario: A refused call never occupies a slot

- **WHEN** the refused call's run is still queued behind the concurrency cap
- **THEN** its queue position is released, so the next waiting call is admitted instead, rather than
  a run being started later for a call that will never execute

#### Scenario: A joined call is not discarded

- **WHEN** a `task` call executes and joins its registered run
- **THEN** settling that call discards nothing (the join already released it)
