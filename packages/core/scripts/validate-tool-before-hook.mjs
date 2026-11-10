/**
 * The `tool:before:*` hook runs once per tool call across both seams.
 *
 * The authorization pipeline runs before an approval prompt, the extensions middleware runs before
 * execution. They share a `ToolBeforeHookLedger`: the second seam must read the first verdict, not
 * emit the interceptable event again (double side effects) and not decide without it.
 *
 * Run: pnpm --filter @codent/core run validate:tool-before-hook
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { emitToolBeforeHook, TOOL_GATE_FAILED_REASON, ToolBeforeHookLedger } from "../dist/dev.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const srcRoot = resolve(here, "../src");

// --- once-only, concurrent join, cached read, clear -------------------------
{
  const ledger = new ToolBeforeHookLedger();
  let produced = 0;
  const producer = async () => {
    produced += 1;
    return { skip: true, reason: "blocked", modifiedArgs: { n: 1 } };
  };

  const [a, b] = await Promise.all([ledger.runOnce("call-1", producer), ledger.runOnce("call-1", producer)]);
  assert.equal(produced, 1, "concurrent runs join one interception");
  assert.deepEqual(a, b, "both seams observe the same outcome");
  assert.deepEqual(ledger.get("call-1"), a, "the outcome stays readable without re-emitting");

  const third = await ledger.runOnce("call-1", producer);
  assert.equal(produced, 1, "a later call reuses the cached outcome");
  assert.deepEqual(third, a);

  ledger.clear();
  await ledger.runOnce("call-1", producer);
  assert.equal(produced, 2, "clear() starts a new conversation's ledger");
}

// --- the emitter maps the event fields onto the outcome ---------------------
{
  let emitted = 0;
  const runner = {
    getEventBus: () => ({
      intercept: async (event) => {
        emitted += 1;
        event.skip = true;
        event.reason = "no writes";
        event.modifiedArgs = { path: "/tmp/x" };
      },
    }),
  };
  const outcome = await emitToolBeforeHook(runner, {
    toolCallId: "call-2",
    toolName: "write_file",
    args: { path: "/tmp/x" },
    sessionId: "ses",
  });
  assert.equal(emitted, 1);
  assert.deepEqual(outcome, { skip: true, reason: "no writes", modifiedArgs: { path: "/tmp/x" } });
}

// --- a gate that FAILED is a refusal, not an approval -----------------------
{
  // `handlerError` is what the bus (and the runner's wrapper) sets when an interceptor threw: the
  // verdict is unknown. Reading only `skip` approved every call a broken gate matched.
  const runner = {
    getEventBus: () => ({
      intercept: async (event) => {
        event.handlerError = true;
      },
    }),
  };
  const outcome = await emitToolBeforeHook(runner, { toolCallId: "call-3", toolName: "write_file", args: {} });
  assert.equal(outcome.skip, true, "a failed gate denies");
  assert.equal(outcome.reason, TOOL_GATE_FAILED_REASON, "and says why, so the denial row is not empty");
}

// --- an explicit skip keeps the handler's own reason ------------------------
{
  const runner = {
    getEventBus: () => ({
      intercept: async (event) => {
        event.skip = true;
        event.handlerError = true;
        event.reason = "handler verdict wins";
      },
    }),
  };
  const outcome = await emitToolBeforeHook(runner, { toolCallId: "call-4", toolName: "write_file", args: {} });
  assert.equal(outcome.skip, true);
  assert.equal(outcome.reason, "handler verdict wins", "an explicit reason is not replaced by the failure text");
}

// --- a TIMEOUT (skip + handlerError, no reason) still names the failure ------
{
  // The bus sets both flags on a chain timeout and clears the rewrites. Reading only `skip` made
  // this look like a deliberate extension veto, so the denial row never said the gate failed.
  const runner = {
    getEventBus: () => ({
      intercept: async (event) => {
        event.skip = true;
        event.handlerError = true;
      },
    }),
  };
  const outcome = await emitToolBeforeHook(runner, { toolCallId: "call-5", toolName: "write_file", args: {} });
  assert.equal(outcome.skip, true, "a timed-out gate denies");
  assert.equal(outcome.reason, TOOL_GATE_FAILED_REASON, "the timeout is reported as a gate failure, not a veto");
}

// --- production wiring: one ledger, both seams use it -----------------------
{
  const managed = readFileSync(resolve(srcRoot, "managers/managed-agent.ts"), "utf8");
  assert.match(managed, /new ToolBeforeHookLedger\(\)/, "the agent owns one ledger");
  assert.match(managed, /runToolBeforeHook\(/, "the pipeline entry point exists");
  assert.match(managed, /toolBeforeHooks\.runOnce\(/, "the entry point joins the ledger");
  assert.match(managed, /emitToolBeforeHook\(/, "it emits through the shared helper");

  const runAgent = readFileSync(resolve(srcRoot, "managers/run-agent.ts"), "utf8");
  assert.match(runAgent, /getToolBeforeHooks: deps\.getToolBeforeHooks/, "the middleware receives the ledger");

  const controller = readFileSync(resolve(srcRoot, "agent/run/chat-controller.ts"), "utf8");
  assert.match(
    controller,
    /runToolBeforeHook: \(toolCallId, toolName, args\)/,
    "the coordinator receives the pipeline entry point"
  );

  const service = readFileSync(resolve(srcRoot, "agent/approval/tool-authorization.ts"), "utf8");
  assert.match(service, /extensionHooks: async/, "the pipeline has an extension stage");
  assert.match(service, /source: "extension"/, "a skip is recorded as an extension denial");
  // The hook sees the WHOLE call. It used to receive `parseRunCommandApprovalInput`, the
  // command-analysis projection `{command,cwd,env}`, so every non-command gated tool (write_file,
  // edit_file, MCP) reached extensions as `{}` — and the ledger caches that outcome, so the
  // execution seam never re-emitted with the real arguments.
  assert.match(
    service,
    /import \{ parseToolInput \} from "\.\.\/\.\.\/utils\/parse-tool-arguments\.js"/,
    "the hook's input comes from the one shared parser"
  );
  assert.match(service, /parseToolInput\(toolCall\)/, "the full call input is parsed for the hook");
  assert.match(
    service,
    /runToolBeforeHook!\(toolCall\.id, toolCall\.name, hookArgs/,
    "the hook receives the full input, not the command projection"
  );
}

console.log("tool:before hook ledger validation passed");
