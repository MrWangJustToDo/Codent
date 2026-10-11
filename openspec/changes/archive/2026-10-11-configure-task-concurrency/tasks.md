## 1. Config surface

- [x] 1.1 Add `maxConcurrentTasks?: number` to `ManagedAgentConfig` (`managers/managed-agent.ts`) with a doc comment (default 4, clamped ≥1)
- [x] 1.2 Add `maxConcurrentTasks?` to `AgentSessionCreateOptions` (`agent-session/host-types.ts`) and map it in `toManagedConfig` (`local-agent-session-host.ts`)
- [x] 1.3 Add a `resolveMaxConcurrentTasks(managed)` helper (finite integer `>= 1`, else `MAX_ACTIVE_TASK_PREFORKS`)

## 2. Coordinator honors the cap

- [x] 2.1 Give `TaskPreforkCoordinator` a cap provider (default `() => MAX_ACTIVE_TASK_PREFORKS`) and use it in `start()`'s admission check
- [x] 2.2 `getTaskPreforkCoordinator(managed)` passes `() => resolveMaxConcurrentTasks(managed)` so `updateConfig` is honored

## 3. Docs repositioning

- [x] 3.1 Update `task-prefork.ts` / `task-prefork-middleware.ts` comments (concurrency throttle + eager start, not a sequential workaround) and the AGENTS.md subagent section

## 4. Coverage

- [x] 4.1 Extend `validate-task-prefork.mjs`: a custom cap admits exactly that many; the default cap still admits 4; a non-positive cap clamps to 1
- [x] 4.2 Run the full core validator suite plus typecheck/lint
