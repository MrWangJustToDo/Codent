/**
 * Validates the agent id an extension tool sees on `ToolExecutionOptions`.
 *
 * Two sources exist and the precedence matters. `ToolRunContext.agentId` is set per run by
 * the runner and reaches the tool through TanStack's execution context; the registration-time
 * id only records which ManagedAgent the tool was registered on. One registered tool set also
 * serves that agent's subagent runs, so only the run-context value identifies the run that is
 * actually executing — a tool keying per-agent resources (caches, sandboxes) would otherwise
 * attribute every subagent run to the parent.
 *
 * Run: pnpm --filter @codent/core run validate:tool-run-agentid
 */

import assert from "node:assert/strict";

import { ManagedAgent } from "../dist/dev.mjs";

// Same shape the runner builds and forwards via `chat({ context })`.
const createToolRunContext = (agentId) => ({ agentId, coreEnv: {} });

const seen = [];
// The id is core-assigned provenance: it goes in through the creation seam (`init.id`), not through the
// host-facing config — `ManagedAgentConfig` has no `id` (see `core-minted agent ids`).
const managed = new ManagedAgent(
  { name: "probe-agent", model: "gpt-4" },
  {
    id: "agent_registered",
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
managed.registerTool({
  name: "probe_tool",
  description: "probe",
  execute: async (_args, opts) => {
    seen.push(opts.agentId);
    return { agentId: opts.agentId };
  },
});

const tool = managed.tools.probe_tool;
assert.ok(tool, "tool registered");

// 1. Without a run context: falls back to the registering agent's id.
const bare = await tool.execute({}, { toolCallId: "c1" });
assert.equal(bare.agentId, "agent_registered", "registration fallback must use the ManagedAgent id");

// 2. With a run context: the RUN's agent id wins. Otherwise the fallback would silently
//    mislabel every run of a tool that was registered on a different agent.
const withCtx = await tool.execute({}, { toolCallId: "c2", context: createToolRunContext("agent_running") });
assert.equal(withCtx.agentId, "agent_running", "run-context agentId must win over the registration fallback");

// 3. A subagent run over the SAME registered tool set reports its own id, not the parent's.
const child = await tool.execute({}, { toolCallId: "c3", context: createToolRunContext("agent_child") });
assert.equal(child.agentId, "agent_child", "a subagent run must report its own agent id");

assert.deepEqual(seen, ["agent_registered", "agent_running", "agent_child"]);
console.log("tool run agentId validation passed", JSON.stringify(seen));
