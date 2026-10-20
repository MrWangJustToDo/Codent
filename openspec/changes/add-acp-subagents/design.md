# Design — ACP subagent exposure

## Context

`@codent/core` already carries everything this feature needs:

- `AgentSessionChannel` includes `subagents` in the default subscription set
  (`agent-session/types.ts`), emitted from `session:subagents` on every state change and retained.
- `AgentSessionSubagentSummary` carries `id`, `status`, `name`, `description`,
  `parentTaskToolCallId`, `taskPhase` and `usage`.
- `AgentSessionHost.connect(agentId)` resolves a child agent id in both hosts
  (local: `manager.getAgent`; remote: `GET /api/agent/:id` → server `getSession` → `manager.getAgent`).
- The parent's `task` tool row already persists the result object
  (`summary / truncated / iterations / reachedLimit / incomplete / aborted / usage / cachedOutputPath`)
  and core formats it with `formatTaskOutput` for the TUI.

The ACP host drops all of it today:

- `projector.onSummary` returns for any summary source other than `compact`.
- `projector.onEvent` has no `subagents` case.
- `initialize` never reads `clientCapabilities.subagents`.
- A completed `task` call is published as `tool_call_update` with `rawOutput` = the result object.

`@agentclientprotocol/sdk@1.8.0` exposes the missing protocol surface (`types.gen.d.ts`):

| Capability / update | Meaning |
|---|---|
| `ClientCapabilities.subagents` | `{}` (or any object) = the client understands child associations, work-state snapshots and session-directed messages |
| `subagent_update` | announced on the **parent** session; first update for an unknown `sessionId` must precede any child traffic; later updates patch fields |
| `session_message` / `session_message_chunk` | inter-session message (sender / recipient session ids), streamed as chunks |
| `StateUpdate` | whole-object snapshot: `running` / `requires_action` / `unknown` / `idle` + `stopReason` (`end_turn` / `cancelled` / `error` / …) |

All of it is **UNSTABLE** in the SDK; the feature must stay isolated behind one projection module so a
protocol revision is a one-file change.

## Goals / Non-Goals

**Goals**

1. A capable client sees each `task` delegation as a child session: announced on the parent, with a
   live work state and its own transcript.
2. The parent's `task` row shows a readable result (core's formatter), not raw JSON — with or without
   the client capability.
3. A non-capable client sees exactly today's behaviour (task rows only), and never receives a child
   frame.
4. Child sessions remain parent-owned: no catalog entry, no top-level control, no destruction by
   `session/close`.

**Non-Goals**

- Child mutations (`capabilities.cancel`) in this change.
- Replaying a child's history on `session/load`/`resume` (a child has no disk session).
- Changing core's `task` output contract or the subagent lifecycle.
- A parent→child user prompt channel (the task prompt is a `session_message`, not a new user turn).

## Decisions

### D1. Capability gate covers child traffic only

`initialize` records `clientCapabilities.subagents` (`null`/absent = unsupported; an object, including
`{}`, = supported). When unsupported:

- no `subagent_update`, no child-session `session/update`, no `session_message(_chunk)`;
- the parent's `task` row still closes with the formatted result (it is a normal `tool_call_update`).

The gate is checked at the emitter, not at the call sites: a single `subagentGate` option on the
projector/child-projector, so a new child frame cannot bypass it.

### D2. Announcement precedes child traffic, deterministically

Channel order is not a guarantee: the parent's `subagents` snapshot and the child's own retained
messages are independent subscriptions, and `session.subscribe` delivers retained values on attach.

The `subagents` channel payload is `{ subagents: AgentSessionSubagentSummary[] }`, and the list
**includes internal workers** (compaction / memory summarizers). Core already ships the filter for
"user-visible delegation": `isUserVisibleTaskRow(row)` (non-empty `parentTaskToolCallId`). Only those
rows are announced; internal workers are an implementation detail of the parent and stay invisible.

The host therefore announces **before** attaching a child projector:

1. handle the `subagents` snapshot synchronously (retained delivery happens inside `subscribe()`, so
   this runs during the parent projector's `start()`);
2. for each new user-visible row, `subagent_update` on the parent;
3. only then create the child projector (`host.connect(childId)` + projector start), whose retained
   messages replay after the announcement.

A child whose projector is already attached is patched, never re-announced.

`session/new` queues session updates until the response frame carries the id (`deferEmits`). A child
attached inside that window would emit from its OWN projector queue and beat the parent's announcement,
so the attach callback is deferred with the announcements and runs immediately after
`flushDeferred()` — announcement first even for a session created in this window.

The host is handed **every** snapshot, not only a changed row set: `connect()` may transiently return
null (a child destroyed between the manager snapshot and the connect, or a remote eviction), and the
next snapshot must retry. The attach itself is idempotent by `bridge.subagents`.

A reconnect (`session/load`/`resume`) re-establishes the associations: announcements are re-sent after
the response, with the existing child projectors kept (no transcript replay). A `fork` re-keys the
parent id, so it stops the old child projectors and re-announces under the new id; the child history
is not replayed. The one-shot "attach without replay" flag is cleared once the initial subscription
has been delivered, even when the retained child list is empty — otherwise the first delegation after
a load attached without replay and lost its prompt.

### D3. State comes from `AgentStatus`; `taskPhase` is metadata

| `AgentStatus` | ACP state |
|---|---|
| `running` / `thinking` / `responding` / `compacting` | `running` |
| `waiting` / `awaiting_user` | `requires_action` |
| `completed` | `idle` + `stopReason: "end_turn"` |
| `aborted` | `idle` + `stopReason: "cancelled"` |
| `error` | `idle` + `stopReason: "error"` |
| `idle` | `idle` (no stop reason) |

`taskPhase` (`running` / `summary` / `limit`) is **not** a state: `limit` is a task outcome while the
child's own status is already `completed`, and `summary` is still the parent-owned side-LLM writing a
progress report. Forcing it into `state` would either claim work that is not the child's or hide the
fact that the run finished. It travels as `_meta.taskPhase` on the announcement/patch instead.

`SubagentUpdate.capabilities` is omitted (no child mutations). `title` = `description` when present,
else `name`, else the task call's `prompt` stub; `description` is the delegation description.

### D4. Child transcript reuses `AcpProjector`

Each child gets a projector whose `emit` targets the **child's** session id. Its options:

- `commands: () => ({ builtin: [], extension: [] })` — a subagent has no command surface;
- `client.compaction` follows the client capability: subagents inherit the parent's compaction
  config, so a long child run CAN compact and its `compaction_update` belongs to the child session;
- `client.notices` follows the client capability (a failed child run can still be reported);
- no `onInteraction` — subagents have no approvals and no `ask_user`;
- `onState` omitted (the child's run finish reason does not affect the parent turn);
- `start({ seedState: false })` — mode / commands / title seeding belongs to top-level sessions;
  the child's messages are replayed explicitly after the announcement (the resume/mode seed for a
  child would advertise selectors that do not exist).

The prompt conversion needs a seam in the projector, not a post-filter: `emitMessages` would otherwise
publish the child's first user message as `user_message_chunk` on its first `messages` event, and
`replayFrom` would do the same on (re)attach. The child projector therefore receives the prompt's
message id (derived from `parentTaskToolCallId`) and projects **that id** as `session_message`
(sender = parent) in both the live and replay paths.

The child's first user message is the task prompt (`runSubagent` seeds the child channel with
`{role:"user"}`). It is published as `session_message` (`senderSessionId` = parent, `recipientSessionId`
= child, `messageId` derived from the task tool-call id passed in with the row) instead of
`user_message_chunk`, because the child's turn was initiated by the parent, not by a user of that
session. The same conversion applies to the child's initial replay, not only to the live stream. The
child's own assistant text / thinking / tool calls keep their normal updates under the child session
id.

### D5. The task result has ONE surface: the parent's `task` row

The summary stream (`source: "task"`, keyed `task:<toolCallId>`) is the **parent-facing result**, not a
child message. Publishing it as `session_message` from the child would create a second copy of a
report the child did not necessarily author (the progress fallback is a parent-owned side-LLM).

- final content: `tool_call_update` on the task call using the public `formatToolOutput(output, "task")`
  (it delegates to the task formatter: summary + the `[n iterations, x tokens, limit reached]` status
  line);
- live streaming (if enabled): `tool_call_update` on the same row, following `run_command`'s mechanism
  — accumulate the chunks in a buffer and re-send the **whole** text on each (throttled) update,
  because ACP tool `content` REPLACES what the client holds; there is no append form. Never a second
  row, never a duplicate message.
- ordering: the stream's `end` and the tool result are independent; the result path emits the final
  formatted content exactly once, and `end` only stops streaming. Neither order may produce two copies,
  and once the result has been emitted a late chunk is dropped — otherwise it would replace the
  terminal content with a partial buffer.
- `formatTaskOutput` is only used when the output is a task object; a non-task tool result keeps the
  existing path.

This deliberately differs from the alternative in the review (`session_message_chunk` for the summary):
a `session_message` is a message **between sessions**, while the task result is the parent's tool
result. Using both would duplicate the text and split who owns it.

### D6. Child sessions are parent-owned

- `session/list` does not include children (they have no disk session; the catalog stays unchanged).
- `session/load` / `resume` / `prompt` / `fork` with a child id are refused (`invalid params`): a child
  cannot be resumed from disk, and a prompt would inject a user turn into a delegation.
- `session/close` / `delete` with a child id must never destroy it. `close` is already idempotent when
  no bridge matches (child bridges live elsewhere), and `delete` must be screened before it reaches the
  store: `LocalAgentSessionHost.deleteSession(id)` looks up `manager.getAgent(id)` — which DOES match a
  child agent id — and would destroy the child before deleting a (non-existent) log. The ACP catalog
  therefore rejects a child id as an unknown session instead of passing it through.
- Child-id detection has two sources, both already available: the announced `childBridges` map, and
  `AgentSessionHost.list()` entries with a `parentId` (the local host and the server catalog both carry
  it). The catalog screen uses the latter, so a stale id from a previous bridge cannot slip through to
  `deleteSession`; `load`/`resume`/`fork` are screened in the same helper before `host.create`.
- Child bridges live in a separate `childBridges` map keyed by parent bridge; `closeBridge(parent)`
  stops their projectors and the parent's `stop` cascades to the children through core, but the host
  never calls `host.destroy(childId)`. Core owns child destruction.
- `findBridge` (top-level handle lookup) never consults `childBridges`, so a child id cannot be
  mistaken for a top-level handle or a disk session id.

### D7. Resume and load

`session/load` and `resume` seed the parent projector from the retained `subagents` snapshot: each
live child is announced once, and a child projector may be attached **without** `replayFrom` so live
updates continue. No child history is replayed (there is no disk session to read). Children from a
previous process are gone; the parent's `task` rows already carry their results.

## Risks / Trade-offs

- **UNSTABLE protocol** — `subagent_update` / `StateUpdate` are experimental and may change. One
  projection module (`subagent-projection.ts`) plus one child-projector factory isolates the surface;
  the rest of the host consumes a small internal shape.
- **Two surfaces for one delegation** (child transcript + parent task row). D5 makes the task row the
  result of record and the child session the exploration view; the README must say so.
- **Ordering** — announcement-before-traffic is a MUST; D2 implements it explicitly rather than relying
  on channel order, and the validator asserts it.
- **Duplicate summary text** — avoided by D5 (one row, replacement semantics, result-once). If a client
  wants a message-style report, it can render the task row; no protocol-level duplication.
- **Internal workers** — the `subagents` snapshot includes compaction/memory summarizers; announcing
  them would leak parent internals as child sessions. `isUserVisibleTaskRow` is the filter, asserted by
  the validator (a summarizer must produce no `subagent_update`).
- **Parent close race** — a child update may arrive while the parent is closing. The child projector's
  emit checks the parent bridge's `closed` flag (and the gate), then drops.
- **Resume** — no child replay means an ACP client that reconnects mid-delegation sees the child
  announcement again (retained snapshot) but not its past messages. Documented as a limitation.

## Migration

- No persisted format changes: child state is in-memory, and the parent session JSONL is untouched.
- Non-capable clients: no wire change except the task row's content (now formatted instead of raw JSON)
  — an improvement, not a breaking change.
- `capabilities.cancel` can be added later without changing this shape (supply `{}` on the announcement
  and route `session/cancel` to the child).

## Resolved Questions

- **Live task-summary streaming** rides `tool_call_update`, which every client that renders tool rows
  already supports; it is on by default when `subagents` is supported. There is no standard capability
  for fine-grained streaming, so inventing one would be a private extension.
- **A completed child stays announced** (the client keeps its history row). Clearing `state` does not
  imply idle, and dropping the announcement would erase the outcome the row describes; a destroyed
  child simply stops receiving patches.
