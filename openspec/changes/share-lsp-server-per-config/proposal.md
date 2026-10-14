## Why

`LspManager` keys its state by **language id** — `clients`, `startingServers`, `restartAttempts`,
`restartBackoff`, `serverConfigs` — and the host builds a fresh connection per start
(`node/src/index.ts`: `createLspConnection: (config) => createNodeLspConnection({…})`). The default
configs make that visible: `typescript`, `javascript`, `typescriptreact` and `javascriptreact` all map
to the identical record `{ command: "typescript-language-server", args: ["--stdio"] }`, so a workspace
whose `.lsp.json` auto-starts all four spawns **four equivalent `typescript-language-server` processes**
at startup — the case in this repo.

Four costs, in order of how often they bite:

- **Startup**: four full TypeScript servers instead of one (CPU, memory, four `tsserver` warm-ups).
- **Noise**: four independent outcomes, so one can report a failure while another reports ready — the
  "failed, then ready" pairing that was misread as an initialization that failed and then succeeded
  (`6cd1eab4` made the outcomes honest; this removes the reason they differ at all).
- **Contention**: four handshakes in flight during bootstrap is what makes a transient start failure
  (and its silent, non-terminal retry) more likely on a busy machine.
- **Cost per edit**: every `didOpen`/`didChange` goes to one of four servers, each indexing the same
  files.

## What Changes

- **One server per identical config record.** Language ids that resolve to the same
  `LspServerConfigRecord` (command + args + env + initializationOptions + settings) share one connection
  and one process; a language whose record differs keeps its own.
- The per-server state moves to the shared identity: `startingServers`, `restartAttempts` and
  `restartBackoff` are keyed by the config, so a second id cannot start a duplicate while the first is
  in flight, and a crash restarts the one server rather than four.
- The client is registered under **every** language id that shares it, so existing per-language lookups
  (`clients.get(languageId)`, tool calls, `/lsp` status) keep working unchanged.
- Crash and shutdown act on the server, not on one alias: every id sharing a dead client is cleared, and
  `shutdownAll` shuts a shared client down once.
- A document's own language id still goes on `didOpen` (already the case — `FileSync` resolves it per
  file), so one `typescript-language-server` serves all four as editors expect.
- `FileSync` gains a flush of **all** pending syncs on a server becoming ready: a write deferred for
  `javascriptreact` must not stay queued behind a `typescript` ready event for a server that now serves
  both.

## Capabilities

### New Capabilities

- `lsp-server-sharing`: which language ids share one server process, what that means for lifecycle
  (start, crash, restart, shutdown) and for per-document language ids.

### Modified Capabilities

(none)

## Impact

- `packages/core/src/agent/lsp/lsp-manager.ts` — the state keys and the alias registration.
- `packages/core/src/agent/lsp/file-sync.ts` — flush-all-pending on ready.
- Coverage: the observable invariant is **one process for the four TypeScript ids**, asserted with the
  existing mock-server process counter, plus a tool call served through an alias and a crash clearing
  every alias.
- No behaviour change for a workspace whose configured ids do not share a record, and none for the
  language surface: the same files go to the same kind of server, one process instead of four.
