## Why

A three-part audit of `packages/acp` (ACP v1 conformance, comparison with six reference agents,
logic/edge-case review) found the host **capability-broad but not v1-complete**. These were
verified against the code and are user-visible:

- cancelling a permission dialog never settles the approval, so the run parks forever;
- a cold `session/resume` replays the retained transcript, and `session/load` replays tool calls
  but never tool results;
- `session/fork` re-keys the bridge without rebinding the per-session runtime/env;
- `lastFinishReason` is never written (`max_tokens` unreachable), and a failed run reports
  `end_turn` with no error text;
- `cwd` from `session/new|load|resume` is ignored (ACP says it MUST be the session root);
- `/clear`, `/clone`, `/resume` change the disk session id without rebinding the ACP id, and
  `allow_always` is advertised but never remembered.

The ACP specs already state the correct behaviour for several of these, so most of the work is
fixing the implementation and adding regression coverage — not changing the contract. Each
finding, with its reference implementation, is in `design.md`.

## What Changes

- **Session identity and lifecycle**: per-session `cwd` becomes the workspace root; slash commands
  that change the disk session id rebind the ACP id / bridge key / client-env session id; fork
  rebinds the same; live `load`/`resume` refuse rather than silently ignore a different
  `mcpServers` list; delete becomes idempotent for an already-gone session.
- **Replay correctness**: cold `resume` primes cursors without emitting; `load` replays the full
  conversation including tool results; the projector does not double-send on retained delivery.
- **Turn lifecycle**: a cancelled permission/elicitation settles the pending interaction; a
  failed run is visible (notice or agent message) before the stop reason; the stop reason maps
  `max_tokens` / `max_turn_requests` correctly; prompts are bounded when the client stops
  answering.
- **Interaction semantics**: `allow_always` / `reject_always` are actually remembered per session
  (or removed from the advertised options — decided: implement them); elicitation decline/cancel
  and request failure settle the tool as cancelled instead of hanging.
- **Updates**: `extensions` / `extension-ui` are **now** subscribed (command list refresh, notices);
  new-session seed updates are sent after the response; tool status/diff is accurate for denied,
  overwritten and `replaceAll` edits; compaction cache-cleanup warnings are not reported as
  compaction failures.
- **Client env**: metadata operations follow the client where it can serve them; a terminal exit
  by signal reports `killed`; the remaining local-only operations are documented.
- **Docs/spec drift**: correct README/spec claims that contradict the code (live user chunk, fork
  live-only, resume no-replay, commands re-send, cwd hint).

## Capabilities

### New Capabilities

None — the corrected behaviours belong to the existing ACP capabilities.

### Modified Capabilities

- `acp-agent-host`: per-session `cwd`, bounded prompt, visible run failure, correct stop reasons.
- `acp-session-catalog`: `cwd` filtering in `list`, idempotent `delete`, fork of a non-live source
  with rebinding, slash-command identity rebinding, model re-selection preserving metadata.
- `acp-user-interaction`: client-cancelled permission settles the approval, real `always`
  semantics, elicitation decline/cancel/failure settlement.
- `acp-session-updates`: tool status/diff accuracy, `extensions`/`extension-ui` subscription,
  seed ordering, error visibility, compaction status.
- `acp-client-env`: client-served metadata where possible, terminal signal reporting, documented
  local-only operations.
- `acp-session-mcp`: live `load`/`resume` reconcile `mcpServers` instead of ignoring them.
- `acp-prompt-content`: preserve prompt part order across text/image/audio/resource blocks.
- `acp-im-integration`: correct the IM contract's workspace-root sentence — per-session `cwd` is
  the root, with the process `cwd` as the fallback (the old wording said every session shares the
  process root).

## Impact

- **Code**: `packages/acp/src/{agent,projector,session-status,session-config-options,
  session-runtime,interactions,approvals,client-env,sessions,commands,content,tools}.ts`;
  small supporting changes in `packages/core` only where a missing signal must be exposed
  (e.g. finish reason / approval cancellation), not a change to core contracts.
- **Tests**: new regression cases for cancel-settles-approval, cold-resume-no-replay,
  load-replays-tool-results, fork rebinding, stop reasons, seed ordering; extend the existing
  `validate-acp-*` suites.
- **Docs**: `packages/acp/README.md` and the ACP specs corrected where they describe behaviour the
  code does not have.
- **Compatibility**: one **type-only** public export change — `ApprovalDecision` loses the dead
  `reason?: string` field (no runtime effect; TS consumers see it disappear). The ACP wire surface
  only becomes more conformant. `additionalDirectories`, real auth/providers, subagent sessions,
  fork lineage, HTTP/WS transport and ACP v2 stay out of scope (tracked separately).
