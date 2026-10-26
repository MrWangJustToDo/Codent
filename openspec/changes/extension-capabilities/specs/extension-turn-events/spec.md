## ADDED Requirements

### Requirement: Turn completion is an event

A runtime turn (one model request plus the tool calls it requested) SHALL complete with a
`turn:end` event carrying at least: the 1-based turn index, the finish reason, and how many tool
calls the turn issued. Its start remains `agent:iteration` (`{ current, max }`, retained on the
`iteration` channel); `turn:end` completes the same index.

The pair SHALL be the supported way to reason about turns. A consumer MUST be able to pair them by
index, and a turn that ends without a tool batch MUST still emit `turn:end`.

#### Scenario: Pairing with the iteration event

- **WHEN** a run enters turn 3
- **THEN** `agent:iteration` reports `{ current: 3, max }`
- **AND** when that turn finishes, `turn:end` reports index 3 with its finish reason

#### Scenario: Tool-only turn

- **WHEN** a turn finishes by requesting tools
- **THEN** `turn:end` reports that finish reason and the number of tool calls

#### Scenario: Aborted turn

- **WHEN** a run is aborted mid-turn
- **THEN** the turn that was in flight is not reported as completed
- **AND** the run's own terminal event still fires

### Requirement: Assistant message boundaries are observable

The runtime SHALL emit `message:start` when an assistant message begins streaming and
`message:end` when it is finalized, both carrying at least: the role, the message id, and whether
the message is the run's first assistant output. `message:end` SHALL carry the message's finalized
assistant text and its tool-call count, and SHALL fire for messages that end with tool calls as well
as text. (The wire form of a content part belongs to the UI channel; the event reports what an
extension reasons about.)

#### Scenario: First output is derivable

- **WHEN** an extension needs "the model actually answered"
- **THEN** it observes the first `message:start` with role `assistant`
- **AND** no dedicated first-output event exists for that purpose

#### Scenario: Tool-call message

- **WHEN** an assistant message consists only of tool calls
- **THEN** `message:start` and `message:end` both fire for it

#### Scenario: No event for an empty run

- **WHEN** a run is aborted before any assistant message starts
- **THEN** no `message:start` is emitted for it

### Requirement: Turn and message events are observable, not default-logged

`turn:end`, `message:start` and `message:end` SHALL be classified `observable` so extensions can
subscribe and `observeAny` delivers them. They SHALL NOT produce a default log entry (2–4 rows per
turn would dominate the timeline); an extension that wants them persisted subscribes and logs them
under its own scope.

#### Scenario: Observable to extensions

- **WHEN** an extension subscribes to `turn:end`
- **THEN** it receives it in its own agent scope
- **AND** `observeAny` includes it

#### Scenario: Timeline stays quiet

- **WHEN** a normal run completes with several turns
- **THEN** the agent log contains no per-turn or per-message rows beyond the existing lifecycle rows
