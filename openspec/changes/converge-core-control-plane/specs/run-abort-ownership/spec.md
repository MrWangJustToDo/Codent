## MODIFIED Requirements

### Requirement: Stale pump recognizes it is no longer current

A pump iteration started for a given run SHALL hold an `Epoch` whose run token is invalidated when the run is interrupted or superseded and whose session/lifecycle generation advances when the session is switched. When a pump iteration observes `epoch.isCurrent() === false`, it MUST skip outcome adjudication and run finalization, and MUST NOT enqueue steer/followUp messages or continue tool phases. Finalization of an interrupted run SHALL happen at most once.

#### Scenario: Old pump unwinds after cancel-then-resend

- **WHEN** a run is cancelled and a new message is submitted while the old pump's async callbacks are still unwinding
- **THEN** the old pump observes a non-current epoch, performs no finalize/outcome work, and does not defer the new message into the steer/followUp queues

#### Scenario: No double finalize

- **WHEN** both the interrupting path (`interruptCurrentRun`) and the old pump's natural completion path execute for the same run
- **THEN** `finalizeRun` runs exactly once for that run

#### Scenario: Session switched mid-run

- **WHEN** a session switch commits while the old run's pump is still unwinding
- **THEN** the old pump observes the advanced session generation and performs no status, message or persistence write against the target transcript
