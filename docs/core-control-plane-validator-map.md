# Control-Plane Validator Map

Which existing gates defend each convergence area, and which gates the change must add. The core
suite has 266 `validate-*` scripts (95 matching the control-plane areas below); this map names the
ones that carry a task's acceptance, not every script that happens to import a related module.

Run one: `pnpm --filter @codent/core run validate:<name>`
Run all: `node scripts/run-all-validators.mjs --dir packages/core`

## P0 — guardrails (this change)

| Task | Gate |
|---|---|
| 1.1 | `validate:control-plane-writers` (new) — freezes the writer inventory, fails new scatter and stale exemptions |
| 1.2 | `docs/core-control-plane-invariants.md` (review artifact) |
| 1.3 | `metrics:control-plane` (new script; no assertion) |
| 1.4 | `scripts/helpers/equivalence.mjs` (new helper; self-test when run directly) |
| 1.5 | this document |

## P1 — Epoch (E1–E10)

| Existing gate | Covers |
|---|---|
| `validate:session-staleness` | stale stream/queue/wake writes across a session commit |
| `validate:session-persist-integrity` | persist → adopt round-trip, totals/context fields |
| `validate:session-persist-coalescing` | coalesced synthetic/persist writes |
| `validate:session-sync-tracker` | "already persisted" baseline semantics |
| `validate:session-model-persistence` | model/effort adoption across resume |
| `validate:background-wake` | idle wake after a completion, no cross-session turn |
| `validate:background-task` | background task settle/part write-back/epoch |
| `validate:memory-extraction-usage`, `validate:memory-service` | extraction usage attribution |
| `validate:cost-convention`, `validate:context-fill-tokens`, `validate:lifetime-total-tokens` | usage/cost accounting |
| `validate:session-interaction-channel` | pending interaction projection |
| `validate:extension-model-access` | `ctx.llm` usage attribution |
| **New (E10, created)** | `validate:epoch-equivalence`, `validate:epoch-single-source` |

## P2 — SessionLease (S1–S11)

| Existing gate | Covers |
|---|---|
| `validate:session-ownership`, `validate:session-identity` | one claim per live session |
| `validate:session-switch-safety` | switch ordering / stale writes |
| `validate:session-branching` | clone/fork transaction + persisted copies |
| `validate:session-restore-rollback`, `validate:session-restore-state` | failed restore leaves the leaving session intact |
| `validate:session-close-drain`, `validate:session-store-errors`, `validate:session-store-lifecycle` | persistence lifecycle |
| `validate:session-persistence`, `validate:session-persist-media-failure` | canonical save + media failure |
| `validate:session-reuse-log`, `validate:session-message-log` | log sink / journal on reuse |
| `validate:local-agent-session`, `validate:agent-session-host`, `validate:agent-session-types` | host surface |
| `validate:restore-session-chat-state` | approved/denied/pending reconciliation |
| **New (S10)** | `validate:session-lease-matrix` (lease transitions + adopt/reservation/sink phases; switch side effects exercised by `validate:session-switch-safety`) |

## P3 — Authorize (A1–A10)

| Existing gate | Covers |
|---|---|
| `validate:approval-decisions`, `validate:tool-approval-resume` | decision table + resume map |
| `validate:approval-batch-resume` | held calls on terminal; pending `ask_user` |
| `validate:auto-mode-approvals` | auto mode answers pending approvals |
| `validate:command-safety-portability`, `validate:command-safety-readonly`, `validate:command-env-safety`, `validate:safe-command` | command analysis + env overrides |
| `validate:tool-denial-reason`, `validate:cancel-semantics`, `validate:tool-timeout-contract` | deny/cancel/timeout shapes |
| `validate:plan-verification`, `validate:plan-session`, `validate:plan-tool-boundary` | plan gate + tool availability |
| `validate:code-mode-extension`, `validate:code-mode-binding-names` | code-mode exclusions |
| `validate:mcp-client`, `validate:mcp-tool-presentation` | MCP annotations/tools |
| `validate:ask-user-output` | client-tool result assembly |
| **New (A10)** | `validate:authorize-matrix` (tool × mode × path × env × subagent × rules × annotations) |

## P4 — State axes (T1–T9)

| Existing gate | Covers |
|---|---|
| `validate:agent-status`, `validate:agent-status-log`, `validate:status-middleware` | status values/triggers/log rows |
| `validate:agent-run-finalization`, `validate:run-finalizer`, `validate:run-finalize`, `validate:run-coordinator` | terminal finalization |
| `validate:run-stream-recovery`, `validate:run-recovery-gaps`, `validate:run-abort-ownership`, `validate:run-event-identity` | retries/abort/run identity |
| `validate:pump-continuation`, `validate:task-run-state`, `validate:task-prefork` | pump phases/continuations |
| `validate:manual-compact-interlock`, `validate:reactive-compact`, `validate:auto-compact-noop` | compaction ownership/status restore |
| `validate:middleware-order` | middleware adjacency |
| **New (T9)** | `validate:state-transition-matrix` + old-status equivalence |

## Mode facts (M1–M5)

| Existing gate | Covers |
|---|---|
| `validate:mode-coordinator` | plan/auto exclusivity + persistence |
| `validate:plan-lifecycle`, `validate:plan-session`, `validate:plan-tools`, `validate:plan-footer-label`, `validate:plan-retro-continuation`, `validate:plan-store` | plan phases/tools/persistence |
| `validate:turn-context`, `validate:turn-context-kinds` | mode blocks in turn context |
| **New (M5)** | `validate:mode-single-read` (source guard) |

## Facade and layout (F1–F8)

| Existing gate | Covers |
|---|---|
| `validate:file-size` | facade/facet sizes + allowlist honesty |
| `validate:module-organization`, `validate:layer-boundaries` | directory move, acyclic value graph |
| `validate:jsdoc-attachment`, `validate:accessor-convention` | moved declarations |
| `validate:core-public-exports` | curated export surface unchanged |
| `validate:no-inline-*` (7 scripts) | shared helper definitions after moves |
| `validate:managed-agent-accessors`, `validate:managed-agent-state` | facade accessors/state |
| **New** | none — the suite above is the acceptance |

## Extensions and observability (invariants I14/I15, not a convergence main line)

| Existing gate | Covers |
|---|---|
| `validate:extension-lifecycle-lease`, `validate:extension-tool-restore`, `validate:extension-disable-notice`, `validate:extension-order`, `validate:extension-flush` | lease/teardown/notices/order |
| `validate:extension-message-transform`, `validate:extension-context-sections`, `validate:extension-handler-context`, `validate:extension-turn-events`, `validate:extension-event-observation`, `validate:extension-tool-safety`, `validate:extension-prompt-hooks` | registration surfaces |
| `validate:agent-event-bus`, `validate:agent-event-bus-scope`, `validate:agent-event-envelope`, `validate:event-emit-paths`, `validate:event-log-bridge` | event identity/policy |
| `validate:agent-log-binding`, `validate:agent-log-timeline`, `validate:agent-log-file-sink`, `validate:agent-log-host-sink`, `validate:no-direct-agent-log` | log seam/sink |

## Gaps this change must fill

| Gap | Task | Gate |
|---|---|---|
| No gate on the number of writers for status/epoch/ownership | G1 | `validate:control-plane-writers` (created) |
| No old/new equivalence harness | E10 / S10 / A10 / T9 | `helpers/equivalence.mjs` (created); epoch equivalence (created); session/authorize/state matrices (planned) |
| No session-switch failure matrix (rollback per phase) | S10 | `validate:session-lease-matrix` (created) |
| No single authorization decision matrix | A10 | planned |
| No state transition matrix / illegal-transition check | T9 | planned |
| No epoch single-source guard | E10 | `validate:epoch-single-source` (created) |
| No mode single-read guard | M5 | planned |

A task's DoD is the union of its row here and the matrix gate it adds; a matrix gate is only
accepted after it fails on a deliberately broken implementation (the repo's "guard rot" rule).
