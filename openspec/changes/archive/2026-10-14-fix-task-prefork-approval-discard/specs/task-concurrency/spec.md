## ADDED Requirements

### Requirement: A registered pre-fork survives an invocation that pauses for input

The pre-fork of a `task` call SHALL be discarded only when the run can no longer join it. An
invocation that ends because the run is pausing for user input — a tool awaiting an approval
decision, or a client tool awaiting a result — SHALL NOT discard the registered runs of that turn,
because the run's next pump executes the tool phase that joins them.

The discard decision SHALL be based on whether a joining tool phase is still pending, not on whether
an approval was requested: an answered-but-not-yet-executed tool keeps the run joinable just as an
unanswered one does.

#### Scenario: Approval-bearing turn keeps its pre-fork

- **WHEN** one model turn contains a `task` call and a tool that requires approval, and the
  invocation ends on that approval wait
- **THEN** the `task` call's pre-fork is still registered when the tool phase runs after the approval
- **AND** that tool phase joins the eager run instead of spawning a second subagent for the same call id

#### Scenario: Client-tool wait keeps its pre-fork

- **WHEN** the invocation ends with a client tool such as `ask_user` awaiting a result
- **THEN** the `task` pre-forks of that turn are not discarded

#### Scenario: Approval answered during the wait

- **WHEN** the user answers a pending approval and the invocation has not yet finished unwinding
- **THEN** the pre-forks of that turn are still not discarded, and the next pump joins them

#### Scenario: A paused run abandoned without an answer still discards

- **WHEN** a turn's `task` pre-forks are still registered because the run is waiting for an approval
  or a client tool, and the run is then aborted or reset instead of answered (a user stop,
  force-submit, an agent destroy, or a `/clear` / new session)
- **THEN** those pre-forks are discarded and reported with the run-abort cause, rather than surviving
  until a later run reports them as its own orphans

#### Scenario: A session switch or in-place clear while paused stops the eager runs

- **WHEN** a session is switched, or the transcript is cleared in place, while a run is paused with
  registered pre-forks
- **THEN** the run is interrupted (a registered pre-fork counts as "still active", even with no pump)
- **AND** those pre-forks are discarded and their subagents stopped, so nothing keeps streaming into
  the transcript that replaced them

#### Scenario: A run that ends without a join still discards

- **WHEN** an invocation ends with no pending wait and no tool phase left to run, while a pre-fork for
  that turn is still registered
- **THEN** the pre-fork is discarded and the discard reports the tool call id, the cause, and the
  subagent ids it orphaned

### Requirement: A pre-fork that outlives its invocation remains abortable

A pre-fork that survived one or more pump boundaries SHALL remain reachable by a run-level abort. An
abort of the run during any later pump SHALL stop such a subagent rather than leaving it streaming
unobserved, and SHALL carry the run's abort reason so the stop is classified against the reason
taxonomy.

#### Scenario: Abort during a later pump

- **WHEN** a pre-fork was spawned in one pump, the run paused for input, and the run is then aborted
  during a subsequent pump
- **THEN** that subagent is aborted with the run's reason

#### Scenario: A user stop classifies correctly

- **WHEN** the user stops the run while a surviving pre-fork is streaming
- **THEN** the subagent stops with a reason that classifies as a parent-run or parent-stop outcome,
  not as a user cancellation of the subagent itself
