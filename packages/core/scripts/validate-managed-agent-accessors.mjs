/**
 * Validates ManagedAgent host-facing status/context/ui accessors and internal wiring.
 *
 * Run: pnpm --filter @codent/core run validate:managed-agent-accessors
 */

import assert from "node:assert/strict";

import { AgentUIChannel, ManagedAgent } from "../dist/dev.mjs";

const managed = new ManagedAgent(
  { name: "accessor-test", model: "gpt-4" },
  {
    context: {
      getMessages: () => [],
      getUIMessages: () => [],
      reset: () => {},
      setMessages: () => {},
      setUIMessages: () => {},
      getMessagesForLLM: () => [],
    },
    log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, agent: () => {}, clear: () => {} },
    tools: {},
    todoManager: null,
  }
);

assert.equal(managed.getStatus(), "idle");
managed.setStatus("running");
assert.equal(managed.getStatus(), "running");

assert.equal(managed.getRunner(), undefined);
assert.equal(managed.getUI(), undefined);

const channel = new AgentUIChannel();
managed.setUIChannel(channel);
assert.equal(managed.getUI(), channel);

managed.setUIChannel(undefined);
assert.equal(managed.getUI(), undefined);

managed.runFinalizer.finalizeSnapshot([
  { id: "u1", role: "user", parts: [{ type: "text", content: "hi" }] },
  { id: "a1", role: "assistant", parts: [{ type: "text", content: "hello" }] },
]);
assert.equal(managed.getStatus(), "completed");

managed.setStatus("running");
managed.syncInteractionStateFromUIMessages(
  [
    {
      id: "u1",
      role: "user",
      parts: [{ type: "text", content: "run" }],
    },
    {
      id: "a1",
      role: "assistant",
      parts: [
        {
          type: "tool-call",
          id: "call_cmd",
          name: "run_command",
          arguments: '{"command":"echo hi"}',
          state: "input-complete",
          approval: { needsApproval: true, approved: undefined },
        },
      ],
    },
  ],
  { whenClear: "running" }
);
assert.equal(managed.getStatus(), "waiting");

console.log("managed-agent-accessors validation passed");
