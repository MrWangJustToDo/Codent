## Why

The workspace browser can only *read* files: the right pane is a preview/diff view. The moment the user
spots something to fix, the TUI has nothing to offer — they must leave the app, edit, and come back. That
breaks the loop the panel exists for ("see it → change it → see the diff update") at exactly the point it
matters.

Opening the file in the user's own editor is the small version of this feature. But the obvious
implementation — unmount the UI, spawn the editor, render again — is not safe in this codebase today:
`useAgentChat`'s unmount cleanup calls `adapter.destroy()` (which disposes the runtime and destroys every
session it owns), and mounting again re-runs `adapter.destroy()` + `adapter.initialize()`, creating a
**new runtime and a new root session**. So "edit this file" would silently kill a running agent and drop
the conversation. This change therefore has to settle a lifecycle question first: the UI must be able to
detach from the terminal without ending the session it displays.

## What Changes

- The workspace browser gains an **open-in-editor action** (`e`) for the selected row, plus an optional
  line target so a diff/preview jump can land on the right line.
- `AgentAdapter` gains an optional `openInEditor?(target)` capability. The CLI host implements it; hosts
  that cannot spawn a local process (extension, WebContainer playground) omit it and the action is hidden.
- The app gains an explicit **suspend/resume**: while suspended the UI is unmounted but the runtime and
  its root session stay alive; on resume the app re-binds the session it already had instead of building a
  new one. This is the property "the UI is a projection of the session" that the app layer claims but does
  not currently enforce on unmount.
- Resuming refreshes what the editor may have changed: file-content cache, diff cache, git status, tree
  rows.
- Hosts whose workspace is remote (`--remote-env`, `--remote-session`) refuse the action: the file is not
  on this machine, so there is no local terminal to hand over.
- The suspend path reuses the existing alternate-screen ownership: the panel leaves the alternate screen
  before unmounting, so the normal screen (the chat) is never repainted during the handoff and comes back
  as the editor exits.

## Capabilities

### New Capabilities

- `workspace-editor-handoff`: opening the selected workspace file in an external editor, suspending the
  TUI for the duration, and resuming with a live session and refreshed workspace state.

### Modified Capabilities

- `app-session-only`: unmounting the UI no longer implies tearing down the agent runtime; a suspend keeps
  the session and remounting re-binds it.

## Impact

- `@codent/app`: `hooks/use-agent-chat.ts` (init/cleanup branch on suspend), `hooks/use-agent.ts` (suspend
  state + editor request), `components/WorkspaceFileMode.tsx` (`e` binding, resume refresh),
  `adapter/types.ts` (optional `openInEditor`), a pure decision helper for the lifecycle.
- `@codent/cli`: `local-adapter.ts` (capability + refusal for remote workspaces), `host.tsx` (suspend the
  ink instance, spawn the editor with inherited stdio, re-render, surface spawn errors after resume).
- `@codent/core`: no change — the spawn is host-owned on purpose. A CoreEnv capability would make the
  editor "run on the server" for remote workspaces, which is not a UI anyone can interact with.
- Other hosts: no behaviour change; the capability is absent, so the editor action does not render.
- Tests: `node:test` coverage for the lifecycle decision helper, and a PTY check of the handoff sequence
  (leave alternate screen → spawn → resume → re-enter alternate screen).
