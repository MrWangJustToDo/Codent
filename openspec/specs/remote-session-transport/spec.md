# remote-session-transport

## Purpose

HTTP/SSE transport contracts for remote agent sessions: the event stream envelope, default-on messages delta encoding with client patch merge, compressed seed routes, bounded tool output buffering, and diagnostic log gating.

## Requirements

### Requirement: SSE event stream contract

The agent server MUST stream session events on `GET /api/agent/:id/events` as SSE frames whose `data` is the JSON envelope `{channel, payload, ts}`, filtered by the optional `channels` query parameter, with periodic heartbeat frames.

#### Scenario: Channel filter applies
- **WHEN** a client subscribes with `channels=usage`
- **THEN** only `usage` channel events are delivered on that connection

#### Scenario: Heartbeats keep the stream alive
- **WHEN** no session events occur for longer than the heartbeat interval
- **THEN** the server writes periodic heartbeat frames and the connection stays open

### Requirement: Messages delta encoding (default)

The server MUST encode every `messages` payload on the events stream as a self-describing envelope: `{kind:"full", messages}` or `{kind:"patch", upserted, removed}`. A full payload MUST be sent when the connection has no baseline, when changes exceed half the array, and periodically as a safety net. Patches MUST carry the array `index` of every upserted message and the ids of removed messages, and MUST contain only messages that differ from the connection's last-sent baseline.

#### Scenario: First event after subscribe is full
- **WHEN** a connection receives its first `messages` event
- **THEN** the payload is `{kind:"full", messages}` covering the whole array

#### Scenario: Streaming delta sends only the changed message
- **WHEN** a text delta mutates one existing message and the rest of the array is referentially unchanged
- **THEN** the server sends a `{kind:"patch"}` whose `upserted` contains exactly that one message at its index and `removed` is empty

#### Scenario: Periodic safety-net full
- **WHEN** a connection has received more than the safety-net threshold of events since its last full payload
- **THEN** the next `messages` event is sent as `full`, and the patch baseline is rebuilt

### Requirement: Patch coalescing on the stream

The server MUST coalesce consecutive `patch` payloads per connection on a trailing-edge window (≈60 ms), merging upserts by message id and dropping upserts later removed. A `full` payload MUST bypass the window: it flushes immediately and discards pending patches. Other channels MUST NOT be delayed by the window.

#### Scenario: Burst of deltas produces one frame
- **WHEN** the session emits 10 `messages` patch events within 60 ms on one connection
- **THEN** at most one merged patch frame is written for that window

#### Scenario: Full payload is not delayed
- **WHEN** a safety-net `full` payload is due while patches are pending
- **THEN** the `full` frame is written immediately and the pending patches are discarded

### Requirement: Client patch merge

The remote session client MUST apply `messages` payloads by `kind`: `full` replaces the cached array (and revives message timestamps), `patch` splices `upserted` at their indices after removing `removed` ids, and a payload without `kind` is treated as a legacy full array (old-server tolerance). An unrecognized `kind` MUST trigger a full resync (snapshot + seeds). Subscriber callbacks MUST keep receiving the full merged array, preserving the LocalAgentSession contract regardless of the wire encoding.

#### Scenario: Patch merges without re-fetching
- **WHEN** a client receives a patch with one upserted message at index N
- **THEN** the client's cached message array is updated in place at index N and `getSnapshot()` reflects it without any HTTP refetch

#### Scenario: Subscribers still see full arrays
- **WHEN** the wire delivers a patch envelope and the client's subscriber listens on the `messages` channel
- **THEN** the subscriber receives the full merged message array, same as a local session would deliver

#### Scenario: Legacy server payload still works
- **WHEN** a new client connects to a server that predates envelope encoding
- **THEN** plain-array payloads are applied as full replacements exactly as before

### Requirement: Compressed seed routes

The heavy JSON routes (`GET /:id/snapshot`, `GET /:id/tool-buffers`, `GET /:id/summary-streams`) MUST respond with gzip content-encoding when the request accepts it, and MUST leave the SSE events route uncompressed.

#### Scenario: Snapshot shrinks on the wire
- **WHEN** a client fetches `/:id/snapshot` with `Accept-Encoding: gzip`
- **THEN** the response body is gzipped and the client's fetch decompresses it transparently

#### Scenario: SSE route stays uncompressed
- **WHEN** a client subscribes to `/:id/events`
- **THEN** the response has no content-encoding applied and frames arrive incrementally

### Requirement: Remount seeds are session-scoped

The `/tool-buffers` remount seed MUST include the root agent and only its children belonging to the root's current disk session. A child from a replaced session MUST NOT contribute command buffers, even though `autoDestroy: false` task children can remain registered after a session switch.

#### Scenario: Old session child does not seed the new conversation
- **WHEN** a root has switched from session A to session B and an A-scoped child remains registered with command output
- **THEN** `GET /api/agent/:id/tool-buffers` serves no buffer for that child's tool calls

### Requirement: Bounded tool output buffering

The server's per-agent tool output buffers MUST cap stored output at the configured byte cap with per-chunk cost independent of the accumulated size, preserving the most recent output within the cap.

#### Scenario: Large tool output does not degrade
- **WHEN** a tool streams output chunks exceeding the 256 KB cap
- **THEN** buffer updates do not re-copy the accumulated string per chunk, and `/:id/tool-buffers` returns the most recent capped output

### Requirement: Diagnostic logging gate

Verbose per-request diagnostic logging on the agent session routes MUST be emitted only when an explicit debug flag (`AGENT_SESSION_DEBUG=1`) is set.

#### Scenario: Quiet by default
- **WHEN** the server handles create/snapshot/command requests without the debug flag
- **THEN** no `[agent-diag]` lines are printed

### Requirement: Client shell snapshot usage shape

The remote session client's empty (pre-hydration) snapshot MUST use the current usage snapshot shape (`total`, `window`, `percent`, `tokenLimit`, `cost`) so consumers before first resync observe a valid shape.

#### Scenario: Shell snapshot before resync
- **WHEN** a remote client is constructed without an initial snapshot and `getSnapshot().usage` is read before resync completes
- **THEN** the usage object has the `total`/`window`/`percent`/`tokenLimit`/`cost` fields
