# Spec Delta

## MODIFIED Requirements

### Requirement: Abort cancellation of in-flight tool work

When a run is aborted, tool invocations that have not reached a terminal state SHALL be marked cancelled, the cancellation SHALL be persisted with the aborted turn, and the persistence SHALL survive a session resume. A call whose arguments never arrived is not in-flight work and SHALL NOT be settled as a user cancellation; it is settled as truncated instead.

#### Scenario: Incomplete tools persisted on abort

- **WHEN** a run is aborted while tool rows are in-flight
- **THEN** those tool rows are transitioned to a cancelled terminal state and included in the persisted messages for the aborted turn

#### Scenario: Truncated calls are excluded from the user cancellation

- **WHEN** the aborted run also holds tool calls with no arguments
- **THEN** those calls are stored with the truncation notice instead, and only the executing call reports a user cancellation
