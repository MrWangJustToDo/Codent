## Context

`@tanstack/ai` 0.64.0 introduced parallel tool execution (`toolExecution: "parallel"` is the
default; `"sequential"` opts out). Codent does not set `toolExecution`, so one turn's `task` calls
already execute together — the pre-fork (`agent/subagent/task-prefork.ts`) is therefore no longer a
serial-execution workaround. What it still does:

- caps how many subagent LLM loops run at once (`MAX_ACTIVE_TASK_PREFORKS = 4`), protecting provider
  rate limits;
- starts each subagent at `TOOL_CALL_END` rather than waiting for the tool phase (a small head start);
- because the SDK prepares every call's `onBeforeToolCall` before starting any tool, a queued run's
  eager start would otherwise begin the row's clock while it waits — the extensions middleware now
  defers that start for a call the coordinator already owns.

The cap is a hardcoded module constant with no per-agent override.

## Goals / Non-Goals

**Goals:**
- Make the concurrency cap settable per agent, defaulting to today's 4.
- Keep the rolling-FIFO queue semantics.
- Pin "a queued run does not start until admitted".
- Correct the now-stale "compensates sequential execution" framing.

**Non-Goals:**
- Changing the default (stays 4) or the provider/protocol surface.
- A per-tool or global (cross-agent) cap.
- Removing the pre-fork (it is the throttle).

## Decisions

- **Config field, read per admission.** Add `maxConcurrentTasks?: number` to `ManagedAgentConfig`
  (and thread it through `AgentSessionCreateOptions` → `toManagedConfig`). The coordinator reads the
  cap through a **provider function** (`() => number`) rather than a constructor snapshot, so
  `ManagedAgent.updateConfig` mid-session is honored on the next admission.
  - Alternative: snapshot the cap when the coordinator is created. Rejected — it would ignore a
    later `updateConfig`, and the coordinator is created lazily on the first `task` of a session.
- **Default stays the existing constant.** `MAX_ACTIVE_TASK_PREFORKS = 4` remains the default the
  resolver falls back to; `TaskPreforkCoordinator`'s own constructor default keeps the class usable
  stand-alone (the validator constructs it directly).
- **Clamp to `>= 1`.** A cap of 0 or a non-integer/NaN would stall or misbehave; normalize with
  `Math.max(1, Math.floor(value))` and fall back to the default on non-finite input.
- **Queued runs do not start.** The pre-fork already emits the run's `agent:tool-start` only on
  admission; the extensions middleware skips its eager `agent:tool-start` for a `task` the
  coordinator owns (`isTaskToolStartDeferred` → `peekTaskPreforkCoordinator(managed)?.has(id)`).
  This change pins the pair as the contract, since it is the user-visible half of the throttle.
- **Docs/comments repositioned.** The header of `task-prefork.ts` and the middleware now describe a
  concurrency throttle + eager start, not a sequential workaround.

## Risks / Trade-offs

- [A host sets a very high cap and trips provider rate limits] → the cap is opt-in; the default is
  unchanged, and retry/backoff already handles transient 429s.
- [Raising the cap concentrates load on one provider] → that is the host's explicit choice; the
  rolling window still serializes each agent's over-cap runs.
- [Config surface creep] → one number, one capability, with a documented default.

## Open Questions

- Expose the cap as a CLI flag / slash command in addition to programmatic config? (Deferred;
  programmatic config is enough for now.)
