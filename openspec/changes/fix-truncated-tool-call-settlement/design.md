# Design

## Context

See `proposal.md` — Why. The behaviour is defined by `specs/truncated-tool-call-settlement/spec.md` and
the delta to `run-abort-ownership`.

## Measured evidence (session `ses_mwf366wx_l1bzec`)

Replaying the session file and its log fixes what this change must cover, and corrects two
assumptions from the first draft of this design:

- The last assistant message holds 166 parts — 83 `tool-call` + 83 `tool-result`. Every call carries
  `arguments: ""` (zero bytes). Names: `run_command` 35, `read_file` 31, `grep` 11, `list_file` 3,
  `glob` 2, `todo` 1.
- Every result is the shared cancel marker:
  `{ success: false, error: "Cancelled by user.", cancelled: true, reason: "Cancelled by user." }`.
- The attempt logged `llm:request [iter 1]` and **no `llm:response` at all** (17 requests / 16
  responses in the session; the missing one is this attempt). `tool:phase` never fired,
  `turn:summary` reported `0 phases, 83 tools`, and the turn ended only when the user pressed Esc
  20 s later (`agent:abort (user-cancelled)`).
- The settlement came from the **incomplete** pass, not the in-flight pass: the persisted parts
  settle as `state: "error"` (the incomplete pass's state), and `isInFlightToolCall` already rejects
  a zero-byte call because `hasValidToolArguments` is false for `""`.

Current state that shapes the approach:

- `attemptStream` consumes `chat()` in a `for await`. In this incident `onFinish` never ran — there
  is no `llm:response` row, and `executeStream` had not returned when Esc arrived. Whether the
  adapter's stream was still open or the engine stalled after the last chunk cannot be separated
  from the log; see "Open decision: what covers a stream that never ends".
- `hasValidToolArguments` delegates to `tryParseToolArguments`, which returns `{ ok: false }` for
  `""`. So the zero-byte call is NOT treated as ready to execute — `isInFlightToolCall` already
  excludes it. The predicate that accepts it is `isCancellableIncompleteToolCall` (it covers
  `input-streaming`, `awaiting-input`, and `input-complete` with invalid arguments), which is the
  pass that actually settled the 83 rows.
- Every settle writer in `AgentChatController` passes the constant `TOOL_CANCELLED_MESSAGE`
  (`applyCancelledIncompleteTools`, `denyPendingApprovals`, the turn-end pass), and
  `isCancelledToolCall` recognises that string, so any settle reads as `cancelled` in the
  transcript — including the incomplete pass above.
- Options whose schema has no required field legitimately end with `arguments: "{}"` — so "zero bytes"
  and "empty object" cannot share one predicate.

## Goals / Non-Goals

**Goals:**

- One classification of "this call never received its arguments", used by both the settle predicates and
  the per-call truncation detector.
- A never-ran call is settled with its own text and does not present as a user cancellation, whichever
  settle pass reaches it first.
- A response that ends inside a tool-call stream becomes a recorded failure at the stream boundary, so a
  response that already ended mid-batch never needs Esc to end the turn.
- Malformed batches are observable in the run log.

**Non-Goals:**

- Changing TanStack. The terminal check is ours, reading the events we already receive.
- Adding a general stream timeout for slow providers. The boundary check reacts to a response that
  already ended; a stall guard, if adopted (see the open decision), is scoped to attempts that already
  produced a tool-call start.
- Rerouting models or tools on a malformed response.

## Decisions

### Classification: one rule, three readers

Zero-byte arguments (`""`, whitespace) and an opened-but-unclosed JSON payload (the stream stopped
inside the arguments) are always truncated. Empty object (`{}`) is truncated only when the tool's
schema **requires** a property; `list_file`, `glob` and friends are called with `{}` every day.

- `hasTruncatedToolArguments(part, requiresProperties?)` → `true` for `""`/whitespace, for an opened
  JSON payload that never parsed, and for `{}` when the schema requires something.
- `isInFlightToolCall(part, requiresProperties?)` → additionally rejects the truncated shapes. It
  already rejects `""` through `hasValidToolArguments`; the change makes that explicit and extends it
  to `{}`-with-required-schema so the two predicates cannot disagree.
- `isTruncatedToolCall(part, requiresProperties?)` → a non-settled, non-approval-pending call that is not
  in flight **because** its arguments are truncated (not because it is merely unstarted).

The schema fact comes from the tool registry through a small injected lookup
(`(name) => requiredProperties | undefined`), defaulting to "unknown" so server-side helpers stay pure.
Alternatives considered: (a) treat every `{}` as truncated — breaks the calls made with no arguments every
day (`list_file`, `glob`); (b) only `""` — misses a required-argument call the engine has already
normalised to `{}`, which is the same failure one layer later.

The predicate is only consulted at boundaries — abort, stream end, turn end, restore. A call sitting in
`awaiting-input` **during** a live stream is legitimate work in progress; it becomes truncated only once
the attempt that was filling it is over.

### Settlement: a truncated pass that runs BEFORE the cancel passes

`applyCancelledIncompleteTools` settles truncated calls first —
`settleToolCallsAs(messages, isTruncatedToolCall, TRUNCATED_TOOL_CALL_MESSAGE, …)` — and only then runs
the existing incomplete + in-flight passes. Order is the mechanism: both later passes skip a part that
already carries an output, so a truncated call is settled by its own text and never reaches the cancel
pass. This matters most for the **incomplete** pass, which is what settled this incident (a zero-byte
`input-complete` call is its candidate; `isInFlightToolCall` was already false). The result carries
`clearDisplay: true`, which forces the display to be recomputed from the new output, so the row renders
the truncation notice, not a cancel.

The `tool:settle` event reports the two groups separately (`calls` = cancelled, `truncatedCalls` = the
truncation group) instead of merging them, because the timeline row's purpose is attribution.

Alternative: one pass with a per-part `outputFor` returning different markers. Rejected: the shared
`cancelled: true` marker is read by `isCancelledOutputMarker`, and per-part branching inside one pass is
exactly the "decide with a second predicate copy" drift the existing comments warn about.

### Cancellation text is per reason, not per constant

`denyPendingApprovals` already takes a reason; the remaining call sites choose it explicitly:
`TOOL_CANCELLED_MESSAGE` for an operator stop, a session-switch/teardown reason for those paths. No new
type is needed because the reason string is the only thing any consumer reads, and the message flows into
`tool:settle` unchanged.

### Truncated detection at the stream boundary uses existing primitives

At the end of each `executeStream` attempt, core asks its own channel two questions:

- a non-settled call in `awaiting-input` (never received a single argument byte), or
- an unsettled call whose tool schema requires arguments but whose arguments are empty/`{}`.

If either holds after the stream returned, the turn is finalized as a stream error through the existing
`applyCancelledIncompleteTools(…, { cause: "stream-error" })` + `finalizeChat({ kind: "error" })` path,
with the message naming the truncation. This reuses the tested error path; it does not add a second
finalization route.

**Reachability matters.** That check runs only when the attempt RETURNS. The measured incident cannot
be shown to have returned before Esc (no `llm:response`, `0 phases`), so this decision is scoped to "the
response ended" and the stalled shape is tracked separately — see the open decision below. Do not
describe this check as covering a stream that stops advancing.

Why not surface a synthetic `RUN_ERROR` chunk: the chunk would have to be yielded from inside the async
generator after the engine already stopped producing; the engine has no hook for it, and finalizing at the
consumer is what the pump already does for real errors.

False-positive guard: a call `awaiting-input` **after** an explicit `RUN_FINISHED` is not a truncation of
the stream we are reacting to; the detectors are only consulted when the attempt's terminal event never
arrived.

### Batch shape logging

A `session:diagnostic` (area `stream`, level `warn`) is emitted when one attempt produced more than one
tool-call start and any of: a start had no argument bytes by the attempt's end, or a tool name repeats
beyond a small batch. It records counts and names only — never arguments.

### Open decision: what covers a stream that never ends

The boundary check above is reachable only after the attempt returns, and the incident's log cannot
prove it did. Core has no timeout on a model stream at all — there is no watchdog to reuse — so
covering the stalled shape is a scope decision, not a detail:

- **(a) Boundary check + diagnostic only (recommended for this change).** The transcript stops lying,
  the model wire stops carrying fake cancellations, and the next occurrence is attributable from the
  log — but a stalled attempt still needs Esc.
- **(b) Add a bounded stall guard.** While at least one tool call is OPEN (announced by
  `TOOL_CALL_START` and not yet closed by `TOOL_CALL_END`), abort the attempt when no chunk arrives for
  N seconds, with a reason that distinguishes the stall from a user cancel, then finalize as a stream
  failure. Covers the unresolved shape. The window is deliberately "waiting for arguments", not "a
  start has ever been seen": TanStack executes tools inside the same async iterable and produces no
  chunks while doing so, so a whole-attempt timer would kill a legitimate long `run_command` / `task`.
  A slow first token and a long reasoning phase are outside the window for the same reason. The value
  is configurable (`streamStallTimeoutMs`) and `0` disables it.
- **(c) Classification + settlement only.** The rows stop claiming a user cancel; the turn still parks
  until Esc.

Until (b) is chosen, read every "the stream ends" statement in this change as "the response ended".

## Risks / Trade-offs

- [Strictness on `{}`] A tool whose schema requires a property may be called with `{}` and expect the
  built-in's own validation error → Mitigation: the settle only *skips* it from the "in flight" set; the
  normal tool phase still executes it and its error reaches the model as before. The truncation predicate
  is only consulted at the abort/stream-end boundaries, where an unexecuted required-args call cannot run.
- [Turn ending as an error] A provider that legitimately returns `awaiting-input` placeholders before a
  continuation would now be cut short → Mitigation: the terminal-event guard; a response that resumes in
  the same stream (Anthropic-style) still emits `TOOL_CALL_ARGS`, so the call is no longer `awaiting-input`
  at the check.
- [Stalled stream still parks] Choosing (a) leaves the stalled shape on Esc → Mitigation: (b) was
  chosen; the open-call window keeps tool execution out of the timer, and the stall is finalized with
  `TOOL_RUN_ENDED_MESSAGE` rather than the user-cancel text.
- [Two passes over the transcript] O(n) twice per abort → acceptable (abort is rare, transcripts are
  bounded by compaction).
- [Log volume] A malformed batch writes one diagnostic row → bounded by one per attempt.

## Migration Plan

No data migration. Existing sessions keep their stored `Cancelled by user.` rows; new aborts settle
truncated calls with the new notice. Rollback is a revert of the settlement passes — the write path has no
persisted schema change (the synthetic marker shape is unchanged: `{ success, error, cancelled, reason }`).
