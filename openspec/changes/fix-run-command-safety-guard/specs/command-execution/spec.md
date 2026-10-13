## ADDED Requirements

### Requirement: run_command has an effective deadline

`run_command` SHALL apply an effective execution deadline to every foreground invocation: the
caller's `timeout` when provided, otherwise a configurable default. The default SHALL be
documented in the tool description so the model can override it, and it SHALL NOT present as an
undocumented wall.

#### Scenario: Caller timeout wins

- **WHEN** the model passes `timeout`
- **THEN** that value is the effective deadline

#### Scenario: Default applies when omitted

- **WHEN** the model omits `timeout`
- **THEN** a configurable default deadline applies
- **AND** the deadline is discoverable from the tool description

#### Scenario: A long command completes under the default

- **WHEN** a foreground command runs longer than the previous 30s safety wall but within the effective default deadline
- **THEN** it completes and returns its real stdout/stderr and exit code
- **AND** it is not terminated as a timeout or a safety kill

### Requirement: Deadline expiry follows the timeout path

When a foreground command exceeds its effective deadline, the system SHALL terminate the process
tree (not only the spawned shell), SHALL preserve any partial stdout/stderr, and SHALL settle as a
typed timeout (`ExecutionError("timeout", …)`), never as a fabricated non-zero exit.

#### Scenario: The process tree is killed

- **WHEN** the effective deadline elapses
- **THEN** every process in the tree is terminated, not only the shell process
- **AND** no descendant is left running

#### Scenario: Partial output survives

- **WHEN** a command is ended by its deadline after producing output
- **THEN** the stdout and stderr captured so far are returned with the timeout

#### Scenario: A deadline is a timeout, not a cancel

- **WHEN** the deadline elapses while the run signal is not aborted
- **THEN** the call settles as a timeout error, not as `cancelled: true`

### Requirement: The safety guard is a last resort

The CoreEnv safety guard SHALL trigger only when the process has not **exited** within the
effective bound. It SHALL judge completion on process exit and allow a bounded drain grace for the
streams to close, so a descendant that keeps the stdout pipe open after exit does not extend the
deadline.

#### Scenario: Exited process with an open pipe is not a failure

- **WHEN** the process exits but a descendant keeps the stdout pipe open past exit
- **THEN** the command is reported as finished after the drain grace with its real exit code
- **AND** it is not reported as a safety kill

#### Scenario: A still-running process past the bound is killed

- **WHEN** the process has not exited within the effective bound
- **THEN** the process tree is killed
- **AND** the result reports a safety kill that names the effective bound

### Requirement: A safety kill reports honestly and preserves output

On a safety kill the result SHALL preserve the partial stdout and stderr, SHALL report `-1` (the
"not finished" value) as the exit code instead of a fabricated `1`, and SHALL surface the safety
reason alongside the command's real stderr — never replacing it and never being dropped when
stderr is non-empty. The reason SHALL name the effective bound and that the process was still
running, and SHALL NOT assert an unverified cause.

#### Scenario: No stderr from the command

- **WHEN** a safety kill occurs and the command wrote no stderr
- **THEN** the partial stdout is returned
- **AND** the exit code is `-1`
- **AND** stderr carries the safety reason naming the bound

#### Scenario: The command wrote stderr

- **WHEN** a safety kill occurs and the command wrote stderr
- **THEN** the command's stderr is preserved
- **AND** the safety reason is also present (neither replaces the other)

#### Scenario: No fabricated cause

- **WHEN** the safety guard fires
- **THEN** the reported reason does not claim a cause that was not verified

### Requirement: The guard timer is cleared on settle

The safety-guard timer SHALL be cleared when the process settles, so a completed command leaves no
pending timer behind.

#### Scenario: Completed command leaves no timer

- **WHEN** a foreground command completes
- **THEN** no safety-guard timer remains pending

### Requirement: Safety-guard coverage

The repository SHALL maintain an automated validator asserting the foreground deadline and
safety-guard contract: the default-deadline path, partial-output preservation, the `-1`/real exit
code, the reason-alongside-stderr rule, and the last-resort trigger condition.

#### Scenario: Validator is present and non-vacuous

- **WHEN** the core validator suite runs
- **THEN** it includes `validate:run-command-safety-guard`
- **AND** that validator fails if a guard kill drops output, fabricates an exit code, or names an unverified cause
