/**
 * Validates the live per-handler extension context.
 *
 * The context is the one thing every new capability hangs off, and its whole point is that it is
 * **live**: a handler that runs after a session switch must not read the previous session's facts. A
 * snapshot implementation would pass every "does it have the fields" test and still be wrong, so this
 * drives the real runner and mutates the runtime between reads.
 *
 * Run: pnpm --filter @codent/core run validate:extension-handler-context
 */
import assert from "node:assert/strict";

import { ExtensionRunner, copyModelMessages, createAgentEventBus } from "../dist/dev.mjs";

// ── a runtime whose facts we can change under the extension ─────────────────
const facts = {
  sessionId: "ses_one",
  idle: true,
  mode: "normal",
  model: "model-a",
  signal: undefined,
  messages: [{ role: "user", content: [{ type: "text", content: "hello" }] }],
};

const runtime = {
  sessionId: () => facts.sessionId,
  isIdle: () => facts.idle,
  mode: () => facts.mode,
  model: () => facts.model,
  signal: () => facts.signal,
  messages: () => facts.messages,
  contextUsage: () => ({ fillTokens: 12, limitTokens: 100 }),
  systemPrompt: () => "system",
  complete: async () => ({ text: "ok" }),
};

const bus = createAgentEventBus();
const runner = new ExtensionRunner({ getEnvVar: () => undefined, eventBus: bus, getRuntime: () => runtime });

let captured;
let handlerCtx;
await runner.loadExtension({
  id: "probe",
  name: "Probe",
  version: "1.0.0",
  description: "context probe",
  async activate(ctx) {
    captured = ctx;
    ctx.registerInterceptor("probe:ping", async (_event, ctxFromDispatch) => {
      handlerCtx = ctxFromDispatch;
    });
    ctx.registerCommand({ name: "probe-cmd", description: "probe", execute: async () => "ok" });
  },
});

assert.ok(captured, "activation receives a context");
assert.equal(captured.sessionId, "ses_one");
assert.equal(captured.isIdle(), true);
assert.equal(captured.mode, "normal");
assert.equal(captured.model, "model-a");
assert.equal(captured.signal, undefined, "idle means no run signal");
assert.equal(captured.getSystemPrompt(), "system");
assert.deepEqual(captured.getContextUsage(), { fillTokens: 12, limitTokens: 100 });
assert.equal(captured.getMessages()[0].role, "user");

// Facts move under the extension — the context must follow, not replay activation-time values.
facts.sessionId = "ses_two";
facts.idle = false;
facts.mode = "planning";
facts.model = "model-b";
const controller = new AbortController();
facts.signal = controller.signal;

assert.equal(captured.sessionId, "ses_two", "session id must be read live (session switch)");
assert.equal(captured.isIdle(), false);
assert.equal(captured.mode, "planning");
assert.equal(captured.model, "model-b");
assert.equal(captured.signal, controller.signal, "the run's own signal, not a copy");

// A handler receives the same live context as its second argument.
// The raw bus dispatches interceptors through `intercept` (observers use `emit`).
await bus.intercept({ type: "probe:ping", payload: {} });
assert.equal(handlerCtx, captured, "interceptors receive the extension's live context");

// Commands are dispatched outside the runner but resolve the same context.
assert.equal(runner.contextForCommand("probe-cmd"), captured);
assert.equal(runner.contextFor("probe"), captured);

// ── the conversation copy is isolated ───────────────────────────────────────
const source = [{ role: "user", content: [{ type: "text", content: "original" }] }];
const copy = copyModelMessages(source);
assert.notEqual(copy, source, "a new outer array");
assert.notEqual(copy[0], source[0], "and new message objects");
copy[0].content[0].content = "mutated";
assert.equal(source[0].content[0].content, "original", "a part mutation must not reach the run's wire");

console.log("extension handler context validation passed");
