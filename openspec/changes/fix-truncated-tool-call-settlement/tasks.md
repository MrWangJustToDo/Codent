# Tasks

## 1. Truncation classification

- [x] 1.1 Add `hasTruncatedToolArguments(part, requiresProperties?)` to
      `packages/core/src/agent/stream/incomplete-tool-calls.ts`: `""`/whitespace → truncated; `"{}"` → truncated
      only when `requiresProperties` is `true`; `undefined` schema fact → not truncated. Verify with unit
      assertions in `packages/core/scripts/validate-incomplete-tool-calls.mjs` covering `""`, `"   "`,
      `"{}"` with/without a required-property schema, and a real call.
- [x] 1.2 Extend `isInFlightToolCall(part, requiresProperties?)` to reject truncated calls, and add
      `isTruncatedToolCall(part, requiresProperties?)` (non-settled, no pending approval, not in flight *because*
      of truncated arguments — an `awaiting-input` call counts). Verify: an `awaiting-input` call, an
      `input-complete` call with `""`, and an `input-complete` call with `"{}"` + required schema all read
      truncated; a valid `input-complete` call and an unstarted call without arguments do not.
- [x] 1.3 Thread the optional schema lookup through `settleToolCalls` / `cancelInFlightToolCalls` options
      (`requiresArguments?: (toolName: string) => boolean | undefined`) without changing their defaults. Verify:
      existing call sites compile and the validator's current cases still pass.

## 2. Settlement with its own text

- [x] 2.1 Add `TRUNCATED_TOOL_CALL_MESSAGE` and settle truncated calls through
      `settleToolCallsAs(messages, isTruncatedToolCall, TRUNCATED_TOOL_CALL_MESSAGE, …)` in
      `AgentChatController.applyCancelledIncompleteTools`, before the existing incomplete + in-flight
      passes (the **incomplete** pass is the one that produced the incident's rows), with the schema
      lookup read from the managed agent's tools. Verify: a transcript with one valid in-flight call and
      three zero-byte calls settles the valid one as `Cancelled by user.` and the other three with the
      truncation notice.
- [x] 2.2 Report the two groups separately in the `tool:settle` event (`calls` for cancelled,
      `truncatedCalls` for truncated) and update the event payload type. Verify: the emitted event lists three
      truncated ids and one cancelled id for the transcript above.
- [x] 2.3 Make the transcript read a truncated row as interrupted, not cancelled: `isCancelledToolCall`
      stays false for the truncation marker, and `getInlineSummary` reports the truncation notice instead of
      `cancelled`. Verify: a settled truncated part renders the notice and no cancelled state, while a truly
      cancelled part is unchanged.
- [x] 2.4 Make the abort path pass an explicit reason for its `denyPendingApprovals` call sites and keep
      `TOOL_CANCELLED_MESSAGE` only where an operator stop is the actual cause. Verify: `grep -n
      denyPendingApprovals packages/core/src/agent/run/chat-controller.ts` shows each call site with a reason
      chosen for its path, and the session-switch path no longer writes the user-cancel text.

## 3. Stream-boundary finalization

- [x] 3.1 Track, in `LifecycleMiddleware`, whether the current model call reached its terminal event
      (`RUN_FINISHED`) and how many tool-call starts it produced, and expose both to the deps. Verify: a
      normal call reports finished, and a stream whose generator ends early reports unfinished with its start
      count.
- [x] 3.2 In `AgentChatController.executeStream` (and its attempt wrapper), detect a call still
      `awaiting-input` or a required-arguments call left with empty arguments after a stream that never
      reached its terminal event, and finalize the turn as a stream error through the existing
      `applyCancelledIncompleteTools(…, { cause: "stream-error" })` + `finalizeChat({ kind: "error" })` path
      with a message naming the truncation. **Scope: this only fires when the attempt returns.** Verify: a
      fake adapter that emits two `TOOL_CALL_START`s and then returns produces an errored turn with two
      truncated rows and no Esc; a normal adapter is unaffected; an adapter that never returns is covered
      only if the stall guard below is adopted.
- [x] 3.3 Guard against false positives: skip the check when the attempt observed `RUN_FINISHED`, and when a
      pending interaction (`ask_user` / approval) is open. Verify: both cases stay `waiting`, not `error`.

## 4. Observability

- [x] 4.1 Emit one `session:diagnostic` (area `agent`, level `warn`) per malformed batch — more than one
      tool-call start with zero argument bytes by the attempt's end, or a repeated tool name beyond a small
      batch — recording counts and names only, never arguments. Verify: the fake adapter from 3.2 produces
      exactly one diagnostic row with the names and count.

## 5. Validation coverage

- [x] 5.1 Add a `validate:truncated-tool-call-settlement` script under `packages/core/scripts/` (registered in
      `packages/core/package.json`, glob-collected by `validate:all`) covering: classification, the split
      settlement, the transcript reading, the stream-boundary error, and the diagnostic row.
- [x] 5.2 Mutation-verify the new validator: remove the truncation pass (or the `""` branch) and confirm the
      validator fails; restore and re-run green.
- [x] 5.3 Run `pnpm --filter @codent/core build`, `validate:incomplete-tool-calls`,
      `validate:truncated-tool-call-settlement`, `validate:run-abort-ownership`, `validate:suppress-replayed-tool-chunks`,
      `pnpm lint`, `pnpm typecheck` and confirm each passes.

## Open decision

- **A stream that never ends.** RESOLVED: option **(b)** was chosen. The timer is armed only while at
  least one tool call is open (`TOOL_CALL_START` … `TOOL_CALL_END`), so tool execution and a slow first
  token are never timed; `streamStallTimeoutMs` is exposed through `AgentSessionCreateOptions` and the
  server create body, and `0` disables it. Implementation note: the tracking lives in
  `agent/run/model-stream-observer.ts` (wrapped by `runManagedSpan`) rather than in
  `LifecycleMiddleware` — it sees the same chunk sequence at the consumption point and is shared by the
  root pump and subagent workers.

## Workflow follow-up

- Archive the change once review is satisfied, syncing the delta into
  `openspec/specs/truncated-tool-call-settlement/spec.md` and updating `run-abort-ownership`.
- Commit the fix on its own, then verify CI before pushing.
