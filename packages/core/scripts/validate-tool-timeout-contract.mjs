/**
 * Validation: the tool timeout contract.
 *
 * A tool may declare an execution deadline (`timeoutMs`). When it does, one shared wrapper
 * (`withTimeoutAbort`) enforces it for BOTH registration paths — `defineServerTool` and
 * extension tools. The contract has three load-bearing properties:
 *
 *   1. A timeout is a typed failure (`ExecutionError("timeout")`), never a cancel. The model must
 *      not be told the user stopped work the user never stopped (`run-abort-ownership`).
 *   2. The run signal outranks the deadline. A user stop while a declared-deadline tool is in
 *      flight settles as cancelled even if the deadline also fired.
 *   3. No declaration means no deadline — a tool without `timeoutMs` is byte-identical to before.
 *
 * This is the same predicate the render layer uses (`isAbortError`, signal-first), so asserting
 * it here pins the verdict the way the user and the model will read it.
 *
 * Run: pnpm --filter @codent/core run validate:tool-timeout-contract
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { ExtensionRegistryService, createTimeoutAbort, defineServerTool, withTimeoutAbort } from "../dist/dev.mjs";
// The cancel verdict is a render-layer reader and lives on the public entry, not the internal
// one — same split as validate-websearch-providers.mjs / validate-cancel-semantics.mjs.
import { isAbortError } from "../dist/index.mjs";

const SRC = fileURLToPath(new URL("../src/", import.meta.url));

/** A body that never settles — the hang a deadline exists for. */
const never = () => new Promise(() => {});

/** The registered tool is invoked with a minimal execution context, like a caller would. */
function extContext() {
  const tools = {};
  return { tools, ownerId: "ext_timeout", agentId: "agent_timeout", warn: () => {}, onToolsChanged: () => {} };
}

// ============================================================================
// 1. `defineServerTool`: a declared deadline is a failure, not a cancel
// ============================================================================
{
  // The body ignores its signal on purpose: the wrapper must enforce the deadline around it, not
  // merely hand it a signal it can choose to ignore.
  const tool = defineServerTool({
    name: "ignores_signal",
    description: "never settles",
    inputSchema: { type: "object" },
    timeoutMs: 30,
    execute: never,
  });

  const run = new AbortController();
  let error;
  try {
    await tool.execute({}, { toolCallId: "b1", abortSignal: run.signal, context: { agentId: "a" } });
    assert.fail("a declared-deadline tool must not resolve past its deadline");
  } catch (e) {
    error = e;
  }
  assert.equal(error.name, "ExecutionError", "a timeout is the typed execution error");
  assert.equal(error.code, "timeout", "…carried as the `timeout` code");
  assert.match(error.message, /ignores_signal/, "the failure names the tool");
  assert.match(error.message, /timed out after 30ms/, "…and the budget");
  assert.equal(isAbortError(error, run.signal), false, "the run signal is live: a timeout is NOT a cancel");
  assert.equal(isAbortError(error, undefined), false, "…and no signal is no cancel either");
}

// A body that observes its deadline signal (the shape a fetch-cancelling tool uses) must also
// settle as a failure — and the signal SEPARATION must hold: `abortSignal` stays the live run
// signal across a deadline, while `deadlineSignal` carries the deadline. That separation is what
// keeps the standard classification `isAbortError(err, ctx.abortSignal)` from reading a timeout
// as a user cancel.
{
  let runAbortedAtDeadline = null;
  const tool = defineServerTool({
    name: "observes_signal",
    description: "rejects with its own deadline reason",
    inputSchema: { type: "object" },
    timeoutMs: 30,
    execute: (_args, ctx) =>
      new Promise((_resolve, reject) => {
        ctx.deadlineSignal.addEventListener(
          "abort",
          () => {
            runAbortedAtDeadline = ctx.abortSignal.aborted;
            reject(ctx.deadlineSignal.reason);
          },
          { once: true }
        );
      }),
  });

  const run = new AbortController();
  let error;
  try {
    await tool.execute({}, { toolCallId: "b2", abortSignal: run.signal, context: {} });
    assert.fail("the tool must abort at its deadline");
  } catch (e) {
    error = e;
  }
  assert.equal(error.code, "timeout");
  assert.equal(runAbortedAtDeadline, false, "`abortSignal` must stay live across a deadline expiry");
  assert.equal(isAbortError(error, run.signal), false, "a self-caught timeout is still not a cancel");
}

// ============================================================================
// 2. No declaration, no deadline
// ============================================================================
{
  const tool = defineServerTool({
    name: "no_deadline",
    description: "returns immediately",
    inputSchema: { type: "object" },
    execute: async () => ({ ok: true }),
  });
  const result = await tool.execute({}, { toolCallId: "n1" });
  assert.deepEqual(result, { ok: true }, "a tool without timeoutMs is untouched");
}

// ============================================================================
// 3. A run abort outranks the deadline
// ============================================================================
{
  // The run signal is aborted in the same tick the deadline is armed (timeoutMs 1). The signal is
  // consulted before the deadline verdict, so the call must read as cancelled.
  const tool = defineServerTool({
    name: "cancelled_builtin",
    description: "aborted by the run",
    inputSchema: { type: "object" },
    timeoutMs: 1,
    execute: (_args, ctx) =>
      new Promise((_resolve, reject) => {
        ctx.abortSignal.addEventListener("abort", () => reject(ctx.abortSignal.reason ?? new Error("aborted")), {
          once: true,
        });
      }),
  });

  const run = new AbortController();
  const pending = tool.execute({}, { toolCallId: "c1", abortSignal: run.signal, context: {} });
  run.abort();

  let error;
  try {
    await pending;
    assert.fail("an aborted run must not resolve");
  } catch (e) {
    error = e;
  }
  assert.equal(isAbortError(error, run.signal), true, "a run abort wins: the call settles as cancelled");
}

// ============================================================================
// 3b. A body that catches the abort and resolves partial output keeps it
// ============================================================================
{
  // The body observes its deadline signal and RESOLVES a partial output (the "full output
  // with cancelled:true" shape). The wrapper must not preempt that graceful-cancel result
  // with a synchronous rejection — a tool-caught cancel stays a result, not a throw.
  const tool = defineServerTool({
    name: "graceful_cancel",
    description: "resolves partial output on abort",
    inputSchema: { type: "object" },
    timeoutMs: 5,
    execute: (_args, ctx) =>
      new Promise((resolve) => {
        ctx.deadlineSignal.addEventListener("abort", () => resolve({ cancelled: true, partial: "kept" }), {
          once: true,
        });
      }),
  });

  const result = await tool.execute({}, { toolCallId: "g1", abortSignal: new AbortController().signal, context: {} });
  assert.deepEqual(result, { cancelled: true, partial: "kept" }, "a body that resolves on abort keeps its output");
}

// ============================================================================
// 4. Extension tools share the same implementation and error shape
// ============================================================================
{
  const service = new ExtensionRegistryService();
  const ctx = extContext();

  service.registerTool(
    { name: "hangs_ext", description: "never settles", inputSchema: { type: "object" }, timeoutMs: 30, execute: never },
    ctx
  );

  let error;
  try {
    await ctx.tools.hangs_ext.execute({}, { toolCallId: "e1" });
    assert.fail("the extension tool must not resolve past its deadline");
  } catch (e) {
    error = e;
  }
  assert.equal(error.name, "ExecutionError", "an extension timeout is the same typed error, not a plain Error");
  assert.equal(error.code, "timeout");
  assert.match(error.message, /hangs_ext/, "the failure names the tool");
  assert.match(error.message, /timed out after 30ms/, "…and the budget (previous wording preserved)");
  assert.equal(isAbortError(error, undefined), false, "…and is not a cancel");
}

// The extension path separates the signals too: the body's `abortSignal` stays live at the
// deadline while `deadlineSignal` carries it, so an extension classifying with `abortSignal`
// cannot read a timeout as a cancel.
{
  const service = new ExtensionRegistryService();
  const ctx = extContext();
  let sawDeadlineSignal = false;
  let runAbortedAtDeadline = null;
  service.registerTool(
    {
      name: "ext_split",
      description: "observes both signals",
      inputSchema: { type: "object" },
      timeoutMs: 30,
      execute: (_input, options) =>
        new Promise((_resolve, reject) => {
          sawDeadlineSignal = options.deadlineSignal instanceof AbortSignal;
          options.deadlineSignal.addEventListener(
            "abort",
            () => {
              runAbortedAtDeadline = options.abortSignal.aborted;
              reject(options.deadlineSignal.reason);
            },
            { once: true }
          );
        }),
    },
    ctx
  );

  const run = new AbortController();
  let error;
  try {
    await ctx.tools.ext_split.execute({}, { toolCallId: "e3", abortSignal: run.signal });
    assert.fail("the extension tool must abort at its deadline");
  } catch (e) {
    error = e;
  }
  assert.equal(sawDeadlineSignal, true, "an extension tool with timeoutMs receives a deadlineSignal");
  assert.equal(runAbortedAtDeadline, false, "its `abortSignal` stays live across the deadline");
  assert.equal(error.code, "timeout");
  assert.equal(isAbortError(error, run.signal), false, "…and the timeout is still not a cancel");
}

// An extension deadline does not swallow a user stop either.
{
  const service = new ExtensionRegistryService();
  const ctx = extContext();
  service.registerTool(
    {
      name: "ext_cancel",
      description: "never settles",
      inputSchema: { type: "object" },
      timeoutMs: 100_000,
      execute: never,
    },
    ctx
  );

  const run = new AbortController();
  const pending = ctx.tools.ext_cancel.execute({}, { toolCallId: "e2", abortSignal: run.signal });
  run.abort();

  let error;
  try {
    await pending;
    assert.fail("an aborted extension tool must not resolve");
  } catch (e) {
    error = e;
  }
  assert.equal(isAbortError(error, run.signal), true, "a run abort outranks the extension deadline");
}

// ============================================================================
// 5. One implementation, one declaration surface (structural)
// ============================================================================
{
  // The helper moved out of the websearch provider folder — websearch is a consumer, not the owner.
  assert.throws(
    () => readFileSync(`${SRC}/agent/tools/websearch/abort-timeout.ts`, "utf8"),
    "the websearch-local abort-timeout module is gone"
  );

  const defineSrc = readFileSync(`${SRC}/agent/tools/runtime/define-tool.ts`, "utf8");
  assert.ok(
    /withTimeoutAbort/.test(defineSrc),
    "defineServerTool enforces its declared deadline through the shared wrapper"
  );
  assert.ok(/timeoutMs\?: number/.test(readFileSync(`${SRC}/agent/tools/runtime/define-tool.ts`, "utf8")));

  // The deadline signal is exposed separately from the run signal, so classification stays correct.
  assert.ok(/deadlineSignal\?: AbortSignal/.test(defineSrc), "ToolExecuteCtx exposes a separate deadlineSignal");
  assert.ok(
    /deadlineSignal\?: AbortSignal/.test(readFileSync(`${SRC}/agent/extension/types.ts`, "utf8")),
    "ToolExecutionOptions exposes a separate deadlineSignal"
  );

  const extSrc = readFileSync(`${SRC}/managers/services/agent-tool-service.ts`, "utf8");
  assert.ok(/withTimeoutAbort/.test(extSrc), "the extension path uses the same shared wrapper");
  assert.ok(
    !/function withTimeout\b/.test(extSrc),
    "the local plain-Error `withTimeout` is gone — both paths share one implementation"
  );

  // The shared helper still produces the typed reason the contract depends on.
  const { controller, cleanup } = createTimeoutAbort({ timeoutMs: 1 });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(controller.signal.aborted, true);
  assert.equal(
    isAbortError(controller.signal.reason, undefined),
    false,
    "the helper's reason is a timeout, not a cancel"
  );
  cleanup();

  // …and the composition is the exported one, not a replica.
  assert.equal(typeof withTimeoutAbort, "function", "withTimeoutAbort is reachable for both registration paths");
}

console.log("tool-timeout-contract validation passed");
