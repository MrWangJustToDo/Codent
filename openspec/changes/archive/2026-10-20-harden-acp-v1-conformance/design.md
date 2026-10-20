## Context

The audit compared `packages/acp` against the ACP v1 spec, six reference agent implementations
(Gemini CLI, OpenCode, Claude agent adapter, Codex, pi-acp, Goose) and a logic/edge-case review. The
**capability surface is broad** — all v1 session methods, audio/SSE-MCP (more than most references),
three model surfaces, full update coverage — but the host is **not v1-complete** because several
lifecycle paths are wrong. The top findings were verified against the code:

- `interruptBridge` clears pending interactions without settling approvals; `mapPermissionOutcome`
  returns `null` for a client-cancelled permission and nothing is dispatched. Core's `stop`
  deliberately skips `needsApproval && approved === undefined`, so `hasPendingToolApprovals` stays
  true and the next prompt parks in `waiting` forever. There is no approval timeout to save it.
- `AcpProjector.start()` subscribes with the default channel set (which includes `messages`), and
  `AgentSession.subscribe()` delivers retained values synchronously — so a cold `resume` replays the
  transcript although `replayFrom` is only called for `load`.
- `replayFrom` emits thinking/text/tool-call but not `tool-result`; it marks tool state
  `resultEmitted: replay`, so the later retained `messages` delivery is skipped too.
- `session/fork` sets `bridge.acpId` but does not `runtime.bind(newId)`, and clone-time updates can
  be emitted under the source id; `replayed` is not reset.
- `lastFinishReason` is read but never assigned; `status === "error"` maps to `end_turn` with no
  error text; `session/prompt` polls a session forever when the client stops answering.
- `session/new|load|resume` treat `cwd` as a hint; ACP says it MUST be the session root.
- `/clear`, `/clone`, `/resume` change the disk session id but not the ACP id; `allow_always` is
  advertised but not remembered.

Decisions already made with the maintainer: fix **all P0+P1+P2**, make **`cwd` the per-session
workspace root**, and **implement real rebinding and real `always` semantics** rather than removing
the commands/options.

### Reference comparison (what to copy)

The comparison is directional — it is each project's current code/docs as reviewed (2026-10), and
third-party surfaces move. It exists to justify the target behaviour, not to claim compatibility.

| Finding | Reference that demonstrates the target | What this change adopts |
|---|---|---|
| `load` loses tool results; cold `resume` replays | OpenCode replay, Claude adapter, Codex replay full load history; OpenCode/Claude resume without replay | replay tool results; prime-only resume |
| permission cancel / `always` | Gemini, OpenCode and Goose implement `allow_always`; Claude/Codex use a dynamic decision set | settle on cancel/timeout; real per-session `always` |
| failed run invisible | Claude adapter and Codex emit `notice`/structured failures | error text before the stop reason |
| `cwd` ignored | OpenCode/Claude/Codex honour per-session roots and `additionalDirectories` (only `cwd` is in scope here) | per-session workspace root |
| fork identity | Claude/Codex rebind a fork and report lineage; OpenCode forks whole sessions | rebind handle/env/`replayed`; lineage stays a Non-Goal |
| tool status / diff | OpenCode/pi-acp emit structured diffs; Claude/Codex are diff-native | accurate status + real `oldText`/`replaceAll` |
| commands refresh | Gemini/OpenCode/Claude/Codex advertise `available_commands_update` | subscribe `extensions`/`extension-ui` |
| client fs/terminal | Goose serves client fs+terminal; Gemini/Claude serve fs | metadata/signal fixes; conservative opt-in stays |

## Goals / Non-Goals

- **Goals**: make the host v1-conformant on the paths an editor or IM client actually exercises;
  make restore/fork/cancel/turn-end deterministic and observable; add regression coverage for each
  fixed path; correct the documentation that describes behaviour the code does not have.
- **Non-Goals**: `additionalDirectories`, real `authMethods` / `providers/*`, ACP subagent sessions,
  fork points + lineage `_meta`, HTTP/WS transport, and ACP v2. These are capability gaps (product
  scope), not conformance bugs; they remain tracked separately.

## Decisions

- **D1 — `cwd` is the session workspace root.** `session/new` builds the session's `CoreEnv` from
  `params.cwd` (the bootstrap `rootPath` only defaults it when absent). `load` / `resume` use
  `params.cwd` when provided, otherwise the process default root; the persisted `SessionMeta` does
  not carry a root, so there is no other value to use. Each session's `.agents/**`, relative paths
  and `session/list` filter follow that root. The process still has a default root for
  `session/list` without `cwd` and for pre-session reads. Cost: one `CoreEnv` per non-default root,
  which the per-session runtime already supports.
- **D2 — a stable ACP handle, separate from the disk id.** `session/new` returns the handle (initially
  equal to the disk id, so existing clients are unaffected). The bridge tracks `diskSessionId`
  separately. `/clear`, `/clone`, `/resume` rebind the handle to the new disk session while the
  client-facing id stays stable; `session/update` keeps using the handle; `session_info_update`
  carries the current disk id in `_meta`. `session/list` / `session/delete` address disk ids;
  `session/load` accepts either a handle or a disk id. This is the only way ACP can represent an
  in-session session replacement — the protocol has no "id changed" notification. ACP's append-only
  transcript means `/clear` and `/resume` cannot retract what the client already rendered; the host
  sends a notice stating that, and the client should start a fresh thread if it needs a clean view.
- **D3 — real `always` semantics.** The host keeps a per-bridge approval policy keyed by the tool
  identity (`tool name`; for `run_command`, the command's leading program). `allow_always` auto-
  dispatches `respondApproval(true)` for matching future approvals without calling the client;
  `reject_always` auto-denies. Policy is cleared by `session/close` / `session/cancel`? No — it is
  session-scoped and survives turns; it is cleared when the handle is closed or the session is
  replaced by `/clear`. A policy match is still reported as a tool call (`status` transitions), so
  the transcript shows what was auto-approved.
- **D4 — every suspend point settles.** A client-cancelled permission dispatches
  `respondApproval(false)` instead of doing nothing; a client-cancelled/failed elicitation dispatches
  `addToolResult` with `cancelled: true`. The host adds a configurable approval/elicitation timeout
  (default 5 minutes) that settles the same way and emits a notice. Closing the connection or
  `session/cancel` aborts every pending interaction controller **and** settles the approval. This is
  what makes `session/prompt` bounded.
- **D5 — replay and prime are distinct.** `AcpProjector.start({ primeOnly: true })` seeds cursors /
  tool state from `getSnapshot()` without emitting; `resume` uses it. `load` calls `replayFrom`
  **and** primes; `replayFrom` now emits tool-result parts (in part order) and only sets
  `resultEmitted` after emitting. Retained `messages` delivery after a prime finds the cursors
  already at the snapshot baseline, so it emits nothing.
- **D6 — turn end is observable.** The host maps `max_tokens` from the run's finish reason and
  `max_turn_requests` only when the budget was exhausted by a tool-call continuation (the same rule
  core uses for subagents). Core records the finish reason on `AgentL1State` when the status flips
  (a small payload addition; no new channel), so the host reads it from the state the projector
  already sees. A failed run emits a `notice` (if the client declared `session.notices`) or an
  `agent_message_chunk` carrying the error text **before** resolving the prompt.
- **D7 — seed after the response.** `session/new` defers its seed notifications (`plan`, mode,
  usage, title, commands) until after the response frame, so a client that keys updates by
  `sessionId` does not drop them. `load` keeps replay-before-response (the protocol requires it).
- **D8 — subscribe to what is projected.** `AcpProjector.start()` subscribes to
  `extensions` and `extension-ui` in addition to the default channels, so
  `available_commands_update` really refreshes and extension notices become `notice` updates.
- **D9 — tool rows reflect the truth.** `toolStatusFor` reads the approval (`approved === false` →
  `failed`, pending → `pending`); a denial result emits `failed`; `input-streaming` maps to
  `pending`; `write_file` sends the real `oldText` on overwrite; `edit_file` emits one diff per
  replacement (honoring `replaceAll`).
- **D10 — client-env metadata and signals.** When the client declares fs read/write, `exists` /
  `stat` first use local metadata (cheap, real mtime) and fall back to a client text read for a
  remote-only file, so a remote workspace is not blocked by a local `File not found`. A client-served
  `stat` derives `size` from that read and reports `mtime` as epoch (unknown — never a fabricated
  "now", which would make TTL checks treat the file as fresh). `readdir` has no ACP counterpart and
  stays on the local fallback (documented). A terminal exit with a signal reports `killed: true`.
  Remaining local-only operations and the whole-file read cost are documented.
- **D11 — live MCP reconciliation.** A `load`/`resume` that reuses a live bridge with a different
  `mcpServers` list fails with `invalidParams` (like `additionalDirectories`), rather than silently
  ignoring it.
- **D12 — catalog semantics.** `session/list` filters by the requested `cwd` (the session's
  workspace root) and skips rows with an invalid `updatedAt` instead of failing the page;
  `session/delete` of an already-gone session is a success (ACP SHOULD).
- **D13 — documentation follows code.** README/spec claims are corrected: live does not emit
  `user_message_chunk`, fork supports a non-live source (after the D2/D5 fixes), `cwd` is the
  session root, and commands are re-sent only because D8 subscribes to `extensions`.

## Risks / Trade-offs

- **D2 changes the identity contract** (`ACP id = disk id` becomes "handle starts as the disk id").
  Clients that assume equality still work for sessions they never replace; the divergence is
  documented and exposed in `session_info_update._meta`.
- **D1 costs one CoreEnv per session** and changes `session/list` scoping; a process serving many
  distinct workspaces now reads/writes multiple `.agents` trees. This is the correct ACP model.
- **D3 auto-approval is a security-sensitive default**; the policy is per session and only set by an
  explicit `allow_always`. The transcript still shows the tool call.
- **D4's timeout** can settle a slow human decision; 5 minutes is configurable and the notice says
  what happened.
- **D6 needs a small core signal** (finish reason). If core cannot expose it cheaply, the fallback is
  to infer `max_tokens` from `state`/usage; the task records which path was used.
- **Regression risk**: the existing validators missed cold-resume and approval-cancel because they
  reuse a live bridge; new cases must construct the cold path.

## Migration Plan

1. P0 fixes land together (cancel settlement, prime/resume, load replay, fork rebind, stop/error,
   cwd) with regression tests.
2. P1 (identity rebinding, `always`, elicitation settlement, extensions subscription, seed ordering,
   tool status/diff).
3. P2 (client-env metadata/signal, MCP reconciliation, list/delete, model metadata, compaction,
   dispatch errors, docs).
4. Each phase builds, typechecks, and runs the ACP validator suite; the repo-wide gates run once at
   the end. No public export or wire-breaking change beyond the documented conformance fixes.

## Open Questions

- `/clear` and `/resume` cannot retract a client's already-rendered transcript. The design emits a
  notice and exposes the new disk id; is that acceptable, or should those two commands be hidden
  from `available_commands_update` while `/clone` is rebound?
- Approval/elicitation timeout default (5 minutes) and whether it is configurable per host.
- `allow_always` scope for `run_command`: tool-level, or leading-program prefix (e.g. `git`)? The
  design uses the leading program so one `git push` does not auto-approve `rm -rf`.
- `session/list` without `cwd`: list the default root only (proposed) or every session the process
  has a root for?
