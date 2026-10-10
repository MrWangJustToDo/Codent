## 1. Store: build a branched session

- [x] 1.1 Add optional `forkedFrom?: string` to `SessionData` (`persistence/types.ts`)
- [x] 1.2 Add `SessionStore.branchFrom(source, { upToIndex?, name? })` returning a new `SessionData` (new id, copied model/modelStyle/reasoningEffort, `forkedFrom = source.id`, messages sliced, todos/plan/auto/window-usage reset)

## 2. Lifecycle: clone / fork and switch

- [x] 2.1 Add `branchSession(managed, { mode: "clone" | "fork", upToMessageId?, name? })` to `session-lifecycle-commands.ts`: refuse while a run is active; persist the source best-effort; resolve the fork slice; `store.branchFrom`; `store.save`; `managed.restoreSession(newId)`; return `{ sessionId, name, model, uiMessages, forkText? }`
- [x] 2.2 `clone` = all messages; `fork` = messages strictly before `upToMessageId`, and return that message's text as `forkText`

## 3. Commands

- [x] 3.1 Add `session.clone { name? }` and `session.fork { upToMessageId; name? }` to `AgentSessionCommand` (`agent-session/types.ts`)
- [x] 3.2 Handle them in `local-session-dispatch.ts` (call `branchSession`), returning the switch payload like `session.resume`
- [x] 3.3 Confirm no server change is needed (generic `/command` route forwards the command)

## 4. App commands

- [x] 4.1 Add `/clone [name]` (`packages/app/src/commands/clone.ts`): save current chat, dispatch `session.clone`, adopt the returned messages
- [x] 4.2 Add `/fork [index]` (`packages/app/src/commands/fork.ts`): picker of the current session's user messages (`getOptions`), dispatch `session.fork { upToMessageId }`, adopt messages, and refill the editor with `forkText` via `inputActions.setValue`
- [x] 4.3 Register both in `commands/index.ts`

## 5. Coverage

- [x] 5.1 Add `validate-session-branching.mjs`: `branchFrom` copies/slices/resets/records lineage; `session.clone` / `session.fork` dispatch end-to-end on a mock agent; refuse while running
- [x] 5.2 Register `validate:session-branching` in `packages/core/package.json`
- [x] 5.3 Run the full core validator suite plus typecheck/lint
