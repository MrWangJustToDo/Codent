/**
 * Validates that run_command output is projected onto the owning agent's stream hub only.
 *
 * Run: pnpm --filter @codent/core run validate:command-stream-scope
 */

import assert from "node:assert/strict";

import { AgentStreamHub, agentStreamKey, createAgentEventBus, createRunCommandTool } from "../dist/dev.mjs";

/** A minimal foreground CoreEnv; the tool only needs runCommand + getEnv for this path. */
const coreEnv = {
  rootPath: "/workspace",
  getEnv: async () => ({}),
  runCommand: async (command, options) => {
    const stdout = command === "alpha" ? "alpha\n" : "beta\n";
    options.onStdout?.(stdout);
    return { stdout, stderr: "", exitCode: 0, durationMs: 1 };
  },
};

function makeTool() {
  const hub = new AgentStreamHub();
  const bus = createAgentEventBus();
  hub.setEventBus(bus);
  const chunks = [];
  bus.on("tool:chunk", (event) => chunks.push(event.payload.chunk));
  const tool = createRunCommandTool({
    context: {
      getCommandService: () => ({}),
      getStreamSink: () => ({
        commandStdout: (toolCallId, chunk) => hub.appendCommand(toolCallId, "stdout", chunk),
        commandStderr: (toolCallId, chunk) => hub.appendCommand(toolCallId, "stderr", chunk),
        clearCommand: (toolCallId) => hub.clearCommand(toolCallId),
        endCommand: (toolCallId) => hub.endCommand(toolCallId),
      }),
    },
  });
  return { hub, chunks, tool };
}

const alpha = makeTool();
const beta = makeTool();

await alpha.tool.execute(
  { command: "alpha" },
  { toolCallId: "call-alpha", abortSignal: new AbortController().signal, context: { coreEnv } }
);
await beta.tool.execute(
  { command: "beta" },
  { toolCallId: "call-beta", abortSignal: new AbortController().signal, context: { coreEnv } }
);

assert.deepEqual(
  alpha.chunks.map((chunk) => chunk.chunk),
  ["alpha\n"],
  "the alpha agent receives only its own stdout"
);
assert.deepEqual(
  beta.chunks.map((chunk) => chunk.chunk),
  ["beta\n"],
  "the beta agent receives only its own stdout"
);

const alphaKey = agentStreamKey("command", "call-alpha", "stdout");
const betaKey = agentStreamKey("command", "call-beta", "stdout");
assert.deepEqual(alpha.hub.getSnapshot(alphaKey)?.lines, ["alpha"]);
assert.deepEqual(beta.hub.getSnapshot(betaKey)?.lines, ["beta"]);
assert.equal(alpha.hub.getSnapshot(betaKey), null, "the alpha hub has no beta command stream");
assert.equal(beta.hub.getSnapshot(alphaKey), null, "the beta hub has no alpha command stream");

alpha.hub.endCommand("call-alpha");
beta.hub.endCommand("call-beta");
assert.equal(alpha.hub.getSnapshot(alphaKey)?.status, "ended");
assert.equal(beta.hub.getSnapshot(betaKey)?.status, "ended");

console.log("command-stream-scope validation passed");
