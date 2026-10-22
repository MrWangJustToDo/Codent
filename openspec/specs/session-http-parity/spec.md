# session-http-parity Specification

## Purpose

Parity between the in-process session handle and its HTTP transport: the same operations, the same event stream, and the same state shape regardless of whether the session runs locally or against a server.

## Requirements
### Requirement: HTTP Session matches Local contract
The HTTP AgentSession client SHALL implement the same AgentSession interface as Local, including `getSnapshot`, `dispatch`, `subscribe`, `getAgentStreamSnapshot`, `listAgentStreamSnapshots`, and optional `close`, with behavior equivalent for remount after reconnect.

#### Scenario: Summary remount over HTTP
- **WHEN** a remote client has subscribed to `summary` and later calls `getAgentStreamSnapshot(key)`
- **THEN** it SHALL return the last known stream snapshot for that key (not always null)

#### Scenario: Tool stream remount over HTTP
- **WHEN** a remote client reconnects or remounts a tool output view for an in-flight `toolCallId`
- **THEN** it SHALL be able to reconstruct current buffered output from server-provided state or cached SSE without requiring ManagedAgent

### Requirement: Catalog HTTP routes
The agent server SHALL expose catalog operations for create, list, connect/snapshot, command, events (SSE), and destroy under `/api/agent`, separate from CoreEnv `/api/fs|command|...` routes.

#### Scenario: Create via POST
- **WHEN** a client POSTs to `/api/agent` with create options
- **THEN** the server SHALL create an in-process agent, bind a Local Session, and return `{ id, snapshot }`

#### Scenario: Child id works on same routes
- **WHEN** a subagent exists on the server
- **THEN** `GET /api/agent/:childId/snapshot` and SSE/command routes SHALL work for that id

### Requirement: Remote Host factory
`@codent/server` SHALL export `createRemoteSessionHost(baseUrl)` (name may vary) that implements AgentSessionHost over HTTP.

#### Scenario: App uses remote host only
- **WHEN** CLI/extension is configured with `--remote-session`
- **THEN** the app SHALL run using only the HTTP Host + Session without registering ManagedAgent in the UI process

