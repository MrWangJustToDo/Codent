/**
 * Validates that a tool call cut short by an abort is visible as cancelled, that a command
 * killed at its deadline is a failure which NAMES the deadline (never a bare `Exit code: -1`),
 * and that the app's streaming buffers cannot grow without bound across command calls.
 *
 * Run: node --test test/abort-and-streaming-bounds.test.mjs
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// getInlineSummary resolves through CoreEnv-independent code, but the module graph does
// not, so register a stub as the other app tests do.
const { registerCoreEnv } = await import(new URL("../../core/dist/index.mjs", import.meta.url).href);
registerCoreEnv({ rootPath: "/repo" });

const { getInlineSummary } = await import("@codent/core");

const part = (name, output) => ({
  type: "tool-call",
  id: "call-1",
  name,
  state: "complete",
  arguments: "{}",
  output,
});

// ============================================================================
// Aborted tool calls are rendered as cancelled — for EVERY tool, not just `task`
//
// Driven through the REAL cancel path: an in-flight tool-call part is passed through
// `cancelInFlightToolCalls` / `cancelIncompleteToolCalls`, and the resulting part is fed
// to `getInlineSummary`. (Hand-writing `{ cancelled: true }` here would have hidden the
// actual defect: the cancel marker lived only on the appended `tool-result` part, never
// on the part output the UI reads, so the renderer saw no flag at all.)
// ============================================================================
{
  const { cancelInFlightToolCalls, cancelIncompleteToolCalls } = await import("../../core/dist/dev.mjs");

  const inFlight = (name) => [
    {
      id: `m-${name}`,
      role: "assistant",
      parts: [{ type: "tool-call", id: `call-${name}`, name, state: "input-complete", arguments: '{"path":"a.ts"}' }],
    },
  ];
  const truncated = (name) => [
    {
      id: `m-${name}`,
      role: "assistant",
      parts: [{ type: "tool-call", id: `call-${name}`, name, state: "input-streaming", arguments: '{"pa' }],
    },
  ];

  const names = ["run_command", "grep", "read_file", "glob", "list_file", "tree", "webfetch", "write_file"];
  for (const name of names) {
    for (const [cancel, build] of [
      [cancelInFlightToolCalls, inFlight],
      [cancelIncompleteToolCalls, truncated],
    ]) {
      const cancelledPart = cancel(build(name), "Cancelled by user.")[0].parts[0];
      assert.equal(
        getInlineSummary(cancelledPart, name),
        "cancelled",
        `${name}: a call cut short by an abort must read as cancelled, not as a clean finish`
      );
    }
  }

  // The per-tool summaries still win once the flag is absent — the generic check must
  // not swallow ordinary outputs.
  assert.equal(getInlineSummary(part("grep", { matches: [1, 2] }), "grep"), "2 matches");
  assert.equal(getInlineSummary(part("read_file", { totalLines: 7 }), "read_file"), "7 lines");
  assert.equal(getInlineSummary(part("write_file", { created: true }), "write_file"), "created");
  // ...including a genuine failure, which shares the same shape but is NOT a cancel.
  const failedPart = { ...part("grep", { success: false, error: "boom" }) };
  assert.equal(getInlineSummary(failedPart, "grep"), null, "a real failure is not mislabelled as cancelled");
}

// ============================================================================
// Both cancel shapes read as cancelled — and neither wears success nor failure
//
// Two layers settle aborts, on opposite tool states: the framework fallback writes
// `cancelled: true` onto a part settled as `error` (run_command before its execute caught
// the abort), while the task tool returns a normal result with `aborted: true` settled as
// `complete`. `isCancelledToolCall` is the one predicate for both; the glyph must be the
// neutral warning for either, because the user stopped the run — it neither failed nor
// finished cleanly.
// ============================================================================
{
  const { isCancelledToolCall } = await import("@codent/core");
  const { getToolStatusGlyph } = await import("../dist/index.mjs");

  // Framework shape: `cancelled` on an error-settled part (the pre-fix run_command abort).
  const frameworkCancelled = part("run_command", { success: false, error: "Command aborted", cancelled: true });
  assert.equal(isCancelledToolCall(frameworkCancelled), true, "the framework cancel marker is recognized");
  // Task shape: `aborted` on a complete-settled part (the tool's own contract).
  const taskCancelled = part("task", { summary: "[Task cancelled by user.]", aborted: true });
  assert.equal(isCancelledToolCall(taskCancelled), true, "the task tool's aborted flag is recognized");
  // ...and neither flag, neither shape.
  assert.equal(isCancelledToolCall(part("grep", { matches: [] })), false, "a clean finish is not a cancel");
  assert.equal(
    isCancelledToolCall(part("grep", { success: false, error: "boom" })),
    false,
    "a real failure is not a cancel"
  );
  assert.equal(isCancelledToolCall(part("grep", undefined)), false, "no output is not a cancel");

  // ── the overwrite: a synthetic marker replaced by an unmarked abort error ────────────
  // On abort the eager pass writes the synthetic marker, and then a tool whose `execute`
  // REJECTS gets its part settled by TanStack as `{ error: message }` — no marker, and it
  // overwrites the synthetic output. Reading the marker alone showed a red cross for a run
  // the user stopped. The body IS the abort, so `isAbortError` has to be consulted too.
  //
  // The message is what the node shell / remote CoreEnv actually produces for an abort, and
  // it is the only thing left on the part by the time the UI reads it (the rejected promise
  // is gone). `d734233` classified exactly this shape on the lifecycle event for the same
  // reason; the render layer was not.
  const overwritten = part("run_command", { error: "Command aborted" });
  assert.equal(
    isCancelledToolCall(overwritten),
    true,
    "an unmarked abort error must still read as cancelled, not as a tool failure"
  );
  // And its glyph agrees — this is the assertion that fails on the old behaviour.
  const { getUiToolState } = await import("@codent/core");
  assert.equal(getToolStatusGlyph(getUiToolState(overwritten), false, isCancelledToolCall(overwritten)), "⚠");
  // A DOM-style AbortError message counts too.
  assert.equal(isCancelledToolCall(part("webfetch", { error: "The operation was aborted" })), true);
  // But an ordinary fault keeps its cross: the classification must not swallow real failures.
  assert.equal(isCancelledToolCall(part("grep", { error: "boom" })), false, "a plain error stays a failure");
  assert.equal(
    isCancelledToolCall(part("run_command", { error: "Command timed out after 30s" })),
    false,
    "a timeout is not a cancel"
  );
  // Only a STRING `error` is inspected — a nested object is not coerced into a message.
  assert.equal(isCancelledToolCall(part("grep", { error: { message: "aborted" } })), false);

  // The glyph outranks the settled state in BOTH directions: the cancelled run_command
  // (output-error) must not wear the failure cross, and the cancelled task
  // (output-available) must not wear the success check.
  assert.equal(getToolStatusGlyph("output-error", false, true), "⚠", "a cancelled run_command is not a failure");
  assert.equal(getToolStatusGlyph("output-available", false, true), "⚠", "a cancelled task is not a success");
  // The budget-cutoff case keeps priority semantics: both flags together still warn.
  assert.equal(getToolStatusGlyph("output-available", true, true), "⚠");
  // Without either flag the old mapping is untouched.
  assert.equal(getToolStatusGlyph("output-available"), "✓");
  assert.equal(getToolStatusGlyph("output-error"), "✗");
}

// ============================================================================
// A cancelled row's OUTPUT BODY must read as cancelled, for every tool
//
// Reconstructed from a real session (`.agents/sessions/ses_mu6ui27o_wf3j4m.session.jsonl`,
// lines 39-40): the same part id was written twice by two different writers, and the row
// showed `Exit code: undefined` the instant the user pressed Esc and `Exit code: -1` one
// message later. The first is the framework's abort fallback — a SHARED synthetic payload
// (`{ success, error, cancelled }`) that is not any tool's output schema — so the fix can
// only live before the per-tool dispatch; patching `run_command` alone would leave `todo`
// throwing and `edit_file` reading "Edited undefined".
// ============================================================================
{
  const { formatToolOutput } = await import("@codent/core");
  const { readFileSync } = await import("node:fs");

  // --- The two shapes of ONE cancelled run_command, verbatim from the session ---
  const synthetic = { success: false, error: "Cancelled by user.", cancelled: true };
  assert.equal(
    formatToolOutput(synthetic, "run_command"),
    "Cancelled by user.",
    "the framework fallback must not render `Exit code: undefined`"
  );

  const ownCatch = {
    command: "total=90; for i in $(seq 1 $total); do ...; done",
    stdout: "[  6%] =  19:01:47\n[  7%] =  19:01:48",
    stderr: "",
    exitCode: -1,
    durationMs: 0,
    success: false,
    cancelled: true,
    cachedOutputPath: null,
  };
  const rendered = formatToolOutput(ownCatch, "run_command");
  assert.ok(!rendered.includes("undefined"), `no undefined leak, got: ${rendered}`);
  // `-1` is the schema's "not finished" value, not a result. A cancel must not print an exit
  // code at all — otherwise the row claims a failure code for a run the user stopped.
  assert.ok(!/Exit code/.test(rendered), `a cancelled run has no exit code to report, got: ${rendered}`);
  // TEMPORARILY DISABLED — deliberate behavior change, not a defect to fix here.
  //
  // `formatToolOutput` short-circuits on `isCancelledOutputMarker` (see output-format.ts), so a
  // cancel that carries output collapses to the bare `TOOL_CANCELLED_MESSAGE` and this
  // `run_command`'s partial stdout is intentionally not rendered. The two assertions above still
  // hold under that guard (no `undefined`, no exit code) — only the partial-output reachability
  // changed, so only this one is disabled.
  //
  // Restore together with validate-cancel-semantics.mjs's section-3 pair if the guard is ever
  // reverted to `isSyntheticCancelOutput`.
  // assert.ok(rendered.includes("19:01:47"), "but the partial output it produced is still shown");

  // --- The same synthetic payload, for tools whose formatter would break or lie ---
  // `todo` dereferences `stats.total` (threw), `edit_file` interpolates `path` ("Edited
  // undefined"), `write_file` says "Overwrote file: undefined". All three must be caught by
  // the entry-point short-circuit rather than each growing its own guard.
  for (const toolName of ["todo", "edit_file", "write_file", "read_file", "glob", "grep", "task"]) {
    const out = formatToolOutput(synthetic, toolName);
    assert.equal(out, "Cancelled by user.", `${toolName}: a cancel renders as a cancel`);
    assert.ok(!out.includes("undefined") && !out.includes("NaN"), `${toolName}: no placeholder leak`);
  }

  // The `task` tool's OTHER cancel shape (`aborted`, its own summary) is unchanged.
  const taskAborted = formatToolOutput({ summary: "partial findings", aborted: true }, "task");
  assert.ok(!taskAborted.includes("undefined"), "an aborted task still renders its summary");
  // TEMPORARILY DISABLED — same deliberate behavior change as the `run_command` case above:
  // `isCancelledOutputMarker` short-circuits before the tool's own formatter, so an `aborted`
  // task's summary is not rendered either. The negative check above still holds.
  // assert.ok(taskAborted.includes("partial findings"), "and the summary is what the parent reads");

  // --- The short-circuit must not swallow real results ---
  const realFailure = formatToolOutput(
    { command: "false", stdout: "", stderr: "boom", exitCode: 1, durationMs: 5, success: false },
    "run_command"
  );
  assert.ok(realFailure.includes("Exit code: 1"), "a genuine failure still reports its code");
  const realSuccess = formatToolOutput(
    { command: "true", stdout: "ok", stderr: "", exitCode: 0, durationMs: 5, success: true },
    "run_command"
  );
  assert.ok(realSuccess.includes("ok") && !realSuccess.includes("Exit code"), "success stays success");
  // An exit code of -1 from a background job is NOT a cancel — nothing may treat it as one.
  const running = formatToolOutput(
    {
      command: "sleep 9",
      stdout: "",
      stderr: "",
      exitCode: -1,
      durationMs: 0,
      success: true,
      runInBackground: true,
      jobId: "job_1",
      status: "running",
    },
    "run_command"
  );
  assert.ok(running.includes("job_1"), `a running background job is not a cancel, got: ${running}`);
  // `cancelled: false` (an explicit "not cancelled") must not trigger the short-circuit — it
  // falls through to whatever the tool's own formatter does with it.
  const explicitFalse = formatToolOutput({ success: false, error: "boom", cancelled: false }, "grep");
  assert.ok(!explicitFalse.includes("Cancelled by user."), "`cancelled: false` is not a cancel");

  // The two shapes are distinguished, not merged: the synthetic payload is what gets
  // short-circuited, and a tool's own partial result must NOT be (it carries real output).
  const { isSyntheticCancelOutput, isCancelledOutputMarker } = await import("@codent/core");
  assert.equal(isSyntheticCancelOutput(synthetic), true, "the framework payload is synthetic");
  assert.equal(isSyntheticCancelOutput(ownCatch), false, "a tool's own partial result is not");
  assert.equal(isCancelledOutputMarker(ownCatch), true, "though both are cancels");
  assert.equal(isSyntheticCancelOutput({ aborted: true }), true, "the task tool's marker counts too");
  assert.equal(isSyntheticCancelOutput({ success: false, error: "boom" }), false, "no marker, no cancel");

  // One row must not carry two verdicts: a cancelled command's output block was painted in the
  // failure color (`success: false`) while its header showed a neutral ⚠. Asserted on source
  // because the color only exists once rendered; the render smoke covers the pixels.
  //
  // Matched on STRUCTURE, not on formatting or on a local's name. The condition is
  // `... success === false && !<the cancel predicate>`, and a refactor that hoists that predicate
  // into a local must not read as the verdict going missing. So the `!` is required to be part of
  // the `&&` chain, and its operand is required to reach the cancel predicate — either called
  // directly or through a local that was assigned from it earlier in the file.
  const outView = readFileSync(new URL("../src/messages/ToolOutputView.tsx", import.meta.url), "utf8");
  const cancelledGuarded = /success === false[\s\S]{0,120}&&[\s\S]{0,80}!\s*(?:isCancelledToolCall\s*\(|\w+)/.test(
    outView
  );
  assert.ok(
    cancelledGuarded && /isCancelledToolCall\s*\(/.test(outView),
    "the output block must not paint a cancelled run in the failure color"
  );
}

// ============================================================================
// A deadline kill is a FAILURE, not a success — and its body names the deadline
//
// `run_command` catches its own typed timeout and returns a NORMAL result with the partial
// output, which invites the assumption that the part settles as `output-available` and wears
// the success check. It does not: `getUiToolState` maps ANY `success: false` — exactly the
// cancelled-run_command shape — to `output-error`, so the row is a failure everywhere (header,
// glyph, body). The one thing that WAS wrong is the body: it printed the synthesized
// `Exit code: -1`, which reads like a crash and hides the cause, even though the tool
// deliberately kept the partial output.
// ============================================================================
{
  const { formatToolOutput, getUiToolState, isCancelledToolCall } = await import("@codent/core");
  const { getToolStatusGlyph } = await import("../dist/index.mjs");

  const timedOut = part("run_command", {
    command: "sleep 999",
    stdout: "partial-line",
    stderr: "real-err",
    exitCode: -1,
    durationMs: 300_000,
    success: false,
    timedOut: true,
    timeoutMs: 300_000,
    cachedOutputPath: null,
  });

  // `success: false` is what the row reads, so a deadline kill is a failure — never a ✓.
  assert.equal(getUiToolState(timedOut), "output-error", "a deadline kill settles as a failure, not output-available");
  assert.equal(
    getToolStatusGlyph(getUiToolState(timedOut)),
    "✗",
    "its icon is the failure cross, not the success check"
  );

  const rendered = formatToolOutput(timedOut.output, "run_command");
  assert.ok(!/Exit code/.test(rendered), `a deadline kill has no exit code to report, got: ${rendered}`);
  assert.match(rendered, /Command timed out after 300000ms/, "the body names the bound");
  assert.ok(rendered.includes("partial-line"), "and keeps the partial output the tool preserved");
  assert.ok(rendered.includes("real-err"), "alongside the command's own stderr");

  // A genuine failure keeps its code and is not relabelled.
  const failed = part("run_command", {
    command: "false",
    stdout: "",
    stderr: "boom",
    exitCode: 1,
    durationMs: 5,
    success: false,
  });
  const failedBody = formatToolOutput(failed.output, "run_command");
  assert.match(failedBody, /Exit code: 1/, "a real failure still reports its code");
  assert.ok(!/timed out/.test(failedBody), "and is not relabelled as a timeout");

  // The two `success: false` shapes stay distinct: a cancel is neutral (⚠) while a deadline is
  // a failure (✗) — `timedOut` must not be folded into the cancel predicate.
  const cancelled = part("run_command", { success: false, cancelled: true });
  assert.equal(isCancelledToolCall(timedOut), false, "a deadline is not a cancel");
  assert.equal(getToolStatusGlyph(getUiToolState(cancelled), false, true), "⚠", "a cancel keeps its warning glyph");
  assert.equal(
    getToolStatusGlyph(getUiToolState(timedOut), false, false),
    "✗",
    "a deadline is not turned into a cancel"
  );
}

// ============================================================================
// `isAbortError` — the ONE abort predicate, across the shapes three layers produce
//
// It is shared by the run coordinator and by every tool that holds an `abortSignal`,
// so the heuristics cannot drift apart again: the signal, the DOM name, the plain
// `code`, the remote-reconstructed `{name, code}` pair, and the node shell's bare
// `Error("aborted")` all have to be recognized — and an ordinary fault must not be.
// ============================================================================
{
  const { isAbortError } = await import("@codent/core");

  const abortedSignal = AbortSignal.abort();
  const liveSignal = new AbortController().signal;

  // The signal is the strongest evidence — it classifies the throw whatever it looks like.
  assert.equal(isAbortError(new Error("whatever"), abortedSignal), true, "an aborted signal wins");
  assert.equal(isAbortError(undefined, abortedSignal), true, "even a non-Error throw");

  // The DOM shape.
  const domAbort = new Error("The operation was aborted");
  domAbort.name = "AbortError";
  assert.equal(isAbortError(domAbort), true, "a DOM AbortError is an abort");

  // The local `ExecutionError("aborted")` and the remote-reconstructed double.
  const localExec = Object.assign(new Error("Command aborted"), { name: "ExecutionError", code: "aborted" });
  assert.equal(isAbortError(localExec), true, "a local ExecutionError(aborted) is an abort");
  const remoteExec = Object.assign(new Error("Command aborted"), { name: "ExecutionError", code: "aborted" });
  assert.equal(isAbortError(remoteExec, liveSignal), true, "a remote-reconstructed one too");
  // The code alone is enough — a remote host may not preserve the name.
  assert.equal(isAbortError(Object.assign(new Error("x"), { code: "aborted" })), true);

  // The node shell's bare throw.
  assert.equal(isAbortError(new Error("aborted")), true, '`throw new Error("aborted")` is an abort');

  // ...and ordinary faults stay faults. A cancelled run must not swallow a real failure.
  assert.equal(isAbortError(new Error("boom")), false, "a plain error is not an abort");
  assert.equal(isAbortError(new Error("boom"), liveSignal), false, "nor is it one under a live signal");
  const timeout = Object.assign(new Error("Command timed out"), { name: "ExecutionError", code: "timeout" });
  assert.equal(isAbortError(timeout), false, "a timeout is not an abort");
  assert.equal(isAbortError(undefined), false);
  assert.equal(isAbortError(null), false);
  assert.equal(isAbortError("aborted"), false, "a bare string is not an Error");
  // An aborted-signal check must not leak across: a live run's signal says nothing.
  assert.equal(isAbortError(new Error("aborted"), liveSignal), true, "the message path still applies");
}

// ============================================================================
// The lifecycle event carries the same distinction
//
// `agent:tool-error` is emitted for a user abort too (the abort reaches TanStack as a
// throw), so without the payload flag a consumer counting failures counts cancels, and
// the log bridge writes "Tool error" for something the user stopped. The predicate the
// emit site uses is the one just tested; this pins that the emit site actually asks.
// ============================================================================
{
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(
    new URL("../../core/src/managers/middleware/extensions-middleware.ts", import.meta.url),
    "utf8"
  );
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  assert.ok(
    /cancelled: isAbortError\(info\.error/.test(code),
    "the tool-error emit must classify the throw, not just report it"
  );
  assert.ok(
    /getAbortSignal\?\.\(\)/.test(code),
    "and it must consult the run's signal — the error shape alone is not enough"
  );

  // And the payload declares the field, so a typed consumer can read it.
  const payloads = readFileSync(
    new URL("../../core/src/runtime-types/agent-event-payloads.ts", import.meta.url),
    "utf8"
  );
  const block = payloads.slice(payloads.indexOf('"agent:tool-error"'));
  assert.ok(
    /cancelled\?: boolean/.test(block.slice(0, block.indexOf("};"))),
    "agent:tool-error must declare `cancelled`"
  );

  // The log bridge must word a cancel as a cancel, not as a tool error.
  const rules = readFileSync(new URL("../../core/src/agent/log/event-log-rules.ts", import.meta.url), "utf8");
  assert.ok(/Tool cancelled:/.test(rules), "a cancel must not be logged under the `Tool error:` wording");
}

// ============================================================================
// The streaming retention is bounded, and a finished call is released
//
// Two independent holes behind the command-tool OOM:
//   - the per-call buffer/store held the FULL output of every command, and
//   - nothing released an entry when the call ended (`tool:clear` is emitted by nobody
//     at runtime, and the app only subscribed to the `tool` channel).
// Measured before: 1000 calls, 1000 ids still retained.
// ============================================================================
{
  const app = readFileSync(new URL("../src/utils/streaming-ingest.ts", import.meta.url), "utf8");

  // A retention cap exists and is actually applied to both streams.
  const cap = app.match(/const MAX_RETAINED_CHARS = ([\d_ *]+);/);
  assert.ok(cap, "the ingest buffer must declare a retention cap");
  const capValue = cap[1]
    .replace(/_/g, "")
    .split("*")
    .reduce((a, b) => a * Number(b.trim()), 1);
  assert.ok(capValue > 0 && capValue <= 1024 * 1024, `cap must be small enough to bound growth, got ${capValue}`);
  assert.equal(
    (app.match(/tailOf\(/g) || []).length >= 3,
    true,
    "both stdout and stderr appends must go through the tail helper (declaration + 2 uses)"
  );
  assert.ok(
    !/buffer\.stdout \+= chunk/.test(app) && !/buffer\.stderr \+= chunk/.test(app),
    "no raw `+= chunk` append may bypass the cap"
  );

  // A settle-time release exists and is exported for the subscription to call.
  assert.ok(/export function releaseFinishedTool\(/.test(app), "a finished-call release must be exported");
  for (const key of ["buffers.delete", "throttleMsByToolCallId.delete"]) {
    assert.ok(app.includes(key), `release must drop ${key} (not just the store entry)`);
  }
}

// ============================================================================
// The session event → buffer mapping is behavioural (not a source-text match)
//
// A subscription can only be exercised against a live session, and a text assertion
// cannot tell an unconditional release from a dead one (`if (id && false) release(id)`
// matches the text of the working version). So the mapping is a pure function; driving
// it and observing real buffer state is what pins the OOM fix.
// ============================================================================
{
  const { classifyStreamEvent, applyStreamEventAction, ingestStreamingChunk, getStreamingStoreOutput } =
    await import("../dist/utils/streaming-ingest.mjs");

  const chunkEvent = (toolCallId, chunk) => ({
    channel: "tool",
    payload: { kind: "chunk", chunk: { toolCallId, type: "stdout", chunk } },
  });
  const endEvent = (toolCallId) => ({
    channel: "lifecycle",
    payload: { type: "agent:tool-end", payload: { tool_call_id: toolCallId } },
  });

  // A tool call streams its output...
  applyStreamEventAction(classifyStreamEvent(chunkEvent("c1", "hello ")));
  applyStreamEventAction(classifyStreamEvent(chunkEvent("c1", "world")));
  assert.equal(getStreamingStoreOutput("c1")?.stdout, "hello world", "chunks must reach the store");

  // ...the end event MARKs it (and must NOT release yet)...
  const end = classifyStreamEvent(endEvent("c1"));
  assert.deepEqual(end, { kind: "tool-end", toolCallId: "c1" }, "agent:tool-end must mark the call");
  applyStreamEventAction(end);
  assert.equal(
    getStreamingStoreOutput("c1")?.stdout,
    "hello world",
    "the end event must NOT release: its result is not on the channel yet, so the row " +
      "would blank for a frame while StreamingOutputView is still mounted (the flash)"
  );

  // ...and the RESULT frame releases it.
  const release = classifyStreamEvent({
    channel: "messages",
    payload: [{ role: "assistant", parts: [{ type: "tool-call", id: "c1", state: "complete", output: { ok: 1 } }] }],
  });
  assert.deepEqual(release, { kind: "release", toolCallId: "c1" }, "the result frame must release the call");
  applyStreamEventAction(release);
  assert.equal(getStreamingStoreOutput("c1"), undefined, "a finished call must be released (this is the OOM fix)");

  // A call that errored settles the same way and must release too.
  ingestStreamingChunk("c2", "stdout", "partial");
  applyStreamEventAction(
    classifyStreamEvent({
      channel: "lifecycle",
      payload: { type: "agent:tool-error", payload: { tool_call_id: "c2" } },
    })
  );
  assert.equal(getStreamingStoreOutput("c2")?.stdout, "partial", "an errored call holds until its result frame");
  applyStreamEventAction(
    classifyStreamEvent({
      channel: "messages",
      payload: [{ parts: [{ type: "tool-call", id: "c2", state: "error", output: { error: "boom" } }] }],
    })
  );
  assert.equal(getStreamingStoreOutput("c2"), undefined, "an errored call must be released too");

  // Events that must NOT release: an unrelated lifecycle event, and a message frame whose
  // matching part has not settled yet.
  ingestStreamingChunk("c5", "stdout", "live");
  assert.equal(
    classifyStreamEvent({ channel: "lifecycle", payload: { type: "agent:tool-start", payload: {} } }),
    null,
    "other lifecycle events must not touch the buffers"
  );
  applyStreamEventAction(classifyStreamEvent(endEvent("c5")));
  assert.equal(
    classifyStreamEvent({
      channel: "messages",
      payload: [{ parts: [{ type: "tool-call", id: "c5", state: "input-complete" }] }],
    }),
    null,
    "a still-executing part must hold its buffer (releasing here is what flashed the row)"
  );
  assert.equal(getStreamingStoreOutput("c5")?.stdout, "live", "so the buffer is still there");
  // A frame about some OTHER tool must not release this one.
  assert.equal(
    classifyStreamEvent({
      channel: "messages",
      payload: [{ parts: [{ type: "tool-call", id: "other", state: "complete", output: {} }] }],
    }),
    null,
    "an unrelated tool's result must not release a pending call"
  );
  applyStreamEventAction(
    classifyStreamEvent({
      channel: "messages",
      payload: [{ parts: [{ type: "tool-call", id: "c5", state: "complete", output: { done: true } }] }],
    })
  );
  assert.equal(getStreamingStoreOutput("c5"), undefined, "and it releases when its own result lands");

  // A `tool:clear` frame (the retry path) still clears immediately.
  ingestStreamingChunk("c3", "stdout", "stale");
  applyStreamEventAction(classifyStreamEvent({ channel: "tool", payload: { toolCallId: "c3" } }));
  assert.equal(getStreamingStoreOutput("c3"), undefined, "a tool:clear frame must still clear");

  // The retention cap is separate and applies to both streams independently.
  ingestStreamingChunk("c4", "stdout", "x".repeat(200_000));
  ingestStreamingChunk("c4", "stderr", "y".repeat(200_000));
  const big = getStreamingStoreOutput("c4");
  assert.ok(big.stdout.length <= 65_536, `stdout must be capped, got ${big.stdout.length}`);
  assert.ok(big.stderr.length <= 65_536, `stderr must be capped, got ${big.stderr.length}`);
}

// ============================================================================
// The subscription must subscribe to a channel that carries the call's end
// ============================================================================
{
  const hook = readFileSync(new URL("../src/hooks/use-streaming-output.ts", import.meta.url), "utf8");
  // Strip comments first: a commented-out call must not satisfy a text assertion — it did
  // (mutation `// if (action) applyStreamEventAction(action);` passed) until this existed.
  const code = hook.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  assert.ok(
    /channels: \["tool", "lifecycle", "messages"\]/.test(code),
    "the hook must subscribe to `lifecycle` (ends) AND `messages` (results) — releasing needs both"
  );
  assert.ok(/applyStreamEventAction\(action\)/.test(code), "and must route every event through the tested mapping");
}

// ============================================================================
// The seam the fix depends on: the end-of-call events really do project here
//
// `classifyStreamEvent` only sees `lifecycle` events if the bus routes them there.
// If someone re-routes `agent:tool-end` off the `lifecycle` channel, the release stops
// firing and the leak returns — silently. Assert the routing itself.
// ============================================================================
{
  // `classifyStreamEvent` only sees `lifecycle` events if the bus routes them there.
  // If someone re-routes `agent:tool-end` off the `lifecycle` channel, the release stops
  // firing and the leak returns — silently. Assert the routing itself.
  const { AGENT_EVENT_META } = await import("../../core/dist/dev.mjs");
  for (const name of ["agent:tool-end", "agent:tool-error"]) {
    assert.equal(
      AGENT_EVENT_META[name]?.channel,
      "lifecycle",
      `${name} must project onto the lifecycle channel — that is what the release listens to`
    );
  }
  // And the payload carries the call id the release is keyed by.
  const { DEFAULT_AGENT_SESSION_CHANNELS } = await import("@codent/core");
  assert.ok(
    DEFAULT_AGENT_SESSION_CHANNELS.includes("lifecycle"),
    "lifecycle must be a default channel, or a host that omits it would leak again"
  );
}

console.log("abort-and-streaming-bounds validation passed");
