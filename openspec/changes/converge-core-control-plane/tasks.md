# Implementation Tasks

Planning sources: proposal `proposal.md`, design `design.md`, and `docs/core-control-plane-convergence-tasks.md` (full dependency graph, coverage matrix, risk register, target module map). Each task below names its dependencies and acceptance gate.

Global prerequisites: repo built (`pnpm build`), `pnpm typecheck` / `pnpm lint` runnable, `node scripts/run-all-validators.mjs --dir packages/core` green (263 passed / 2 environment skips). One task (or tightly related set) per PR; adapters land before old paths are deleted; no wire event name, `AgentStatus` value, or curated public export changes.

## 1. P0 — Guardrails and baseline

- [x] 1.1 Build the control-plane inventory (status / epoch guards / ownership / approval writers and readers) and add `validate:control-plane-writers` as a source-scan gate with an allowlist (no dependencies)
- [x] 1.2 Catalogue ordering invariants from code comments into `docs/core-control-plane-invariants.md`, marking each "structured" or "comment-only" with a reason (no dependencies)
- [x] 1.3 Add a repeatable metrics script (LOC, ManagedAgent methods, status triggers, guard counts, validator count) with a CI artifact (no dependencies)
- [x] 1.4 Add the old/new equivalence helper `scripts/helpers/equivalence.mjs` (depends: 1.1)
- [x] 1.5 Map the existing 265 validators to tasks and list gaps; mark tasks that need a new gate (depends: 1.1, 1.2)

## 2. P1 — Epoch: one current-ness token

- [x] 2.1 Define `Epoch` / `EpochSource` (`sessionGen + runToken + lifecycleGen + isCurrent()`) in `runtime-types` (depends: 1.4)
- [x] 2.2 Expose generation sources from `RunCoordinator`, the UI channel and the chat controller as adapters without deleting old mechanisms (depends: 2.1)
- [x] 2.3 Inject `captureEpoch()` into the persistence/usage paths (`SessionHost`, `SessionPersistence`) (depends: 2.1, 2.2)
- [x] 2.4 Migrate title generation usage to the epoch; delete `stillOnSession` / `sessionIdAtStart` from that path (depends: 2.3)
- [x] 2.5 Migrate memory extraction/consolidation usage and its post-query persist to the epoch (depends: 2.3)
- [x] 2.6 Migrate background-completion wake to the epoch (depends: 2.3)
- [x] 2.7 Migrate subagent usage/part write-back to the epoch (depends: 2.3)
- [x] 2.8 Migrate chat-controller stale-write checks to the epoch, replacing `captureSessionStaleness` / manual `lifecycleEpoch` comparisons (depends: 2.2)
- [x] 2.9 Delete the remaining ad-hoc guards (`sessionIdAtStart`, `stillOn*`, post-await `isSessionSwitching`) and keep `RunToken` as an Epoch internal (depends: 2.4–2.8)
- [x] 2.10 Add `validate:epoch-equivalence` and `validate:epoch-single-source` (depends: 1.4, 2.1–2.9)

## 3. Mode facts

- [x] 3.1 Introduce the `ModeState` read API (`planPhase`, `auto`, `approvalPolicy(tool)`, `toolAvailability()`) in the mode domain (depends: 1.1)
- [x] 3.2 Define `AgentPolicyFacts` and move `todosSeeded` / plan-execution auto-approval into it (depends: 3.1)
- [x] 3.3 Make persistence, turn context, status and plan tools read `ModeState` only (depends: 3.1)
- [x] 3.4 Remove direct `planMode.*` / `isAutoModeEnabled()` reads outside the mode domain (depends: 3.1, 3.3)
- [x] 3.5 Add the mode single-read source guard (depends: 3.4)

## 4. P2 — SessionLease: one session owner

- [x] 4.1 Implement the `SessionLease` state machine (`unclaimed → claimed → restoring → active → draining → released`) with a monotonic generation (depends: 2.1)
- [x] 4.2 Wrap `SessionOwnership` behind the lease (depends: 4.1)
- [x] 4.3 Move disk reservation and restore placeholder into the lease; release only self-made reservations on failure (depends: 4.1, 4.2)
- [x] 4.4 Move log-sink binding into lease phases (depends: 4.1)
- [x] 4.5 Move the persistence baseline / sync tracker reset into `lease.commit` (depends: 4.1)
- [x] 4.6 Define `SessionRuntime` with four ports (`RunControl`, `TranscriptPort`, `ModePort`, `SidecarPort`) (depends: 4.1–4.5)
- [x] 4.7 Rewrite the switch transaction (`new` / `resume` / `clone` / `fork`) as ordered lease phases with rollback (depends: 4.6)
- [x] 4.8 Await background-work reset inside the transaction and remove the fire-and-forget reset (depends: 4.6, 4.7)
- [x] 4.9 Narrow the former 38-member host to at most four ports and update `ManagedAgent` wiring (depends: 4.7)
- [x] 4.10 Add `validate:session-lease-matrix` (new/resume/same-id/different-id/failure-per-phase/clone/fork × ownership, sink, tracker, background, log boundary, events) (depends: 1.4, 4.1–4.9)
- [x] 4.11 Delete duplicate ownership/reservation guards and fold `local-agent-session-host` reservation logic into the lease (depends: 4.9)

## 5. P3 — Authorize: one permission pipeline

- [x] 5.1 Finalize `AgentPolicyFacts` for authorization (mode phase, auto, `todosSeeded`, subagent profile, rules, env, capabilities) (depends: 3.1, 3.2, 4.6)
- [x] 5.2 Add `RegisteredTool.approval: ApprovalRequirement`, composing the static flag and MCP annotations at registration (depends: 1.1)
- [x] 5.3 Implement `authorizeToolCall()` as a stage composer that first calls the existing decision functions unchanged (depends: 5.1, 5.2)
- [x] 5.4 Move command-safety analysis into a pipeline stage and remove the chat controller's separate `applyCommandSafetyPolicy` call (depends: 5.3)
- [ ] 5.5 Move the `tool:before:*` extension hook into the pipeline as a deny source (including the `modifiedArgs` refusal) (depends: 5.3)
- [x] 5.6 Move plan/subagent/code-mode availability into policy facts and make the offered tool list a projection of them (depends: 3.1, 5.1)
- [ ] 5.7 Move auto / plan-execution auto-approval into the pipeline; reduce `ApprovalDecisionCoordinator` to the answer writer (depends: 5.3, 3.2)
- [ ] 5.8 Make the approval table the single decision store; derive the tool part, resume map, JSONL row and event `source` from it (depends: 5.3)
- [ ] 5.9 Delete duplicate gates and raw `needsApproval` policy reads (depends: 5.4–5.8)
- [ ] 5.10 Add `validate:authorize-matrix` (tool × mode × path × env × subagent × rules × annotations) (depends: 1.4, 5.1–5.9)

## 6. P4 — Three state axes and derived status

- [ ] 6.1 Define `LifecyclePhase` / `RunPhase` / `WaitKind` and the transition table (depends: 1.2)
- [ ] 6.2 Add the read-only projection to `AgentStatus` (and optional snapshot fields) without changing writers (depends: 6.1)
- [ ] 6.3 Route every status write through `transition(event)` and remove direct assignment (depends: 6.2, 2.9, 4.6, 5.1)
- [ ] 6.4 Remove the `TERMINAL/ACTIVE` overlap and `resolveFinishStatus` special cases; derive terminality from the axes (depends: 6.3)
- [ ] 6.5 Collapse the 23 status triggers to the transition-event set and update log policy (depends: 6.3, 6.4)
- [ ] 6.6 Move compaction out of `AgentStatus` into the run phase / operation lease (depends: 6.3, 4.1)
- [ ] 6.7 Replace the pump's manual outcome derivation with transition events (depends: 6.3, 6.6, 2.8)
- [ ] 6.8 Model approval / `ask_user` waits as `WaitKind` and remove the `parkOnPendingQuestion` special case (depends: 6.3, 5.7)
- [ ] 6.9 Add `validate:state-transition-matrix` plus old-status equivalence assertions (depends: 1.4, 6.1–6.8)

## 7. P5 — ManagedAgent facade and domain layout

- [ ] 7.1 Extract the model facet (`applyPersistedModel` / metadata / compaction-budget cluster) (depends: 6.4)
- [ ] 7.2 Extract the session facet (session data / tracker / ownership view) (depends: 4.11)
- [ ] 7.3 Extract the run facet (delegate to `RunCoordinator`, drop duplicated fields) (depends: 2.9, 6.7)
- [ ] 7.4 Extract the mode facet (plan/auto/approval views) (depends: 3.4)
- [ ] 7.5 Extract the tool and extension facets (depends: 5.9)
- [ ] 7.6 Move control-plane modules into `agent/{state,run,session,mode,approval}/` as a logic-free move (depends: 7.1–7.5)
- [ ] 7.7 Move the remaining host ports into `runtime-types` and remove legacy host interfaces (depends: 4.9, 7.6)
- [ ] 7.8 Update the module map and file-size allowlist; run the full suite (depends: 7.6, 7.7)

## 8. Documentation, validators and CI

- [ ] 8.1 Replace "call order is the contract" comments with state-machine/port references; keep only cross-module invariants (continuous, per wave)
- [ ] 8.2 Update `packages/core/ARCHITECTURE.md` (state table, session lifecycle, permission model, module map) (depends: 7.6)
- [ ] 8.3 Update `AGENTS.md` (control-plane ownership, validator list, directory rules) (depends: 7.6)
- [ ] 8.4 Merge or delete validators superseded by the new matrices (depends: 4.10, 5.10, 6.9)
- [ ] 8.5 Add the control-plane writer gate and metrics report to CI (depends: 1.1, 1.3)

## 9. Rollout

- [ ] 9.1 Keep a per-phase adapter/flag removal checklist; verify the previous phase's adapters are gone before starting the next (continuous)
- [ ] 9.2 Publish the metrics trend (writers / guards / LOC / triggers) from the CI artifact (depends: 1.3)
- [ ] 9.3 Write a per-wave rollback note and rehearse one revert (per wave)
- [ ] 9.4 Record each phase's Definition-of-Done checklist and gate results in the change (per wave)
