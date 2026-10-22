/**
 * Validates the extension-tool safety knobs added for the core review.
 *
 * Two properties that were impossible before:
 *
 * 1. **`needsApproval` reaches the tool.** The approval system asked
 *    `isToolNeedsApproval` about every tool, but extension registration never
 *    carried the flag, so a third-party tool could not require the user's consent
 *    (the gate was effectively closed to extensions).
 * 2. **`timeoutMs` bounds `execute`.** Nothing upstream bounds an extension tool, so
 *    a handler awaiting a request that never settles hung the turn forever with no
 *    recovery. The failure now names the budget so the model and the user can see
 *    why, instead of waiting on a spinner.
 *
 * Run: pnpm --filter @codent/core run validate-extension-tool-safety
 */

import assert from "node:assert/strict";

import { ExtensionRegistryService } from "../dist/dev.mjs";

/** Minimal registration context — mutates the tools record like ManagedAgent does. */
function context(tools = {}) {
  return {
    tools,
    ownerId: "ext_test",
    agentId: "agent_test",
    warn: () => {},
    onToolsChanged: () => {},
  };
}

// ---------------------------------------------------------------------------
// 1. needsApproval is carried onto the registered tool
// ---------------------------------------------------------------------------
{
  const service = new ExtensionRegistryService();
  const ctx = context();

  service.registerTool(
    {
      name: "dangerous_write",
      description: "writes something",
      inputSchema: { type: "object" },
      needsApproval: true,
      execute: async () => ({ ok: true }),
    },
    ctx
  );

  const registered = ctx.tools.dangerous_write;
  assert.ok(registered, "the tool was registered");
  assert.equal(
    registered.needsApproval,
    true,
    "needsApproval must reach the registered tool — otherwise the approval gate is closed to extensions"
  );

  // And an extension that does not ask stays ungated.
  const ctx2 = context(ctx.tools);
  service.registerTool(
    { name: "safe_read", description: "reads", inputSchema: { type: "object" }, execute: async () => ({ ok: true }) },
    ctx2
  );
  assert.notEqual(ctx2.tools.safe_read.needsApproval, true, "an extension that does not ask is not gated");
}

// ---------------------------------------------------------------------------
// 2. A tool that outlives timeoutMs fails instead of hanging
// ---------------------------------------------------------------------------
{
  const service = new ExtensionRegistryService();
  const ctx = context();

  service.registerTool(
    {
      name: "hangs",
      description: "never settles",
      inputSchema: { type: "object" },
      timeoutMs: 40,
      // Deliberately never resolves: this is the hang the budget exists for.
      execute: () => new Promise(() => {}),
    },
    ctx
  );

  const started = Date.now();
  let message = "";
  try {
    await ctx.tools.hangs.execute({}, { toolCallId: "tc1" });
    assert.fail("the hanging tool must not resolve");
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  const elapsed = Date.now() - started;

  assert.match(message, /timed out after 40ms/, "the failure names the budget");
  assert.match(message, /hangs/, "the failure names the tool");
  assert.ok(elapsed < 2000, `the budget is enforced promptly (took ${elapsed}ms)`);
}

// ---------------------------------------------------------------------------
// 3. A tool within its budget is untouched
// ---------------------------------------------------------------------------
{
  const service = new ExtensionRegistryService();
  const ctx = context();

  service.registerTool(
    {
      name: "quick",
      description: "returns fast",
      inputSchema: { type: "object" },
      timeoutMs: 5000,
      execute: async () => ({ value: 42 }),
    },
    ctx
  );

  const result = await ctx.tools.quick.execute({}, { toolCallId: "tc2" });
  assert.deepEqual(result, { value: 42 }, "a fast tool returns its result unchanged");

  // No budget at all = unbounded, the historical behaviour.
  const ctx2 = context(ctx.tools);
  service.registerTool(
    { name: "unbounded", description: "no budget", inputSchema: { type: "object" }, execute: async () => ({ ok: 1 }) },
    ctx2
  );
  assert.deepEqual(await ctx2.tools.unbounded.execute({}, { toolCallId: "tc3" }), { ok: 1 });
}

console.log("extension-tool-safety validation passed");
