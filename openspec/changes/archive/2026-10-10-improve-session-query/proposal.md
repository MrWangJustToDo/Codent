## Why

`session_search` / `session_read` return matches without saying whether a hit is still in the model's
context or was compacted away. Since compaction only *appends* a summary (the pre-cut messages stay
in the log), a search of the current session returns both the turns the model already sees and the
ones that scrolled out — with no way to tell them apart, so the model re-reads what it already has or
mistakes a compacted hit for live context. There is also no way to narrow a search by time.

## What Changes

- Annotate every search match and every `session_read` message with a `surface`:
  - `current` — the message is at/after the session's latest compaction summary, i.e. still in that
    session's model context;
  - `shadowed` — the message sits before the latest summary, i.e. compacted out of context (only in
    the log).
  A session that never compacted has all-`current` messages.
- Add an optional time window (`since` / `until`) to `session_search`, filtering by message
  timestamp.
- Do **not** add FTS5/ranking, and do **not** add session lineage (`session_trace`): codent sessions
  carry no persisted parent/fork relationship (subagents are not persisted as sessions), so there is
  no durable lineage to trace.

## Capabilities

### Modified Capabilities

- `session-search`: matches and read messages carry a `surface`; `session_search` accepts a time
  window.

## Impact

- Affected code:
  - `packages/core/src/agent/tools/session-search/session-reader.ts` — derive surface from the
    session's latest compaction summary; time-window filtering
  - `packages/core/src/agent/tools/session-search-tool.ts` / `session-read-tool.ts` — schema + output
  - `packages/core/scripts/` — extend `validate:session-search`
- Non-goals: FTS5 / relevance ranking / cursor pagination; session lineage / traces; cross-workspace
  authorization (single workspace).
