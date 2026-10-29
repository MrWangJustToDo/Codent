## Context

`AgentEventBus` is already core's only notification system: every domain fact either emits an event (`AGENT_EVENT_META`, typed payloads, wildcard fan-out) or is projected onto an `AgentSession` channel. The log is a *consumer* of that bus — `createLogExtension().start()` subscribes `bus.on("*")` and applies `event-log-rules.ts` (`agent-manager.ts:126-135`).

What is **not** unified is where the record decision lives:

- `event-log-rules.ts` — one table, typed `Record<keyof AgentEventPayloadMap, EventLogRuleEntry>` (`:67`); changing "record / don't record" is one line.
- 61 direct `AgentLog` emissions across 16 files (`agent-bootstrap.ts` 23, `managed-agent.ts` 12, `memory-retrieval.ts` 4, `extension/runner.ts` 4, `stream-recovery/*` 5, `side-text-query.ts` 2, …) — level/category/verbosity hardcoded at the call site, invisible to the table.

That split has measurable cost, from the on-disk corpus (302 launches, 171,517 entries, 62.1 MB):

- status transitions are 53,804 entries (31.4%), and the same transitions are already implied by approval/tool/llm rows;
- `prompt:submit` carries `promptPreview: "(structured)"` in 477/477 entries, because the app path sends `messages` and the seam formats a placeholder (`managed-agent-run-lifecycle.ts:123-129`, `run-agent.ts:355-363`);
- 12,126 approval resolutions, 2 with a `reason` — `autoApprovePending` / command-safety allow record none (`approval-decision-coordinator.ts:139-147,177-184`).

A third surface is counted separately from the 61 seam calls: **17 `ctx.logger.*` call sites in 6 files** (code-mode 9, lsp 4, skills 1+1, memory 1, mcp 1). They land in `AgentLog` through `ExtensionRunner.writeExtensionLog` (`runner.ts:1095-1105`), which is a seam call the extension cannot see — and two of those extensions (`memory`, `code-mode`) also receive `ctx.logger` as a narrow `MemoryLog` / `BindingNameLog` interface, so converting the facade covers them for free.

Two structural constraints make the seam non-trivial to remove, and they shape this design:

1. **Ordering**: `buildManagedAgent` finishes bootstrap *before* `agents.register(managed)` (`agent-manager.ts:238-245`), while the bridge resolves a log by `agents.get(event.agentId)` (`:133`). Pre-registration events are therefore unresolvable today; the seam's bounded pending buffer (`agent-log.ts:81-88`) is what currently saves bootstrap diagnostics. Note that `session:doc/skill/mcp/memory/start` are **not** part of that problem: `emitSessionBootstrapEvents` runs after registration (`agent-manager.ts:268-275`). What is lost today is `agent:extension-error` emitted by the extension runner *during* activation — the comment in `agent-bootstrap.ts:262-264` blames "before the log extension starts", but the log extension is started in the manager constructor; the real cause is the unresolved registry lookup.
2. **Non-recursion / non-disableability**: the log sink must never be fed by an event it produces, and logging must work while extensions are failing to load (`openspec/specs/log-extension/spec.md`).

## Goals / Non-Goals

**Goals**

- One place decides what is recorded: the policy table. Adding/removing a recording never means editing an emitter.
- Every recordable fact is a bus event (new event types where none exists), with typed payloads.
- Run scoping travels on the event envelope, so no consumer keeps its own run state.
- Bootstrap diagnostics survive without a second write path: resolution works before registration.
- Default is quiet: an event is not recorded merely because it exists.
- A guard makes a new hand-written log call a build failure, so the convergence cannot rot.

**Non-Goals**

- Merging the sink, schema, rotation, session-boundary divider or exit-path flush into the bus. They are durability, not notification, and the exit path needs a synchronous write the bus cannot offer.
- Changing host-facing APIs (`@codent/app`, ACP, server session channels) or the JSONL line shape. Old logs stay readable.
- Retention/rotation policy, log UI, or a `codent logs` command.
- Multi-runtime attribution work (ambient models.dev cache, side-query usage history) — unrelated.

## Decisions

### D1. Keep a seam, but only for the pre-registration window

Delete nothing; narrow the contract. `AgentLog` remains the sink-facing envelope builder and the pending buffer, but after an agent is resolvable it is no longer the write path. Every post-registration record comes from `bus.on("*")` → policy → sink.

*Alternatives rejected*: (a) a generic `log:entry` event that call sites emit — renames 61 call sites, keeps policy out of the table, so the actual pain (choice of what to record) is untouched; (b) removing the seam entirely — loses bootstrap diagnostics and violates the non-disableable requirement.

### D2. Bind the log target before bootstrap (pending binding)

`AgentManager` gains a construction-time map, symmetric to the existing `teardownLogs` (`agent-manager.ts:109`): `buildManagedAgent` calls `manager.bindConstructionLog(agentId, log)` immediately after the `ManagedAgent` exists and before bootstrap runs; the resolver order becomes `agents → constructionLogs → teardownLogs → null`; registration moves the entry to the registry, and teardown clears it. The same map feeds `AgentEventBusScope`'s interceptor-error resolver (`agent-manager.ts:119-122`), so an interceptor that throws during activation is attributed to the agent being built rather than to an arbitrary one with a log.

This is what makes bootstrap `agent:extension-error` land: the runner already receives the agent's scoped bus (`agent-bootstrap.ts:223`) and already emits the event (`runner.ts:230,337,428`), so the only missing piece is resolution.

*Alternatives rejected*: (a) buffer events in the bridge for unknown agents — unbounded in a failing bootstrap and ordering-fragile; (b) put the log on the event envelope — leaks a mutable object into the wire contract that ACP/HTTP would then have to serialize.

### D3. `runId` on the envelope, stamped by the emit funnel

Add `runId?: string` to `AgentEventMetaInput` and to the `AgentEvent` envelope. Three edits are required, because the envelope is **not** built in `emitAgentTelemetry`: that function only constructs a carrier object for `dispatchEvent`, and the bus rebuilds the event in `buildEventAt` (`agent-event-bus.ts:336-357`) from `agentId` / `parentId` / `sessionId` only.

1. `AgentEventMetaInput.runId?` and `AgentEvent.runId?` (`agent/agent-event-bus/types.ts`);
2. `emitAgentTelemetry` sets `runId` on the carrier from the emitter's `getCurrentRunId?.()` (`emit-agent-telemetry.ts`), and `ManagedAgent.dispatchEvent` (`managed-agent.ts:1165`) forwards `event.runId` into `bus.emit`'s meta;
3. `buildEventAt` copies `meta.runId` onto the envelope.

The bridge then stamps `LogEntry.run` from `event.runId`; `AgentLog.setRun` leaves the production path (kept only for the pre-registration fallback and tests, with its two callers in `managed-agent-run-lifecycle.ts:115,178` dropped).

*Alternatives rejected*: (a) bridge-side run state keyed by `turn:start` — `turn:start` fires per model call, not per run, so the boundary is wrong; (b) leaving it on the seam — that is the state duplication this change removes.

### D4. Policy table stays the single decision point, default-silent

New events get a table entry, and the entry — not the emitter — decides level, category, formatting and suppression. Existing `LogCategory` vocabulary is kept and mapped per event through one `categoryFor(event)` function, so on-disk grouping does not drift while the event count grows.

The table has two halves because the type universe has two halves: `AgentEventType = keyof AgentEvents` (all events) whereas `TELEMETRY_EVENT_LOG_RULES` is exhaustive only over `keyof AgentEventPayloadMap`. Keeping that exhaustiveness and covering the projection half requires a second literal — `PROJECTION_EVENT_LOG_RULES: Record<Exclude<AgentEventType, keyof AgentEventPayloadMap>, false>` — merged into `DEFAULT_EVENT_LOG_RULES`. Every projection event then has an explicit `false` instead of being "unlogged because nobody listed it".

Internal events (`tool:chunk`, `tool:clear`, `extension:ui`) MUST be `false`, never a formatter: wildcard delivery withholds internal events, so a formatter could never run — the invariant `validate-extension-event-observation` §7b already asserts (it accepts `false`, rejects a rule).

*Alternatives rejected*: deriving category from the event-type prefix — would create a dozen user-visible categories and break existing log reading habits; collapsing the exhaustive telemetry literal into one `Partial` table — loses the compile-time "a new telemetry event must be decided" check that is the whole point.

### D5. `agent:status` replaces the direct status write, and mechanical transitions disappear

`setStatus` (`managed-agent.ts:843-864`) becomes `emitEvent("agent:status", {from, to, trigger})` only. Policy: `info` for terminal (`error`, `aborted`) and for transitions nothing else explains; **suppressed** for mechanical triggers (`approvals-pending/cleared`, `chunk:*`, `run-*`, `reconcile*`) because approval/tool/llm rows already carry them. This is a change of meaning, not a level change: today the mechanical rows are still written at `debug`, which is why they remain 31% of the file under the default level.

*Alternative rejected*: keep the rows at `debug` (status quo) — measured 30% of entries for zero information, and it re-blurs "how did the status get here" for anyone reading without `AGENT_LOG_LEVEL`.

### D6. `ctx.logger` becomes `extension:log`, classified observable

The extension-facing logger (`runner.ts:1095-1105`, 17 call sites across 6 files) emits one event `{ extensionId, level, message, data? }` instead of writing to the seam. Extension signatures do not change (`MemoryLog` / `BindingNameLog` stay intact; they are satisfied by `ctx.logger`), and policy maps it to `hooks`/`system` and honours the extension's level.

It MUST be classified **observable**, not internal: internal events are withheld from wildcard delivery, and the log consumer is the wildcard subscriber, so an internal classification would silently produce no entry at all — the exact trap `validate-extension-event-observation` §7b documents. The observer-feedback risk (an extension logging from inside its own observer) is handled at the emitter: `writeExtensionLog` drops a nested `extension:log` while one is already being dispatched, so a log-in-observer loop degrades to one entry instead of unbounded recursion.

### D7. Turn summary distinguishes "paused" from "finished"

`turn:summary` gains `paused?: true` (set by the finalizer for `kind === "waiting"`, `run-finalizer.ts:118-124`); the rule formats it as `Turn paused (approval)` and drops the outcome claim. `outcome` then appears exactly on turns that ended, which is what the spec's "canonical run outcome record" promises.

### D8. Errors travel as structured payloads

Rules that need a stack today pass an `Error` into the seam (`writeLog`, `event-log-bridge.ts:123-131`). The payload carries a **message string** (`error?: string`) and the bridge normalises it through `eventError()`, so no rule invents a stack at the recorder (which would point every reader at the log module). A structured `{ name, message, stack }` carrier was considered and rejected during implementation: every payload that needed it wanted only the message, and a second shape would have doubled the write contract for no reader. Recorded in `tasks.md` §4.11 — this paragraph is the design-level record of that decision.

### D9. A guard instead of discipline

Add `validate:no-direct-agent-log`: scans `packages/*/src` for `log.(debug|info|warn|error|eventEntry)(` outside an allowlist (`agent/agent-log/`, `agent/log/`, the pre-registration bootstrap module, tests/validators), each entry carrying a stated reason. Mirrors the existing `validate:no-inline-error-normalize` shape, so it is a real PR gate rather than a convention.

### D10. An approval row says who answered; the machine's own answers are not rows

The measurement that motivated the change (12,126 resolutions, 2 with a reason) has a second half:
in auto mode / plan execution the pump "answers" an approval nobody was asked about, and the pair of
rows around it is machinery. So the events carry the missing fact — `request.auto` (nobody is being
asked) and `resolved.source: user | auto | policy` — and the policy table suppresses the rows whose
source is `auto`. This needs one table capability the static cell cannot express, `EventLogRule.suppress(event)`: a fact can be worth a row in one variant only, and the decision must stay in the table rather than at the emit site.

*Rejected*: emitting nothing for auto approvals at the call site — that puts "should this be recorded" back in the emitter, which is the split this change removes. *Also rejected*: keeping both rows and adding a field — measured at 22% of a real session's lines for zero information.

### D11. `mode:change` is the append-only counterpart of the suppressed `session:mode` projection

`session:mode` is a retained projection and is explicitly `false` in the table, so the timeline could
not explain why 595 of one session's 665 approvals never asked a human. A telemetry event emitted by
the setters that actually change the state (`AutoModeController.onChange`, `setReasoningEffort`) is
the record; it is emitted once per change, not on every state snapshot.

### D12. Spill GC is age-bounded, not wire-bounded

Compaction is additive: it shadows a message from the *wire*, not from the transcript, so the
`cachedOutputPath` is still in the durable log and a later turn can still read it. Collecting on the
wire signal deleted a subagent report 11 minutes after it was written (one session, mid-run). The
reference pass now only collects files older than `TOOL_OUTPUT_ORPHAN_GRACE_MS` (24h); the 7-day age
sweep remains the reclamation path. This is a log-integrity decision, not a disk decision. The three workspace caches (spills, job logs, job records) take their directories, suffixes and ages from one table (`tools/shared/cache/workspace-cache.ts`) and are swept by one entry point, so "how long does this live" is answered once instead of at each trigger.

### Event inventory to add (implementation-time detail, may be trimmed)

| Area | New / changed event | Replaces |
|---|---|---|
| Status | `agent:status` | `managed-agent.ts:858,860` |
| Session | `session:title` (`{ name, ok, error? }`) | `session-lifecycle-commands.ts:46,64` and `session-service.ts:252` (a title failure is not a side-query failure) |
| Session | `session:reset` (`{ reason, previousStatus, hadTodos }`) | `managed-agent.ts:2499` |
| Session | `session:switched` reason widened to `resume \| fork \| clone` (payload only) | hardcoded `"resume"` (`managed-agent.ts:733`) |
| Config | `model:change` (`{ from, to, style?, fallback? }`) | silent `setModel`; also absorbs `managed-agent.ts:1234,1257` (persisted-model fallback) |
| Side query | `side-query:complete` / `side-query:error` (`{ purpose, mode, error?, rawExcerpt? }`) | `side-text-query.ts:588,687`, `extension-completion.ts:250,264` |
| Extensions | `extension:log` (observable, D6) | `runner.ts:1101-1104` + 17 `ctx.logger` sites |
| Extensions | `agent:extension-error` gains `phase: "load" \| "config" \| "disk" \| "turn-context"` | 12 bootstrap warns + `turn-context-controller.ts:228` |
| Tools | `tool:projection-error` | `tool-compact-middleware.ts:51` |
| Diagnostics | `hooks:echo` (`{ middleware, hook, phase, iteration }`, suppressed by default, enabled by `MY_AGENT_LOG_HOOKS`) | `instrument-middleware-log.ts:75` |
| Diagnostics | `agent:stream-error` reused for the chat loop failure | `agent-chat-controller.ts:777`, `run-stream-recovery.ts:96` |
| Jobs / wake | `job:changed`, `run:wake` (debug, suppressed by default) | none today (`session:jobs` deliberately unlogged) |
| Compaction | `compaction:cache-cleanup-error` | `compaction-middleware.ts:134` |

## Risks / Trade-offs

- **Bootstrap regression** (worst case: extension failures vanish from disk) → D2 lands first and alone, guarded by a fixture that boots an agent with a throwing extension and asserts the line exists; `validate:agent-log-binding` / `validate:agent-log-host-sink` extend to pre-registration. Note the asymmetry that makes this testable: `session:*` already works because it is emitted after registration, so the fixture must assert the *cycle* error (`agent:extension-error`), not a `session:*` row.
- **Pending-buffer cap during bootstrap** → D2 assigns bootstrap events to the real log, but no sink exists until `createManagedAgent` binds it, so those entries still queue in `MAX_PENDING_LOG_ENTRIES` (200, sized for ~15 emissions). Converting extension logs/errors to events raises bootstrap volume; measure the emissions per launch in the fixture and raise the cap if it approaches the limit, otherwise the oldest activation failures are dropped exactly as before.
- **Volume spike** → new events are default-suppressed; `agent:status` removes 30% while adding none; add a corpus-count assertion so a new `info`-level event family fails review.
- **`extension:log` observer feedback** → observable classification is required for the wildcard consumer to see it (D6); mitigated by dropping nested logs while one is dispatching, and asserted in `validate:middleware-log`'s replacement fixture.
- **Ordering vs batching** stays as today: the bridge writes synchronously into the sink buffer, the sink coalesces 250 ms. No awaited broadcast is introduced (the bus spec forbids it).
- **Events during destroy** → `teardownLogs` already covers the post-registry window; D2 adds the pre-registry one, and the resolver order is a single list so a new phase cannot forget attribution.
- **Subagent attribution** → a child emits with its own `agentId`/`runId` and resolves to its own file; the parent index stays an explicit direct write (`subagent-log-mirror.ts`, kept in the allowlist with that reason).
- **Migration duplication** → during phase 1–2 a fact can exist as both event and direct call; each phase's validator asserts "exactly once" for the families it converts, so duplication cannot outlive its phase.
- **Behavioural drift risk** → moving `ctx.logger` to an event changes ordering relative to extension activation; mitigation: emit before returning from the logger call (synchronous observer, same as today).

## Migration Plan

Three independently shippable phases, each leaving `pnpm build && pnpm lint && pnpm typecheck` and the `validate:*` suite green:

1. **Bind early, record bootstrap as events** — D2 + `session:*` bootstrap conversion; seam pending buffer becomes fallback only. No visible output change except no duplicates.
2. **Run scope + status** — D3 + D5 + D7: envelope `runId`, `agent:status`, mechanical suppression, paused-vs-finished summary. Largest volume change, no format change.
3. **Remaining families + guard** — D4/D6/D8/D9: extension/side-query/title/model/mode/jobs/wake events, default-silent table entries, `validate:no-direct-agent-log`, allowlist shrunk to bootstrap + sink + tests.

Rollback: phases are additive and reversible by re-enabling table entries; the JSONL schema and paths are untouched, so a rollback never makes existing logs unreadable.

## Open Questions

- Should `AgentLog` stop being reachable from `dev.ts` exports after phase 3? (Public entry already exports only `LogEntry`/`LogCategory`/`LogLevel`, so closing it later is cheap.)
- Do job lifecycle and wake turns get `info` rows or `debug` (suppressed) by default? Proposal: `debug`, and revisit once `run:wake` has been observed in real sessions.
- ~~Is `session:mode` change worth its own telemetry event?~~ **Resolved: yes** — see D11. The retained channel is not in the log, and a session where the agent answered 89% of its own approvals read identically to one where the user answered all of them.
