## ADDED Requirements

### Requirement: UI suspend does not tear down the runtime

The app SHALL distinguish "the UI is going away" from "the session is going away".

A host-initiated suspend (a terminal handoff such as an external editor) SHALL unmount the UI while leaving
the runtime, its root session, and any in-flight run untouched: the session handle stays bound in the app
store, the run continues to stream and persist, and pending approvals remain pending.

A later mount that finds the same session still bound SHALL re-bind it and populate from its snapshot
instead of creating a runtime or a session. Only a genuine teardown (process exit, runtime replacement)
SHALL call `destroy` on the adapter.

#### Scenario: Editing while the agent runs

- **WHEN** a turn is streaming and the workspace browser suspends the UI to open an editor
- **THEN** the session is not destroyed and the run is not aborted
- **AND** when the UI resumes, the transcript reflects what the run produced meanwhile
- **AND** no second session or second runtime exists

#### Scenario: Resume reuses the live session

- **WHEN** the UI mounts again after a suspend
- **THEN** it binds the existing session rather than calling the adapter's `initialize`
- **AND** messages, status, queue and interactions are repopulated from the session snapshot

#### Scenario: Pending approvals survive a suspend

- **WHEN** a tool approval is pending at suspend time
- **THEN** it is still pending after resume and can be answered there
- **AND** the run resumes from that point

#### Scenario: Ordinary teardown still releases the runtime

- **WHEN** the app exits without a suspend (`/quit`, `Ctrl+C`, a fatal bootstrap error)
- **THEN** the adapter's `destroy` runs as before
- **AND** the runtime disposes the sessions it owns

### Requirement: Suspend is host-initiated and observable

The suspend state SHALL be owned by the host and readable by the app, not inferred from component unmounts:
an ordinary unmount keeps today's teardown semantics, and only a host that requested a suspend gets the
preserving behavior.

#### Scenario: Unmount without a suspend request

- **WHEN** a component tree unmounts and no suspend was requested
- **THEN** the cleanup path is unchanged and releases the runtime

#### Scenario: Suspend request without an unmount

- **WHEN** a suspend is requested but the UI stays mounted
- **THEN** nothing is released and the app keeps working
- **AND** a stale flag never suppresses a later real teardown
