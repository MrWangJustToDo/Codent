## Why

`@tanstack/ai` 0.64.0 changed tool execution: one turn's server tools now run **at the same time**
(default `toolExecution: "parallel"`; opt out with `"sequential"`). Before that, `chat()` ran them
one after another — which is what the `task` pre-fork was built to work around. The pre-fork's job
has therefore changed: it is now a **concurrency throttle** (keep N parallel `task` calls from
opening N provider streams at once) plus a slight head start, not a serial-execution workaround.

Two problems follow:
- The throttle is a hardcoded constant (`MAX_ACTIVE_TASK_PREFORKS = 4`). A host with a high
  provider/quota budget cannot raise it; a host on a tight quota cannot lower it.
- The pre-fork is documented as compensating sequential execution — stale since 0.64.0 — and the
  queued-run behavior (a run that has not started must not start, or start its clock) is implicit.

## What Changes

- Add `ManagedAgentConfig.maxConcurrentTasks?: number` — the max `task` subagents running
  concurrently per parent agent. Default `4` (the current constant), clamped to `>= 1`; thread it
  through `AgentSessionCreateOptions` so hosts can set it.
- The pre-fork coordinator honors the configured cap (rolling FIFO: runs beyond the cap queue and
  roll forward as slots free).
- Pin the behavior that a **queued run neither starts nor emits its start until admitted** (so a
  waiting task's row does not time).
- Correct the pre-fork docs/comments: since 0.64.0 it is a concurrency throttle + eager start.

## Capabilities

### New Capabilities

- `task-concurrency`: the cap on concurrently running `task` subagents per parent, how it is
  configured, and the guarantee that a queued run does not start until admitted.

### Modified Capabilities

- (none)

## Impact

- Affected code:
  - `packages/core/src/managers/managed-agent.ts` (`ManagedAgentConfig`) and
    `packages/core/src/agent-session/host-types.ts` (+ `local-agent-session-host.ts` mapping)
  - `packages/core/src/agent/subagent/task-prefork.ts` — coordinator takes the cap
  - `packages/core/src/managers/middleware/task-prefork-middleware.ts` — docs only
  - `packages/core/scripts/validate-task-prefork.mjs` — extend
- Non-goals: changing the default cap or the remote-session protocol; a per-tool cap.
