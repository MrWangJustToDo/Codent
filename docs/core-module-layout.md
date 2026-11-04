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
- [ ] `managed-agent-tools.ts` → `agent/tools/runtime/tool-facet.ts`
- [ ] `managed-agent-extensions.ts` → `agent/extension/extension-facet.ts`
- [ ] `managed-agent-compact.ts` → `agent/compaction/compact-facet.ts`
- [ ] `managed-agent-run-lifecycle.ts` → `agent/run/run-lifecycle.ts`
- [ ] `managed-agent-runner-wiring.ts` → `agent/run/runner-wiring.ts`
- [ ] `managed-agent-model.ts` → `managers/model-facet.ts` (stays with the composition root)

## 3. Naming / cleanup
- [x] `managers/managed-agent-prompt.ts` → `agent/turn-context/prompt-builder.ts`
- [ ] only `managers/managed-agent.ts` keeps the `managed-` prefix
- [ ] update `ARCHITECTURE.md`, `docs/`, validator source paths and the module map
- [ ] full suite green; empty role directories removed

## Not moved (deliberate)
- `managers/services/*` — the target map keeps the service layer in managers.
- `managers/run-finalizer.ts` — listed under `managers/` in the target map.
- `managers/middleware/*`, `managers/telemetry/*`, `managers/stream-recovery/*`.
