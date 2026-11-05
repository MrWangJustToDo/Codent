# Core module layout — remaining moves

Target (per `AGENTS.md` "File Structure"): domain code lives under `agent/`; `managers/` keeps the
composition root (`ManagedAgent`, `AgentManager`), `RunFinalizer`, `services/`, `middleware/` and
`telemetry/`. `runtime-types/` keeps the type-only port modules.

Progress is tracked here; each batch is format + typecheck + layer/gates + full core validators,
then one commit.

## 1. Controllers out of `managers/controllers`
- [x] `compaction-controller.ts` → `agent/compaction/compaction-controller.ts`
- [x] `turn-context-controller.ts` → `agent/turn-context/turn-context-controller.ts`
- [x] `agent-chat-controller.ts` → `agent/run/chat-controller.ts` (narrow `AgentChatHost` port)
- [x] delete the empty `managers/controllers/`

## 2. `managed-agent-*` facets
- [x] `managed-agent-tools.ts` → `managers/tool-facet.ts` (service stays in managers)
- [x] `managed-agent-extensions.ts` → `managers/extension-facet.ts`
- [x] `managed-agent-compact.ts` → `managers/compact-facet.ts`
- [x] `managed-agent-run-lifecycle.ts` → `agent/run/run-lifecycle.ts`
- [x] `managed-agent-runner-wiring.ts` → `agent/run/runner-wiring.ts`
- [x] `managed-agent-model.ts` → `managers/model-facet.ts` (stays with the composition root)

## 3. Naming / cleanup
- [x] `managers/managed-agent-prompt.ts` → `agent/turn-context/prompt-builder.ts`
- [x] only `managers/managed-agent.ts` keeps the `managed-` prefix
- [x] update `ARCHITECTURE.md`, `docs/`, validator source paths and the module map
- [x] full suite green; empty role directories removed

## Not moved (deliberate)
- `managers/services/*` — the target map keeps the service layer in managers.
- `managers/stream-recovery/*` — run-recovery policy over `ManagedAgent`/`AgentManager`; it needs the same port extraction before moving.
- `managers/run-finalizer.ts` — listed under `managers/` in the target map.
- `managers/middleware/*`, `managers/telemetry/*`, `managers/stream-recovery/*`.
