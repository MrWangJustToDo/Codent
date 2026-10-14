# lsp-server-sharing Specification

## Purpose
TBD - created by archiving change share-lsp-server-per-config. Update Purpose after archive.
## Requirements
### Requirement: One server process per identical config record

The manager SHALL run one LSP server process per identical `LspServerConfigRecord` (command, args, env,
initializationOptions, settings) and SHALL NOT start a second process for a language id whose record
matches one that is already served. A language id whose record differs SHALL get its own server.

The manager SHALL register a shared client under every language id it serves, so per-language lookups
(`clients.get(id)`, tool calls, status) keep working, and SHALL keep its per-server lifecycle state
(in-flight start, restart attempts, restart backoff) on the shared identity rather than on one id.

#### Scenario: Language ids that resolve to the same record

- **WHEN** a workspace auto-starts `typescript`, `javascript`, `typescriptreact` and `javascriptreact`,
  which map to the identical default record
- **THEN** exactly one `typescript-language-server` process is spawned, and each of the four ids reports
  the shared client as available

#### Scenario: A language whose record differs

- **WHEN** `.lsp.json` overrides one of those ids with a different command, args, or settings
- **THEN** that id gets its own server, and the ids whose records still match keep sharing the first

#### Scenario: A document's own language reaches the server

- **WHEN** a `.jsx` file and a `.ts` file are opened while one shared server serves both ids
- **THEN** each `didOpen` carries that file's own language id, not the id that started the server

#### Scenario: Lifecycle acts on the server, not on one alias

- **WHEN** a shared server crashes or the session shuts down
- **THEN** every language id sharing it is cleared (no id is left pointing at a dead client), the
  restart budget is charged once, and `shutdownAll` shuts the shared client down exactly once

#### Scenario: A deferred sync is not stranded behind an alias

- **WHEN** a write for one of the sharing ids was deferred because the server was starting, and the
  server becomes ready under another id that shares it
- **THEN** the deferred sync is flushed (the file reaches the server), rather than waiting for a ready
  event that will not come again

