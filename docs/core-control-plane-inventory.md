# Core Control-Plane Inventory

Snapshot for the `converge-core-control-plane` change. The executable source of truth is
`packages/core/scripts/validate-control-plane-writers.mjs`; regenerate this file with:

```bash
node packages/core/scripts/validate-control-plane-writers.mjs --report
```

The gate freezes the current scatter so the migration cannot silently add another writer. Each
entry names the task that removes it. Non-gated mechanisms (approval flags, session-host members)
are listed at the end as migration context.

## Gated mechanisms (68 tracked sites)

### `status-write` → owner T3 (single transition writer) — 35 sites

| file | sites |
|---|---:|
| `managers/controllers/agent-status-controller.ts` | 26 |
| `managers/controllers/compaction-controller.ts` | 4 |
| `managers/managed-agent.ts` | 3 |
| `managers/managed-agent-run-lifecycle.ts` | 2 |

### `epoch-guard-session-id` → retired by E9

No sites remain. The old captured-session-id guards are replaced by `Epoch.isCurrent()`; the gate
keeps the pattern so a reintroduction fails immediately.

### `epoch-guard-lifecycle` → owner E9 (Epoch) — 3 sites

| file | sites |
|---|---:|
| `managers/controllers/agent-chat-controller.ts` | 3 |

### `epoch-guard-staleness` → owner E8/E9 (Epoch) — 3 sites

The chat controller and `ManagedAgent` moved to `Epoch` in P1; the two middlewares still use the
old helper until they receive the epoch through their deps.

| file | sites |
|---|---:|
| `agent/turn-context/session-staleness.ts` | 1 |
| `managers/middleware/background-middleware.ts` | 1 |
| `managers/middleware/turn-context-middleware.ts` | 1 |

### `session-generation` → owner S1/S5 (SessionLease) — 3 sites

| file | sites |
|---|---:|
| `agent/ui/ui-channel.ts` | 2 |
| `managers/managed-agent-session.ts` | 1 |

### `session-switching` → owner E9 (Epoch) — 10 sites

| file | sites |
|---|---:|
| `managers/approval-decision-coordinator.ts` | 2 |
| `managers/controllers/agent-chat-controller.ts` | 3 |
| `managers/managed-agent.ts` | 4 |
| `managers/run-agent.ts` | 1 |

### `ownership-write` → owner S2 (SessionLease) — 14 sites

| file | sites |
|---|---:|
| `managers/agent-manager.ts` | 3 |
| `managers/managed-agent.ts` | 2 |
| `managers/services/session-lifecycle-service.ts` | 9 |

## Not yet gated (tracked by analysis, migrate next)

| Mechanism | Where | Target task |
|---|---|---|
| 23 `AgentStatusTrigger` values | `runtime-types/agent-status.ts` | T5 |
| `TERMINAL_STATUSES` / `ACTIVE_STATUSES` overlap on `waiting` / `awaiting_user` | `runtime-types/agent-status.ts` | T4 |
| `compacting` as a status value | `agents-status-controller`, `compaction-controller` | T6 |
| Raw `needsApproval` reads (~39) | tool definitions, approval coordinator, run-agent | A2/A9 |
| 38-member `SessionLifecycleHost` | `managers/services/session-lifecycle-service.ts` | S9 |
| `ManagedAgent` public methods (~176) | `managers/managed-agent.ts` | F1–F5 |
| Direct `planMode` / `isAutoModeEnabled` reads (~47 / ~6) | across `agent/` and `managers/` | M4 |
| `getStatus()` readers (15 files) | across `agent/` and `managers/` | T3 |

## Rules for editing the gate

1. A new file that needs one of these mechanisms is a design change: add it here and in the
   validator only with a reason and the task that removes it, or use the designated owner.
2. When a task removes the last site in a file, delete the allowlist entry in the same PR; the
   validator fails on stale entries by design.
3. The gate has no exemption for comments: it strips comments before matching, so prose may name a
   retired mechanism without tripping it.
