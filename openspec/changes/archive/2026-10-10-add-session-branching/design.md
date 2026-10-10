## Context

A session is one append-only JSONL log (`.agents/sessions/<id>.session.jsonl`); `ManagedAgent`
holds the live `SessionData` and an `AgentUIChannel`, and the session is switched mid-flight by
`ManagedAgent.restoreSession(id)` (used by `session.resume`). `/clear` (`session.new`) resets the
current agent to a fresh session via `startNewDiskSession`.

The remote path is generic: the client dispatches an `AgentSessionCommand`, and
`POST /api/agent/:id/command` forwards it to `session.dispatch(command)` with no per-command schema.

There is no way today to keep the conversation and branch it. The live channel
(`AgentUIChannel` over a TanStack `StreamProcessor`) is **linear** — it folds messages by id — which
is why in-place tree branching (`/tree`) is out of scope here: it would require a branch-aware
channel and projection.

## Goals / Non-Goals

**Goals:**
- Let the user keep the current session and start a divergent one — clone (duplicate) and fork
  (from an earlier user message).
- Reuse the existing session-switch path; add no new storage format and no server schema.
- Record lineage so a future tree/trace view is possible.

**Non-Goals:**
- In-place branching within one file (`/tree`), per-entry labels, `context_edit`, branch summaries.
- Editing/rewriting an earlier message in place.

## Decisions

- **New session per branch, not a tree.** Clone/fork write a *new* `.session.jsonl` and switch to
  it. This captures the user-visible value (explore an alternative without losing work) while the
  channel, projection, and compaction stay linear. Alternative (full entry tree à la pi) rejected:
  it redefines the session data model and the channel, far larger than this tier.
- **Reuse `restoreSession` for the switch.** After writing the new session, call the same
  `ManagedAgent.restoreSession(newId)` path as `session.resume`, so the log-sink rebind, approval /
  ask_user reconciliation, media hydration, and old-session ownership release are not re-implemented.
- **`/fork` copies strictly *before* the chosen user message.** Matching pi: the chosen message is
  not carried into the new branch; its text is placed back in the editor so the user edits and
  resends, producing the divergent turn. Cloning is the "copy everything" case.
- **Read the branch source from the live channel.** Build the new session from
  `managed`'s current messages (persisting the source first is best-effort), so unsaved turns are
  included rather than the last-known disk state.
- **Deliberate state split.** Copy model / modelStyle / reasoningEffort (the branch continues under
  the same settings); reset window usage, todos, and plan/auto (they describe the abandoned line of
  work); record `forkedFrom` (source id).
- **Refuse while a run is active**, like `compact` — a mid-run channel is a half-finished turn and
  the fork point would be ambiguous. Requires stopping first.
- **App owns the fork picker and editor refill.** The command lists the current session's user
  messages from `getMessages()`; on selection it dispatches `session.fork { upToMessageId }` then
  sets the editor text via `inputActions.setValue(text)`. The core never touches the editor.

## Risks / Trade-offs

- [Duplicated sessions double disk usage] → acceptable; sessions are small text; the user can delete.
- [Fork point by message id, but ids are opaque to the user] → the app picker shows message text and
  index; `/fork <n>` accepts a 1-based index as a shortcut.
- [Switch loses the original's live view] → the original is on disk and `/resume`-able; clone/fork
  switch away by design (matching pi).
- [Remote host: the client must refresh after the switch] → the command returns `{ sessionId, name,
  model, uiMessages }` like `session.resume`; the app sets messages from it.

## Open Questions

- Should `session_read`/`session_search` surface `forkedFrom` lineage? (Deferred — this change only
  records it; the tree/trace view is the follow-up.)
- Name suffix: `" (clone)"` / `" (fork)"` — cosmetic, adjustable.
