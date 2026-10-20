## 1. P0 — turn and session correctness

- [x] 1.1 Settle a client-cancelled permission: `mapPermissionOutcome` → `respondApproval(false)` instead of a no-op; add an approval/elicitation timeout (default 5 min) and settle on connection close (`packages/acp/src/interactions.ts`, `agent.ts`)
- [x] 1.2 Make `session/cancel` settle pending approvals before returning; ensure a later prompt cannot park on an approval that no client will answer
- [x] 1.3 Add `AcpProjector.start({ primeOnly: true })`; use it for `resume` so cold resume seeds cursors from the snapshot without emitting retained messages (`packages/acp/src/projector.ts`, `agent.ts`)
- [x] 1.4 Fix `session/load` replay: emit `tool-result` parts in part order and set `resultEmitted` only after emitting; add a cold-load assertion that command/file results are replayed (`projector.ts`)
- [x] 1.5 Fix `session/fork` rebinding: pause projection during clone, set the new handle + `diskSessionId`, `runtime.bind(newId)`, reset `replayed`; assert no update is emitted under the source id (`agent.ts`, `session-runtime.ts`)
- [x] 1.6 Surface the run finish reason from `AgentL1State` (core records it at run finish) and map `max_tokens`; require a tool-call continuation for `max_turn_requests`; emit the error text (notice or agent message) before resolving a failed prompt (`session-status.ts`, `projector.ts`, small core state payload)
- [x] 1.7 Make `cwd` the per-session workspace root (`session/new|load|resume`): build the session env from it, reject an unusable `cwd`, keep the process default only for absent `cwd`/pre-session reads (`agent.ts`, `session-runtime.ts`, `bootstrap.ts`)
- [x] 1.8 Add regression tests: cancelled permission, timeout settlement, cold `resume`, `load` with tool results, fork under `--client-env`, `max_tokens`, failed run visibility, per-session `cwd`
- [x] 1.9 Delete the dead `reason?: string` on `ApprovalDecision` and its comment in `permissions.ts` — ACP v1's `SelectedPermissionOutcome` carries only `optionId`, so a rejection reason can never be supplied and the field is never assigned. `ApprovalDecision` is a public type export (`src/index.ts`), so this is a **type-only breaking** change for TS consumers (no runtime effect); the spec records the protocol drift (the baseline claimed "拒绝并带理由").
## 2. P1 — identity, interaction and update semantics

- [x] 2.1 Introduce a stable ACP handle separate from the disk id; `session/new` returns it, `session/list|delete` use disk ids, `session/load` accepts either (`agent.ts`, `sessions.ts`)
- [x] 2.2 Rebind the handle after `/clear` / `/clone` / `/resume`; expose the current disk id in `session_info_update._meta.diskSessionId`; add a notice that ACP cannot retract the client transcript (`commands.ts`, `agent.ts`, `projector.ts`)
- [x] 2.3 Implement real per-session `allow_always` / `reject_always` (tool identity; `run_command` keyed by leading program), auto-dispatch and clear on close/`/clear` (`interactions.ts`, `approvals.ts`)
- [x] 2.4 Settle elicitation `decline` / `cancel` / request failure as a `cancelled: true` tool result (no empty-string answer, no hang) (`interactions.ts`, `permissions.ts`)
- [x] 2.5 Subscribe the projector to `extensions` and `extension-ui` in addition to `DEFAULT_AGENT_SESSION_CHANNELS` (`start()` currently passes no `channels`, so the `onEvent` cases are unreachable), then add regression assertions that a command-set change re-advertises `available_commands_update` and extension notices reach the client (`projector.ts`)
- [x] 2.6 Defer `session/new` seed notifications until after the response frame (`agent.ts`, `projector.ts`)
- [x] 2.7 Fix tool row status/diff: denied → `failed`, `input-streaming` → `pending`, no terminal downgrade, overwrite `oldText`, per-replacement/`replaceAll` diffs (`tools.ts`, `projector.ts`)
- [x] 2.8 Preserve prompt part order across text/image/audio/resource blocks (`content.ts`)
- [x] 2.9 Add regression tests for rebinding, always-policy, elicitation cancel, command refresh, seed ordering, denied/overwrite diffs, prompt order

## 3. P2 — catalog, client-env and remaining correctness

- [x] 3.1 Make `session/delete` idempotent for an id that is neither live nor persisted (`sessions.ts`)
- [x] 3.2 Filter `session/list` by `cwd`; skip rows with an invalid `updatedAt` instead of failing the page (`sessions.ts`)
- [x] 3.3 Make re-selecting the current model a no-op and never pass `modelInfo: null` (`session-config-options.ts`)
- [x] 3.4 Reconcile `mcpServers` on a live `load`/`resume`: same list reuses, different list returns `invalidParams` (`agent.ts`, `mcp.ts`)
- [x] 3.5 Local metadata first; derive `exists`/`stat` from the client text read only for a remote-only file (`stat` reports an unknown mtime as epoch; `readdir` stays local); report a signal-terminated terminal as `killed: true` (`client-env.ts`)
- [x] 3.6 Compaction: ignore `phase: "cache-cleanup"` for row status; report manual compaction failure/cancel as `failed`/`cancelled` (`projector.ts`)
- [x] 3.7 Legacy `session/set_model` re-advertises `configOptions`; `session/prompt` checks `dispatch({type:"send"})` failure; add `.catch` to `void handleInteractions` (`agent.ts`)
- [x] 3.8 Harden transport/lifecycle: flush stdout before exit, handle stdout EPIPE, honour stdin backpressure; tolerate a malformed `session/list` cursor; make session names unique (`bin.ts`, `agent.ts`, `sessions.ts`)
- [x] 3.9 Correct README/spec drift: live user chunk, fork cold source, resume replay, commands re-send, `cwd`, selector comments (`packages/acp/README.md`, ACP specs)
- [x] 3.10 Add regression tests for delete idempotency, list cwd/bad row, model re-select, live MCP, client-env metadata/signal, compaction states, legacy set_model

## 4. Validation

- [x] 4.1 `pnpm --filter @codent/acp run validate:acp` green (plus any new `validate:acp:*` entries)
- [x] 4.2 `pnpm build` and `pnpm typecheck` across the workspace
- [x] 4.3 `pnpm lint` and prettier on changed files
- [x] 4.4 Full validator suite + `openspec validate harden-acp-v1-conformance --strict`
- [ ] 4.5 Manual smoke against the reference clients used in the audit (at least Zed or cc-connect): new session, prompt, approval + cancel, fork, restart + load/resume, model/mode switch — **not run in this environment** (needs an installed reference client; the automated in-process suite covers the same request paths)

## 5. Review follow-ups (from the proposal review)

- [x] 5.1 `proposal.md` "Why" is ~1150 chars, above the 1000-char advisory the archiver warns on. Left as is: the remaining length is the finding list itself, and cutting it would drop the diagnosis a reader needs to judge the proposal. If the warning must go, move the bullet list wholesale into `design.md` — do not trim individual findings.
- [x] 5.2 Confirm the `acp-agent-host` per-session-`cwd` change does not narrow the client-declared capability envelope: with the root no longer fixed at handshake, re-check that `.agents` / out-of-workspace paths are still never routed to the client (see `acp-client-env` "`.agents` 与工作区外路径永不发往 client").
