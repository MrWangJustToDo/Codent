## ADDED Requirements

### Requirement: Approval derived from server tool annotations

The MCP client SHALL derive each server tool's approval requirement from the tool's own `annotations`, never from the server's identity:

- `readOnlyHint: true` → the tool runs without an approval prompt.
- `destructiveHint: true` → the tool is approval-gated.
- `annotations` absent, or neither hint present → the tool is approval-gated. "The server did not say it is read-only" SHALL NOT be read as evidence that it is.

A gated MCP tool SHALL use the same approval mechanism as a built-in tool (`needsApproval`), so the session approval table, TUI prompt, ACP `session/request_permission` round-trip and auto-mode controller apply unchanged.

#### Scenario: Read-only server tool runs unprompted

- **WHEN** a server declares a tool with `annotations.readOnlyHint: true`
- **THEN** the registered tool carries no approval requirement and executes without prompting

#### Scenario: Destructive server tool is gated

- **WHEN** a server declares a tool with `annotations.destructiveHint: true`
- **THEN** the registered tool requires approval before it runs

#### Scenario: Unannotated server tool is gated

- **WHEN** a server declares a tool with no `annotations`
- **THEN** the registered tool requires approval before it runs

#### Scenario: Session auto-mode still applies

- **WHEN** session auto-mode is enabled and a gated MCP tool is called
- **THEN** the call runs without prompting, exactly as a gated built-in tool does in auto mode

### Requirement: Per-server policy in configuration

An MCP server entry SHALL accept two optional fields alongside its transport:

- `enabled?: boolean` (default `true`) — a disabled server is not connected, contributes no tools, and is listed as disabled in the status summary.
- `approval?: "annotations" | "always" | "never"` (default `"annotations"`) — `"always"` gates every tool regardless of annotations, `"never"` gates none, `"annotations"` applies the derived rule above.

An unknown value for either field SHALL be a configuration error naming the server, not a silent fallback.

#### Scenario: Disabled server contributes nothing

- **WHEN** a config entry sets `enabled: false`
- **THEN** no process or connection is created for it, no `mcp__<server>_*` tool is registered, and its status reads `disabled`

#### Scenario: Approval always

- **WHEN** a config entry sets `approval: "always"` and a tool is annotated `readOnlyHint: true`
- **THEN** that tool still requires approval

#### Scenario: Approval never

- **WHEN** a config entry sets `approval: "never"`
- **THEN** none of that server's tools require approval, including tools annotated `destructiveHint: true`

#### Scenario: Invalid policy value

- **WHEN** a config entry sets `approval: "sometimes"`
- **THEN** loading fails with an error naming the server and the accepted values

### Requirement: Truthful elicitation capability

The MCP client SHALL advertise the `elicitation` capability only when it can answer an `elicitation/create` request, and the claim and the handler SHALL be made together:

- When the runtime supplies an elicit hook, the client SHALL advertise `elicitation` and register that hook as the `elicitation/create` handler.
- When no hook is supplied, the client SHALL NOT advertise `elicitation` and SHALL NOT register a handler (the protocol SDK rejects a handler for an undeclared capability). A request that arrives anyway is answered by the protocol layer with a capability error, so the request terminates and the tool call fails with that error — it SHALL NOT be left unanswered, and it SHALL NOT be treated as consent.

The hook's answer SHALL be passed through unchanged (`accept` with the collected content, `decline`, or `cancel`), and a hook that throws SHALL be treated as `decline` with the error recorded, so a failing hook cannot hang the tool call.

#### Scenario: Hook supplied

- **WHEN** the runtime supplies an elicit hook and a server sends `elicitation/create`
- **THEN** the hook is invoked with the request parameters and its result is returned to the server

#### Scenario: No hook

- **WHEN** no elicit hook is supplied
- **THEN** the initialize handshake does not advertise `elicitation`

#### Scenario: Unexpected request without a hook

- **WHEN** no hook is supplied and a server sends `elicitation/create` regardless
- **THEN** the protocol layer rejects it for the undeclared capability, the tool call ends with that error, and the client never advertises or answers something it cannot collect

#### Scenario: Throwing hook

- **WHEN** the elicit hook throws
- **THEN** the client answers `decline`, records the error, and the tool call does not hang

### Requirement: `input_required` becomes a readable tool failure

When a server answers `tools/call` with `resultType: "input_required"` (or a task reports `status: "input_required"`), the MCP client SHALL fail the tool call with a structured error that names the server, the request kind (`form` or `sampling`), and the request body. The failure SHALL be distinguishable from a generic tool error, SHALL NOT be an unhandled exception, and SHALL NOT hang the turn.

A `sampling` request SHALL be refused explicitly: this runtime offers no sampling handler, and pretending otherwise is exactly the capability lie this change removes.

#### Scenario: Server asks for form input

- **WHEN** a tool call returns an `elicitation/create` input request
- **THEN** the tool result reports the server name, kind `form`, and the requested fields, and the turn continues

#### Scenario: Server asks for sampling

- **WHEN** a tool call returns a `sampling/createMessage` input request
- **THEN** the tool result reports the server name, kind `sampling`, and an explicit statement that this runtime cannot answer it

#### Scenario: No silent hang

- **WHEN** a server's task reports `input_required` during polling
- **THEN** the tool call ends with that structured failure rather than continuing to poll

### Requirement: Status summary reports policy and capability truth

The `/mcp` status summary (and the session snapshot's `mcp.servers`) SHALL report, per server: whether it is enabled, the effective approval mode, the tool count after filtering, and — once per session — whether elicitation is available in this runtime.

#### Scenario: Disabled server listed

- **WHEN** a server is configured `enabled: false`
- **THEN** the summary lists it with status `disabled` and no tool count

#### Scenario: Elicitation availability is visible

- **WHEN** the runtime supplies no elicit hook
- **THEN** the summary states that elicitation is unavailable, so a server needing it is diagnosable from `/mcp` alone

### Requirement: Validation against the real wiring

A `validate:mcp-client` script SHALL assert the behaviours above against the options object the manager actually sends and the manager itself, not against a re-declared copy of that wiring, and SHALL require no child process and no network. It SHALL be registered in the core `validate:all` aggregate.

The script SHALL also assert that the temporary `@tanstack/ai-mcp` patch which exposes the elicit handler is installed and declared, since every elicitation behaviour depends on it and a reinstall reverts a dependency silently.

#### Scenario: Guard fails on regression

- **WHEN** the approval derivation, the elicitation handler, the capability set, or the `input_required` mapping is removed or inverted
- **THEN** `validate:mcp-client` exits non-zero naming the behaviour that broke

#### Scenario: Guard fails when the patch is gone

- **WHEN** the dependency loses the forwarded elicit handler (patch reverted, or upgraded to a release without the option)
- **THEN** `validate:mcp-client` fails on the dependency-patch check instead of passing with an option nothing reads
