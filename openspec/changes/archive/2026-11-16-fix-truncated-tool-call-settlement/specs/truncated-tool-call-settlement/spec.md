# Spec Delta

## Purpose

Defines how a tool call whose arguments never arrived is classified, settled, and shown, and how a
model response that ends mid-tool-call becomes a recorded stream failure instead of an open turn.

## ADDED Requirements

### Requirement: Zero-byte tool call is truncated, not in flight
A tool call SHALL be treated as in flight only when it carries non-empty arguments that parse. A call
whose argument text is empty or whitespace-only SHALL be classified as truncated: it MUST NOT be executed,
MUST NOT be counted as work the user cancelled, and MUST be settled with text that says the response ended
before its arguments arrived.

#### Scenario: Empty argument text is not executable
- **WHEN** a tool call at `input-complete` carries `arguments: ""`
- **THEN** it is not classified as in flight

#### Scenario: Whitespace arguments are not executable
- **WHEN** a tool call carries `arguments: "   "`
- **THEN** it is not classified as in flight

#### Scenario: Abort settles truncated calls with truncation text
- **WHEN** a run is aborted while truncated calls are present
- **THEN** each of them is persisted as complete with the truncation notice, not `Cancelled by user.`

#### Scenario: Real in-flight calls keep the user-cancel settlement
- **WHEN** a run is aborted while a call with valid arguments is executing
- **THEN** that call is still settled as a user cancellation

#### Scenario: A batch of placeholders reports no user cancellations
- **WHEN** a run is aborted after one response supplied 83 tool-call starts with zero argument bytes
- **THEN** none of the 83 rows presents the cancelled state or the `Cancelled by user.` text, even though
  the abort that ended the turn was a user abort

### Requirement: Empty-object arguments are truncated only when the schema requires input
A tool call carrying `{}` SHALL be classified as truncated when the tool's input schema requires at least
one property. When the schema requires nothing, or no schema is known, `{}` SHALL remain a valid call.

#### Scenario: Required-argument tool called with no arguments
- **WHEN** a tool whose schema requires a property carries `{}`
- **THEN** it is classified as truncated

#### Scenario: Optional-argument tool called with no arguments
- **WHEN** a tool whose schema requires no property carries `{}`
- **THEN** it is classified as a valid in-flight call

### Requirement: Truncated calls are not rendered as cancelled
A settled truncated call SHALL NOT present the cancelled state or the cancelled summary text to the host: its
presentation reports it as interrupted, and its summary names the truncation.

#### Scenario: Cancelled summary text excludes truncated calls
- **WHEN** a call settled with the truncation notice is summarized
- **THEN** it does not report `cancelled`

#### Scenario: Display text carries the notice
- **WHEN** the display payload of a truncated call is computed
- **THEN** its text is the truncation notice rather than an empty or cancelled body

### Requirement: A truncated tool-call stream ends the turn as a stream failure
A model response SHALL be finalized as a stream failure when it delivers one or more tool-call starts and
then ends without its terminal events. It MUST NOT remain running until the user aborts, and the failure
SHALL be observable in the run's event stream and status.

#### Scenario: Stream ends after tool-call starts
- **WHEN** a model response emits tool-call starts and the stream ends with no tool-call end, finish, or
  error event
- **THEN** the turn is finalized as an error, not left running

#### Scenario: A normal response is unaffected
- **WHEN** a model response reaches its terminal event
- **THEN** no synthetic stream failure is recorded

#### Scenario: An open interaction is not converted to an error
- **WHEN** the response ends while a question or approval awaits the user
- **THEN** the turn stays waiting rather than being finalized as a stream failure

### Requirement: Batch shape of a response is observable
The run log SHALL record the shape of a tool-call batch when it looks malformed — calls with no
arguments, a repeated tool name beyond a small batch, or a call count far above what one turn needs — so
that a vendor-side placeholder response can be identified after the fact without the session transcript.

#### Scenario: Malformed batch is logged
- **WHEN** a response contains several tool-call starts with empty arguments
- **THEN** one diagnostic entry records the batch's size and tool names, and never the arguments
