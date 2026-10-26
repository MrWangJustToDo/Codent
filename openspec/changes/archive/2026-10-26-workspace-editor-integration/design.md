## Context

The workspace browser is `WorkspacePanel` → `PanelOverlay` + `WorkspaceFileMode`: a file tree on the left,
and a right pane whose `mode` is `"preview" | "diff"` (`CodeView` / `DiffView` from `@git-diff-view/cli`).
Both are read-only. The panel also owns the terminal's alternate screen
(`setOptions({ isAlternateBufferEnabled: true })` on mount, off on unmount) and disables xterm's
alternate-scroll translation so the wheel drives the focused pane.

The lifecycle that makes a naive handoff unsafe lives in `hooks/use-agent-chat.ts`:

- mount effect: `await adapter.destroy()` → `await adapter.initialize(config)` → `bindAgentSession(...)`.
  `LocalAgentAdapter.initialize` builds a **new** `CodentAgent` and `createAgentSessionFromConfig` creates a
  **new** root session.
- unmount cleanup: `bindAgentSession(null, null)` → `adapter.destroy()` →
  `CodentAgent.dispose()` → `host.destroy(id)` for every session the runtime owns, then `manager.dispose()`.

So `ink.unmount()` today means "dispose the runtime and lose the conversation", and mounting again means
"build a new runtime and a new session". An external editor handoff is therefore only possible if the app
learns to suspend.

Renderer facts established by PTY probes against `@my-react/react-terminal` (the same fork Gemini CLI uses):

- `instance.unmount()` ends synchronized output, restores the cursor and **does not erase** the frame it
  painted; raw mode is released by the unmount.
- a fresh `render()` paints a complete new frame.
- `setOptions({ isAlternateBufferEnabled })` toggles the alternate buffer at runtime, which is how the
  panel already enters and leaves it.

## Goals / Non-Goals

**Goals:**

- Open the selected workspace file in the user's terminal editor from the panel, and come back to a live
  session with the workspace state refreshed.
- Keep the session and any in-flight run alive across the handoff, so "edit while the agent works" is real
  and not a euphemism for "kill the run".
- Degrade cleanly: hosts that cannot spawn (extension, WebContainer playground) and workspaces that are
  remote show no action instead of a broken one.

**Non-Goals:**

- An embedded editor pane (the `neovim-ink` route: `nvim --embed` + msgpack-rpc grid rendering). It needs a
  duplex-binary-process capability, a raw input surface and a mouse-mode switch, none of which exist; it is
  the follow-up once this loop is proven.
- Remote workspaces. The file is not on this machine and no terminal is attached to the server.
- A new `CoreEnv` capability. The editor belongs to *this* terminal, not to the workspace provider.
- Editing UX inside the TUI (inline editing, save prompts). The TUI stays a viewer.

## Decisions

### Suspend is an explicit host request, not an inferred condition

`@codent/app` gains a tiny module-level lifecycle flag with `beginRuntimeSuspend()` / `consumeRuntimeSuspend()`
(the host reaches it the same way it already reaches `clearAgentStore`). The `useAgentChat` cleanup asks that
flag before unbinding and before `adapter.destroy()`; the mount effect asks it before `destroy()` +
`initialize()` and, when set, keeps the already-bound session and skips both.

Why a flag rather than "the store still has a session": a genuine exit also leaves a session in the store for
the instant the cleanup runs, so that predicate would suppress teardown on every ordinary exit and leak the
runtime. The flag is one bit written by the one caller that knows the unmount is temporary.

Why not on the adapter (`adapter.isSuspended()`): it would put a UI-lifecycle question on the host
capability surface, and a host that crashes mid-handoff would leave the flag stuck.

The flag is consumed by the mount effect that resumes. Any other `initialize` run clears it, so a stale bit
can never suppress a later real teardown.

### The host owns the spawn and the process handoff

`AgentAdapter` gains an optional `openInEditor?(target: { path: string; line?: number }): Promise<void>`,
next to `readClipboardImage` — same kind of capability: a property of this terminal, absent on hosts that do
not have one.

The CLI implements it in `host.tsx` (which already holds the ink instance for the exit path) and hands it to
`LocalAgentAdapter` exactly like `exit`:

1. `beginRuntimeSuspend()`
2. `inkInstance.unmount()` — releases the alternate screen and raw mode, which is precisely the terminal
   handover
3. `spawn(editor, args, { stdio: "inherit" })`, awaited
4. `renderApp()` again in a `finally`, so a spawn failure or a non-zero exit still brings the UI back
5. report the failure as a notice through the app store (the panel footer), never by writing to the terminal

Why not a `CoreEnv.runInteractive`: with `--remote-env` it would run the editor on the server, where nobody
can type into it — the one thing the feature must not do. Keeping it on the host also means the browser hosts
cannot even mount the code path.

### Screen handoff rides on the panel's existing alternate-screen ownership

The suspend path is entered from the panel, which owns the alternate screen. Unmounting leaves it, so the
editor starts on the normal screen where the chat is simply *there*, untouched (the alternate screen never
overwrote it). On resume the panel's own mount effect re-enters the alternate buffer and paints fresh, so no
duplicate or stale frame is produced. No new screen handling is introduced; the only requirement is that the
handoff happens while the panel is open, which is the only entry point.

### Resume invalidates what the editor may have written

File content, per-file diff, git status and tree rows are all module-level caches that survive an unmount.
The panel records the round trip (`{ path }`) in its store before suspending; on mount, `WorkspaceFileMode`
sees it and reuses the existing `refreshAll()` path (cache clears + reload + `refreshGit`), then clears the
marker. One mechanism, already used by the `r` key, so the "edited file shows new content" and "git picks up
the change" requirements share code with manual refresh.

### Editor resolution

`$VISUAL` → `$EDITOR` → `nvim` → `vi` (POSIX) / `notepad` (Windows). The value is split into executable +
leading args (so `code -w` works); `shell: true` on Windows only. A known line is passed as `+<line>` for the
vim family and omitted otherwise. `spawn` errors (`ENOENT`) and non-zero exits are surfaced as a notice after
resume.

## Risks / Trade-offs

- **Suspend flag leaks, so a later real teardown skips `destroy`** → the mount effect that resumes consumes
  it, and any `initialize` clears it; a test asserts that a second unmount after resume still destroys.
- **Remount loses component-local state** (cursor index, view refs, caches) → everything that matters is in
  stores; acceptance is "the panel comes back on the same file", not "pixel-identical".
- **The run finishes while the UI is down** → the transcript is repopulated from the snapshot on resume (the
  same path a session switch uses); no special casing.
- **A renderer that repaints on resume creates a duplicate frame** → the handoff never paints on the normal
  screen; resume re-enters the alternate buffer. The PTY task verifies the byte sequence.
- **Editor command with arguments** → naive space splitting; documented limitation rather than a shell.
- **Remote workspace shows the action** → the capability is only wired for a local env; `openInEditor`
  also refuses defensively with an explanation.
- **Windows** → `shell: true` and `notepad` default; untested on CI (POSIX hosts only).

## Migration Plan

Additive and host-gated. No persisted state, no data migration. Browser and WebContainer hosts keep today's
behavior because they never provide the capability. Rollback is removing the key binding and the capability.

## Open Questions

- Whether `e` should be disabled while a run is streaming. The design says no (that is the point), but the
  behavior needs observation before it is documented as intentional.
- Whether resume should refresh only the edited file or the whole tree. `refreshAll()` is one call and
  already correct; a targeted refresh is a later optimization.
