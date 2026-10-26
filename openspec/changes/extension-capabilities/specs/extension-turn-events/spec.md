## ADDED Requirements

### Requirement: Turn boundaries are explicit events

A runtime turn (one model request plus the tool calls it requested) SHALL open with a `turn:start`
event carrying at least its 1-based index and the run's iteration budget, and SHALL close with a
`turn:end` event carrying the same index, the finish reason, and how many tool calls the turn issued.

The boundary is the **iteration**, not the engine invocation: one `chat()` may contain several
turns, and an iteration that pauses for approval closes exactly once (the engine's second,
interrupt-shaped completion chunk is not a second turn end).

`turn:end` fires when the model's response is finished, **before** the turn's tool calls execute; a
consumer that wants post-tool state reads `ctx.getMessages()` after the tool phase, not here.

`agent:iteration` SHALL remain the retained progress projection (`{ current, max }` on the
`iteration` channel); it MUST agree with `turn:start` on the index, and consumers that need the
boundary pair MUST NOT have to interpret a projection to get it.

A consumer MUST be able to pair the two events by index, and a turn that ends without a tool batch
MUST still emit `turn:end`.

#### Scenario: Pairing by index

- **WHEN** a run enters turn 3
- **THEN** `turn:start` reports index 3 with the iteration budget
- **AND** `agent:iteration` reports `{ current: 3, max }`
- **AND** when that turn finishes, `turn:end` reports index 3 with its finish reason

#### Scenario: Tool-only turn

- **WHEN** a turn finishes by requesting tools
- **THEN** `turn:end` reports that finish reason and the number of tool calls

#### Scenario: Aborted turn

- **WHEN** a run is aborted mid-turn
- **THEN** the `turn:start` already emitted is not retracted
- **AND** the turn is not reported as completed by `turn:end`
- **AND** the run's own terminal event still fires

#### Scenario: A restarted attempt keeps the run's first output

- **WHEN** a run is retried after a recoverable failure (the engine is re-entered, iterations restart)
- **THEN** the retried attempt's turns are reported again from index 1
- **AND** `firstOutput` is not reported again: it belongs to the user turn, not to one attempt

### Requirement: Assistant message boundaries are observable

The runtime SHALL emit `message:start` when an assistant message begins streaming and
`message:end` when it is finalized, both carrying at least: the role, a message id, and whether the
message is the run's first assistant output. The id is the streaming chunk's when the provider
supplies one, and an event-scoped fallback otherwise (a tool-call-only message has no upstream id). `message:end` SHALL carry the message's finalized
assistant text and its tool-call count, and SHALL fire for messages that end with tool calls as well
as text. (The wire form of a content part belongs to the UI channel; the event reports what an
extension reasons about.)

#### Scenario: Events are notifications, not barriers

- **WHEN** an extension starts a model call from a `message:start` handler
- **THEN** the run does not wait for it (observer dispatch is synchronous and fire-and-forget)
- **AND** a failure surfaces as `agent:extension-error` rather than a failed turn

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

`turn:start`, `turn:end`, `message:start` and `message:end` SHALL be classified `observable` so
extensions can subscribe and `observeAny` delivers them. They SHALL NOT produce a default log entry (2–4 rows per
turn would dominate the timeline); an extension that wants them persisted subscribes and logs them
under its own scope.

#### Scenario: Observable to extensions

- **WHEN** an extension subscribes to `turn:start` or `turn:end`
- **THEN** it receives them in its own agent scope
- **AND** `observeAny` includes all four events

#### Scenario: Timeline stays quiet

- **WHEN** a normal run completes with several turns
- **THEN** the agent log contains no `turn:*` or `message:*` rows beyond the existing lifecycle rows
