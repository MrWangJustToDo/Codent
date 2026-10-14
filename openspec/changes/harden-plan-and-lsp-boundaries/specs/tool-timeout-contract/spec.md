## ADDED Requirements

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
