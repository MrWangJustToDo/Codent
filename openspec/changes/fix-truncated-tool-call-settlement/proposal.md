# Proposal

## Why

A single model response can arrive as a batch of `TOOL_CALL_START` placeholders with **zero bytes of
arguments**, and then either end or stop advancing. The session `ses_mwf366wx_l1bzec` recorded exactly
that: one `llm:request`, no `llm:response`, no `tool:phase`, and a turn that only ended when the user
pressed Esc 20 s later. The abort path then settled **83 fake tool rows** as `Cancelled by user.`

The rows came from the incomplete-settlement pass, not from the tool loop executing anything:
`isCancellableIncompleteToolCall` accepts a zero-byte call, and every settle writer uses the one
`TOOL_CANCELLED_MESSAGE` constant. Nothing runs, but the transcript claims 83 tools were cancelled, the
badge misattributes the cause, the model wire carries 83 cancel results, and nothing tells the model —
or the log — that the response never supplied its arguments.

## What Changes

- A tool call whose arguments never arrived (zero-byte / empty object) is no longer treated as
  cancellable work: it is classified as truncated, never executed, and never reported as a user
  cancellation.
- When a model response ends inside a tool-call stream without its final chunk, the run is settled as a
  stream failure at the stream boundary instead of parking until the user aborts. (The shape where the
  stream never ends is a separate decision — see Open Decisions.)
- **BREAKING (internal signature)**: `cancelInFlightToolCalls` / `settleToolCalls` accept a predicate
  that may also report truncated calls, plus an optional `requiresArguments` lookup, so a caller can
  settle "never ran" rows with their own text without touching the user-cancel path.
- The cancellation reason on a settled call is preserved end-to-end instead of being collapsed into
  `Cancelled by user.`.
- New validation coverage locks all of the above, including a mutation check (removing the truncation
  predicate must fail the validator).

## Capabilities

### New Capabilities

- `truncated-tool-call-settlement`: how a tool call that never produced arguments is classified,
  settled, displayed, and reported to the model, and how a model response that ends mid-tool-call is
  turned into a stream failure rather than an open turn.

### Modified Capabilities

- `run-abort-ownership`: the abort path must not relabel rows it did not cause. The existing
  "abort cancellation of in-flight tool work" requirement gains the rule that a truncated call is not
  in-flight work and must not be settled as a user cancellation.

## Impact

- `packages/core/src/agent/stream/incomplete-tool-calls.ts` — truncation classification and the
  settle helpers (`isInFlightToolCall`, `hasValidToolArguments`, `cancelInFlightToolCalls`,
  `settleToolCalls`).
- `packages/core/src/agent/run/chat-controller.ts` — where the abort/settle text originates and where a
  mid-stream truncation is detected.
- `packages/core/src/agent/tools/presentation/state.ts` / `format/inline-summary.ts` — a truncated row
  must not read as `cancelled`.
- `packages/core/scripts/validate-incomplete-tool-calls.mjs` + the new
  `validate:truncated-tool-call-settlement` — regression and mutation coverage.
- No host (`packages/app`, `packages/acp`, `packages/cli`, `packages/server`) API change: the fix stays
  inside core's stream/settlement layer.

## Open Decisions

- **A stream that never ends.** The measured incident has no `llm:response` and `0 phases`, so it is not
  provable that the attempt returned before Esc, and core has no model-stream watchdog to reuse. The
  boundary check covers "the response ended"; covering "the stream stopped advancing" needs a bounded
  stall guard (armed only after a `TOOL_CALL_START`, configurable) and is a scope decision recorded in
  `design.md` ("Open decision: what covers a stream that never ends"). The classification, settlement and
  presentation fixes are independent of that choice and should not wait for it.
- **Settlement pass identity.** The fix targets the *incomplete* settle pass, which is what produced the
  83 rows; the in-flight pass never matched them.
