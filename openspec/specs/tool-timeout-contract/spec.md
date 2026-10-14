# tool-timeout-contract Specification

## Purpose
TBD - created by archiving change add-tool-timeout-contract. Update Purpose after archive.
## Requirements
### Requirement: Tools may declare an execution deadline

A tool definition SHALL be able to declare an optional `timeoutMs`. When declared, the tool
runtime MUST enforce the deadline around the tool body and MUST pass the body a signal that
aborts when the deadline elapses.

#### Scenario: A declared deadline aborts a slow tool

- **WHEN** a tool declared with a `timeoutMs` runs longer than that deadline while the run signal is live
- **THEN** the runtime aborts the tool's signal and the call settles as a failure

#### Scenario: No declaration, no deadline

- **WHEN** a tool does not declare `timeoutMs`
- **THEN** the runtime applies no deadline and the tool's behaviour is unchanged

### Requirement: A timeout is a typed failure, not a cancellation

A tool that exceeds its declared deadline SHALL abort with a reason carrying the failure kind
(`ExecutionError("timeout", …)`), so the shared `isAbortError` predicate does not classify it as
a user cancel. The model-facing result MUST convey a timeout and MUST NOT tell the model that the
user stopped work the user never stopped.

#### Scenario: Deadline expiry is not a cancel

- **WHEN** a declared-deadline tool exceeds its deadline while the run signal is not aborted
- **THEN** the call settles as an error rather than `cancelled: true`, and the model receives the timeout error

### Requirement: A run abort outranks the deadline

The run signal SHALL be consulted before the deadline verdict: when the run signal is aborted,
the call MUST settle as cancelled even if the deadline also fired.

#### Scenario: User stop wins over a simultaneous expiry

- **WHEN** the run signal is aborted while a declared-deadline tool is in flight
- **THEN** the call settles as cancelled, not as a timeout

### Requirement: One deadline implementation across tool sources

Built-in tools registered through `defineServerTool` and extension tools SHALL share a single
timeout implementation, and the extension path MUST reject with the same
`ExecutionError("timeout")` shape rather than a plain `Error`.

#### Scenario: Extension tool timeout is typed

- **WHEN** an extension tool declares `timeoutMs` and exceeds it
- **THEN** it rejects with an `ExecutionError("timeout", …)` reason, not a plain `Error`

### Requirement: Timeout contract coverage

The repository SHALL maintain an automated validator asserting the timeout-vs-cancel matrix for
at least one `defineServerTool` tool and one extension tool.

#### Scenario: Validator covers both tool sources

- **WHEN** the core validator suite runs
- **THEN** it includes `validate:tool-timeout-contract`, which passes for a built-in declared-deadline tool and an extension tool, and asserts that a timeout is not reported as a cancel

### Requirement: An LSP request carries a deadline

Every request issued through `LspConnection.sendRequest` SHALL be bounded: it SHALL settle (resolve or
reject) within a deadline, and a request made without an explicit one SHALL take a default rather than
wait indefinitely. When a deadline expires the host SHALL cancel the outstanding request with the
language server (so the server stops the work nobody will read) and SHALL reject with an error naming
the request and the deadline. A rejection SHALL be an ordinary tool failure — the run continues and the
server session survives.

A request SHALL also accept the caller's abort signal, so that stopping a run settles a pending request
immediately instead of waiting out the deadline.

#### Scenario: A language server that never answers does not wedge the run

- **WHEN** a tool issues a request and the language server never responds
- **THEN** the request rejects after the deadline with an error naming the request and the deadline
- **AND** the tool returns that error as its result and the run continues

#### Scenario: Stopping a run releases a pending request

- **WHEN** the run is aborted while an LSP request is pending
- **THEN** the request settles without waiting for the deadline

