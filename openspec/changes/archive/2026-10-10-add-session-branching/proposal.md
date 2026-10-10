## Why

Codent sessions are linear and append-only: the only way to change course is `/clear` (destroys the
transcript) or `/resume` (switch to a different session). There is no way to keep the current
conversation and also try a different approach from an earlier point. pi, Claude Code, and opencode
all offer this (fork / clone / rewind), and it is the main reason long agent sessions feel
irreversible.

## What Changes

- Add **`/clone`** — duplicate the current session into a new session file and switch to it; the
  original is left intact. Use to keep a snapshot before risky work, or to run two variations.
- Add **`/fork`** — start a new session from an earlier **user** message: copy everything before it,
  switch to the new session, and put that message's text back in the editor to edit and resend — a
  divergent branch without losing the original path.
- Persist a **`forkedFrom`** lineage pointer (source session id) on the new session, so a future
  tree/trace view has the relationship even though this change does not build one.
- Reuse the existing session-switch machinery (`ManagedAgent.restoreSession`) and the generic
  remote command route (`POST /api/agent/:id/command` forwards `command: unknown`), so clone/fork
  work in `--remote-session` hosts with **no server schema change**.
- **BREAKING**: none.

Non-goals: in-place tree navigation (`/tree`) that branches within one file; per-entry labels;
context-only edits (`context_edit`); branch summaries. Those require a branch-aware channel and
projection and are a separate, larger change.

## Capabilities

### New Capabilities

- `session-branching`: cloning or forking the current session into a new session and switching to it.

### Modified Capabilities

- (none)

## Impact

- Affected code:
  - `packages/core/src/agent/persistence/session-store.ts` — build a new session from a source
    session's messages (clone / fork-at-a-message)
  - `packages/core/src/agent/persistence/types.ts` — optional `forkedFrom`
  - `packages/core/src/agent-session/session-lifecycle-commands.ts` — `cloneCurrentSession` /
    `forkCurrentSession` (persist source, write new session, switch, return messages)
  - `packages/core/src/agent-session/local-session-dispatch.ts` + `types.ts` — `session.clone` /
    `session.fork` commands
  - `packages/app/src/commands/` — `/clone`, `/fork` (fork picker + editor refill)
  - `packages/core/scripts/` — new `validate:session-branching`
