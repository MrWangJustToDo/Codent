import assert from "node:assert/strict";

import { AgentLog, ManagedAgent, createReadFileTool, defineServerTool } from "../dist/dev.mjs";

function makeAgent(name, tool) {
  const managed = new ManagedAgent(
    { name, model: "test-model" },
    { log: new AgentLog(), tools: { probe: tool }, todoManager: null }
  );
  return managed;
}

const toolA = defineServerTool({
  name: "probe",
  description: "A",
  present: { category: "edits" },
  execute: async () => ({ value: "a" }),
  toModelOutput: () => "A",
});
const toolB = defineServerTool({
  name: "probe",
  description: "B",
  present: { category: "searches" },
  execute: async () => ({ value: "b" }),
  toModelOutput: () => "B",
});

const a = makeAgent("agent-a", toolA);
const b = makeAgent("agent-b", toolB);

assert.equal(await a.getToolModelOutput("probe")?.({ toolCallId: "a", input: {}, output: {} }), "A");
assert.equal(await b.getToolModelOutput("probe")?.({ toolCallId: "b", input: {}, output: {} }), "B");
assert.equal(a.getToolPresentation("probe")?.category, "edits");
assert.equal(b.getToolPresentation("probe")?.category, "searches");
assert.equal(
  a.getToolPresentationCatalog().find((entry) => entry.name === "probe")?.category,
  "edits",
  "the catalog is built from the agent's live tool, not the process-wide top"
);
assert.equal(b.getToolPresentationCatalog().find((entry) => entry.name === "probe")?.category, "searches");

// Decorators are agent-scoped, and each returned disposer removes only its own registration.
const decoratorOwner = `${a.id}:codent-lsp`;
const disposeLsp = a.registerToolOutputDecorator(
  "probe",
  async (_ctx, next) => `${await next(_ctx)}:lsp`,
  decoratorOwner
);
const disposeSecond = a.registerToolOutputDecorator(
  "probe",
  async (_ctx, next) => `${await next(_ctx)}:second`,
  decoratorOwner
);
assert.equal(await a.getToolModelOutput("probe")?.({ toolCallId: "a", input: {}, output: {} }), "A:lsp:second");
assert.equal(await b.getToolModelOutput("probe")?.({ toolCallId: "b", input: {}, output: {} }), "B");
disposeLsp();
assert.equal(
  await a.getToolModelOutput("probe")?.({ toolCallId: "a", input: {}, output: {} }),
  "A:second",
  "disposing one decorator leaves the other registered"
);
disposeSecond();
assert.equal(await a.getToolModelOutput("probe")?.({ toolCallId: "a", input: {}, output: {} }), "A");

// Owner cleanup remains available for extension teardown.
a.registerToolOutputDecorator("probe", async (_ctx, next) => `${await next(_ctx)}:owner`, decoratorOwner);
a.removeToolOutputDecoratorOwner(decoratorOwner);
assert.equal(await a.getToolModelOutput("probe")?.({ toolCallId: "a", input: {}, output: {} }), "A");

// A shadowing tool owns its metadata, and it does NOT inherit the shadowed built-in's presentation:
// the descriptor describes an output shape, and dispatch is by name, so handing the built-in's
// category to a foreign implementation both mislabels the row and (plan mode) classifies a write
// tool as read-only. `toModelOutput` is deliberately not inherited for the same reason.
{
  const shadow = makeAgent("agent-shadow", createReadFileTool());
  shadow.registerTool(
    {
      name: "read_file",
      description: "shadow read_file",
      inputSchema: { type: "object", properties: {} },
      execute: async () => ({}),
    },
    "shadow-extension"
  );
  assert.equal(
    shadow.getToolPresentation("read_file"),
    undefined,
    "an undeclared shadow is undeclared — it must not borrow the built-in descriptor"
  );
  const entry = shadow.getToolPresentationCatalog().find((item) => item.name === "read_file");
  assert.equal(entry?.category, undefined, "…and the catalog agrees");
  assert.equal(entry?.origin, "extension", "the catalog says which implementation is live");
  assert.equal(
    shadow.getToolModelOutput("read_file"),
    undefined,
    "a shadow does not inherit the shadowed tool's model-output handler"
  );
}

console.log("agent-tool-isolation validation passed");
