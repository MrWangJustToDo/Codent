## 1. Share the server

- [x] 1.1 Add a config-identity key (`JSON.stringify` of the resolved record, or a stable field
      tuple — pick one and use it everywhere) and make every per-server lookup derive it from the
      language id: `startingServers`, `restartAttempts`, `restartBackoff`.
- [x] 1.2 On a successful start, register the client under **every** language id whose record matches
      (not only the one that started it), so `clients.get(id)`, tool calls and `/lsp` status keep
      working; `startEagerly` and `getClientForLanguage` must see those aliases as already running.
- [x] 1.3 Make the server-scoped paths act on the group: `shutdownAll` shuts a shared client down once,
      and `handleUnexpectedExit` clears every alias of the dead client before scheduling a restart
      (otherwise three ids keep pointing at a dead client).
- [x] 1.4 Keep a document's own language on `didOpen` (already true in `file-sync.ts` — assert it rather
      than assume it in 2.3).

## 2. Deferred syncs and coverage

- [x] 2.1 `FileSync`: flush **all** pending syncs when any server becomes ready (a write deferred for
      `javascriptreact` must not wait for a ready event that will not come again), and say in the
      comment why the per-language queue is flushed as a whole.
- [x] 2.2 Assert the headline invariant at the manager: auto-starting the four TypeScript ids creates
      **one** connection (one connection = one spawned process, since the host builds one per start), and
      every id resolves the shared client. (The first draft proposed counting children with the process
      counter; counting factory calls asserts the same thing without depending on `pgrep`.)
- [x] 2.3 Assert the aliases are served (`getRunningClient` for each sharing id) and that a sharing id
      is not reported as starting a server of its own; `didOpen`'s per-file language is already pinned by
      `validate:lsp-extension` (file-sync resolves it per file).
- [x] 2.4 Assert a shared crash clears every alias and schedules exactly one restart — driven from the
      manager (the fake connection hands its `onUnexpectedExit` callback back to the test).
- [x] 2.5 Non-vacuity: registering only the starting id fails with `javascript resolves the shared
      client (alias registered)` — recorded in the commit message.

## 3. Verification

- [x] 3.1 `pnpm build:core && pnpm typecheck`
- [x] 3.2 `node scripts/run-all-validators.mjs --dir packages/core` — expect 0 failed (the LSP set
      especially: `validate-lsp-lifecycle`, `-server-probe`, `-restart-cleanup`, `-extension`,
      `-midstartup-shutdown`).
- [x] 3.3 `pnpm --filter @codent/app test`
