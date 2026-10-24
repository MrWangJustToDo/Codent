# Change: Discard a `task` pre-fork as soon as its call is rejected

## Why

The pre-fork starts a `task` subagent at `TOOL_CALL_END` — before the tool phase, which is where a
call can still be refused. Every refusal path (an extension's `tool:before:task` interceptor setting
`event.skip`, the plan-mode gate, TanStack's own tool cache) settles the call with a synthesized
result and never runs `execute`, so nothing joins the eager run. Discarding is currently a
*run-boundary* duty (`onFinish` with nothing pending, `onAbort` / `onError`, agent abort/reset), so
the rejected call's subagent keeps exploring — paying for a full child run and holding a concurrency
slot — until the turn (or the run) ends, and is then reported as an orphan the reject already
explained.

Verified: a skipped call reaches `onAfterToolCall` with `ok: true` and `duration: 0`
(`@tanstack/ai`'s `applyBeforeToolCallDecision` pushes the skip result through
`pushResultAndRunAfterHook`), which makes the tool phase the one place that sees *every* refusal
without knowing which middleware made it.

## What Changes

- **A per-call discard primitive.** `TaskPreforkCoordinator.discard(toolCallId, cause)` drops one
  registered run (dequeuing it when it never started), cancels it, and reports the same
  `PreforkDiscard` record `abortAll` produces — so the orphan is still named in the log.
- **The tool phase discards an unjoined run.** `task-prefork` gains an `onAfterToolCall` hook: if a
  `task` call settles while its run is still registered, that run is discarded with the new
  `tool-rejected` cause. A joined run was already dropped by `join`, so this fires only for calls
  whose `execute` never ran — and it covers every rejection source, including ones that do not exist
  yet, instead of enumerating middleware.
- **The cause is reported, not inferred.** `subagent:prefork-discarded` carries
  `cause: "tool-rejected"`, so a log reader can tell a refused call from a run that ended.

Not a breaking change: no API, tool-output, or telemetry-shape change; a rejected call's model-facing
result is exactly what it was.

## Capabilities

### New Capabilities

- (none)

### Modified Capabilities

- `task-concurrency`: a pre-fork whose call is rejected is discarded at the tool phase rather than at
  the next run boundary.

## Impact

- Affected code:
  - `packages/core/src/agent/subagent/task-prefork.ts` (`discard`, the `tool-rejected` cause)
  - `packages/core/src/managers/middleware/task-prefork-middleware.ts` (`onAfterToolCall`)
  - `packages/core/scripts/validate-task-prefork.mjs` (unit + driven-hook coverage)
