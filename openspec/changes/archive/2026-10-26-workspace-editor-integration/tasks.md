## 1. Lifecycle seam (app)

- [x] 1.1 Add the suspend flag (`beginRuntimeSuspend` / `consumeRuntimeSuspend`) and a pure decision helper
      (`shouldReleaseRuntimeOnUnmount({ suspended })`, `shouldInitializeOnMount({ suspended, hasSession })`)
      in `@codent/app`, so the branches are testable without mounting React
- [x] 1.2 Wire the helper into `useAgentChat`: cleanup skips `bindAgentSession(null, null)` + `adapter.destroy()`
      while suspended; the mount effect skips `destroy()` + `initialize()` and keeps the already-bound session;
      any real `initialize` clears the flag
- [x] 1.3 Add `node:test` coverage: fresh mount initializes, suspend + remount reuses the session, and a second
      unmount after resume still destroys

## 2. Adapter capability

- [x] 2.1 Add the optional `openInEditor?(target: { path: string; line?: number })` to `AgentAdapter`, documented
      as a host/terminal capability next to `readClipboardImage`
- [x] 2.2 Forward it through `LocalAgentAdapter` to a host callback, and refuse (with a reason) when the
      workspace env is remote

## 3. Host handoff (cli)

- [x] 3.1 Factor the CLI host's element tree into a `renderApp()` that can run twice, and keep the returned
      instance for the exit path
- [x] 3.2 Implement the handoff: suspend → unmount → `spawn(stdio: "inherit")` → re-render in `finally`, so a
      spawn failure or non-zero exit still restores the UI
- [x] 3.3 Resolve the editor (`$VISUAL` → `$EDITOR` → `nvim` → `vi`/`notepad`), split embedded args, pass
      `+<line>` for vim-family editors, and surface `ENOENT` / non-zero exit as a notice after resume

## 4. Panel wiring (app)

- [x] 4.1 Bind `e` in `WorkspaceFileMode` for files (no-op on directories), hidden when the adapter has no
      capability, and add it to the panel footer hint
- [x] 4.2 Record the editor round trip in `use-workspace-panel` and, on mount, reuse the existing `refreshAll()`
      path (content cache, diff cache, git status, tree reload) before clearing the marker
- [x] 4.3 Render the post-resume notice (editor not found, non-zero exit) in the panel footer

## 5. Verification

- [x] 5.1 PTY check of the sequence: panel open → `e` → `?1049l` + editor started → editor exits → `?1049h` +
      panel repainted, with the app still alive afterwards
- [x] 5.2 Verify a streaming run survives the suspend: the transcript continues, one session remains in the
      catalog, and a pending approval is still answerable on resume
- [x] 5.3 Run `pnpm build`, `pnpm typecheck`, the app test suite, the core validators, and eslint/prettier on
      the touched files
- [x] 5.4 Update the user-facing docs: the panel shortcut row and the adapter capability note
