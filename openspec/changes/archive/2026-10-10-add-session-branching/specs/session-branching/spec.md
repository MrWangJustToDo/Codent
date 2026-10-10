## ADDED Requirements

### Requirement: A session can be cloned into a new session

The system SHALL provide a `/clone` command that creates a new session whose messages and model
settings are copied from the current session, writes it to disk, and switches the active session to
it. The source session MUST be left unchanged and remain resumable.

#### Scenario: Clone copies and switches

- **WHEN** `/clone` runs on an idle root session
- **THEN** a new session id exists on disk whose messages equal the source's at clone time, and the active session becomes the new one

#### Scenario: Source is untouched

- **WHEN** a clone is created
- **THEN** the source session file is unchanged and can still be resumed like any other session

#### Scenario: Default name

- **WHEN** `/clone` runs without a name
- **THEN** the new session's name is derived from the source session's name

### Requirement: A session can be forked from an earlier user message

The system SHALL provide a `/fork` command that creates a new session containing the messages
strictly before a chosen earlier user message, switches to it, and makes that message's text
available to resend, leaving the source session unchanged.

#### Scenario: Fork truncates at the chosen message

- **WHEN** `/fork` selects a user message
- **THEN** the new session contains every message before that message and none at or after it

#### Scenario: The chosen message's text is handed back for editing

- **WHEN** a fork completes
- **THEN** the chosen user message's text is placed into the editor so the user can edit and resend it

#### Scenario: Default name

- **WHEN** `/fork` runs without a name
- **THEN** the new session's name is derived from the source session's name

### Requirement: Branch state is copied or reset deliberately

The new session SHALL copy the model, model style, and reasoning effort from the source; SHALL start
with fresh window usage, empty todos, and plan/auto mode off; and SHALL record the source session id
as its `forkedFrom` lineage pointer.

#### Scenario: Model settings copied

- **WHEN** a clone or fork is created
- **THEN** the new session uses the source's model, model style, and reasoning effort

#### Scenario: Per-session work state reset

- **WHEN** a clone or fork is created
- **THEN** its todos are empty and plan and auto mode are off

#### Scenario: Lineage recorded

- **WHEN** a clone or fork is created
- **THEN** the new session records the source session id in `forkedFrom`

### Requirement: Branching is safe and parity-preserving

Branching SHALL reuse the existing session-switch path, SHALL refuse while a run is active, and
SHALL work in local and remote-session hosts without a server schema change.

#### Scenario: Refused while a run is active

- **WHEN** `/clone` or `/fork` is invoked while the agent is running
- **THEN** it fails with a clear message to stop the run first, and creates nothing

#### Scenario: Remote session host

- **WHEN** the agent runs under `--remote-session`
- **THEN** the new session is created on the server and the switched transcript is returned to the client

#### Scenario: No server schema change required

- **WHEN** the command is dispatched over `POST /api/agent/:id/command`
- **THEN** it flows through the generic command route (which forwards the command unchanged) with no new server route or schema
