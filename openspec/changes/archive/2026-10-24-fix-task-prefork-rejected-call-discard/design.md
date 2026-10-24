# Design: discard a rejected `task` pre-fork where the call settles

## D1. Trigger on "settled but still registered", not on the rejection source

Three middlewares can refuse a `task` call today (an extension `tool:before` interceptor, the
plan-mode gate, TanStack's tool cache), and each returns its own skip shape from its own hook. Hooking
the refusal sites would mean editing all three and remembering the fourth. The tool phase instead
sees one signal that is true for all of them: the call settled, and the coordinator still holds a run
for its id.

That signal is unambiguous because the healthy path removes the entry itself — `join()` deletes it
before awaiting the run. So "still registered at `onAfterToolCall`" means exactly "`execute` did not
join this run", which is the definition of a call whose eager start is now orphaned.

`info.ok` cannot be used: a skip settles through `pushResultAndRunAfterHook` with `ok: true` and
`duration: 0` (@tanstack/ai `tools/tool-calls.ts`), i.e. a refused call is indistinguishable from a
successful one by its result.

## D2. A per-call discard, next to `abortAll`

`abortAll` throws away every registered run — right for a boundary where the whole attempt is over,
wrong for one refused call, where the sibling calls of the same turn are healthy and about to be
joined. `discard(toolCallId, cause)` is the same body narrowed to one entry, and reuses the queue
semantics `abortAll` established: an entry that never took a slot is removed from `waiting` and its
gate opened, so `drive()` settles it with the stale stub instead of the run starting later.

## D3. Why `tool-rejected` and not `run-finish`

The cause is what a log reader has to reconstruct the story from. `run-finish` means "the turn ended
and nobody joined"; a refused call ended *because it was refused*, and its subagent was cancelled
mid-exploration. Reusing `run-finish` would leave the two indistinguishable in
`.agents/logs/<sessionId>/agent.log`, which is the only place this is observable after the fact.

## D4. What this does not fix

`abortAll` and `discard` both cancel the child and leave it registered in the agent catalog
(`autoDestroy: false`) until the session is torn down — a separate finding. This change makes the
cancellation happen at the right moment; reclaiming the catalog entry is its own concern.
