/**
 * Validates the pi-like extension capabilities:
 *   - session:start / session:shutdown lifecycle events (per-agent ExtensionEventBus)
 *   - ExtensionUI.render (raw text + layout tree payloads)
 *   - plain JSON Schema (non-Zod) tool registration
 *   - modifiedResult applied to model-facing results via onToolPhaseComplete
 *   - existing observe-only tool:after stays unchanged (backward compat)
 *
 * Run: pnpm --filter @codent/core run validate:extension-pi-like
 */

import assert from "node:assert/strict";

import { createExtensionsMiddleware, ExtensionRunner, registerCoreEnv } from "../dist/dev.mjs";

// registerCoreEnv is always called before core functionality in real usage;
// provide a minimal stub so the runner's getEnv() fallback is safe here.
registerCoreEnv({
  rootPath: "/workspace",
  getPlatform: async () => "test",
  getArch: async () => "arm64",
  getEnv: async () => ({}),
  homedir: async () => "/home/test",
  fs: {
    readFile: async () => "",
    stat: async () => ({ isDirectory: false, isFile: false, size: 0, mtime: new Date() }),
    readdir: async () => [],
    writeFile: async () => {},
    mkdir: async () => {},
    exists: async () => false,
    remove: async () => {},
  },
  runCommand: async () => ({ stdout: "", stderr: "", code: 0 }),
  exec: async () => ({ stdout: "", stderr: "", code: 0 }),
  fetch: async () => ({ ok: true, status: 200 }),
});

// --- 1. Lifecycle + UI + JSON Schema tool via the runner --------------------
{
  const runner = new ExtensionRunner({
    getEnvVar: () => undefined,
    cwd: "/workspace",
    onRegisterTool: () => {},
    getCoreEnv: () => ({ rootPath: "/workspace" }),
  });

  const renderEvents = [];
  runner.getUI().subscribe("render", (data) => renderEvents.push(data));

  let sawStart = false;
  let sawShutdown = false;

  await runner.loadExtension({
    id: "smoke",
    name: "Smoke",
    version: "1.0.0",
    activate(ctx) {
      // CoreEnv is injected into the context.
      assert.equal(ctx.coreEnv.rootPath, "/workspace", "ctx.coreEnv injected");
      ctx.registerInterceptor("session:start", (event) => {
        sawStart = true;
        assert.equal(event.payload.cwd, "/workspace");
        assert.equal(event.payload.sessionId, "sess-1");
        ctx.ui.render("footer", "smoke", "ready");
      });
      ctx.registerInterceptor("session:shutdown", (event) => {
        sawShutdown = true;
        assert.equal(event.payload.sessionId, "sess-1");
      });
      ctx.registerTool({
        name: "json_tool",
        description: "plain JSON Schema tool",
        inputSchema: { type: "object", properties: { msg: { type: "string" } }, required: ["msg"] },
        execute: async (input) => ({ ok: input.msg }),
      });
    },
  });

  runner.emitSessionStart("/workspace", "sess-1");
  await new Promise((r) => setTimeout(r, 5));

  assert.equal(sawStart, true, "session:start fired");
  assert.equal(renderEvents.length, 1, "render published");
  assert.equal(renderEvents[0].surface, "footer");
  assert.equal(renderEvents[0].key, "smoke");
  assert.equal(renderEvents[0].payload, "ready", "raw text payload round-trips");
  assert.equal(runner.getUISlots().footer["smoke"], "ready", "render retained in snapshot");
  assert.ok(
    runner.getTools().some((t) => t.name === "json_tool"),
    "JSON Schema tool registered"
  );

  runner.emitSessionShutdown("sess-1");
  assert.equal(sawShutdown, true, "session:shutdown fired");
  await runner.destroyAll();
}

// --- 2. modifiedResult applied to model-facing results -----------------------
{
  const runner = new ExtensionRunner({ getEnvVar: () => undefined, onRegisterTool: () => {} });
  await runner.loadExtension({
    id: "rewrite",
    name: "Rewrite",
    version: "1.0.0",
    activate(ctx) {
      ctx.registerInterceptor("tool:after:ext_echo", (event) => {
        event.payload.modifiedResult = { ...event.payload.result, note: "rewritten" };
      });
    },
  });

  const middleware = createExtensionsMiddleware({
    getExtensionRunner: () => runner,
    getSessionId: () => "sess-2",
    emitEvent: () => {},
  });

  await middleware.onAfterToolCall?.(undefined, {
    ok: true,
    toolName: "ext_echo",
    duration: 5,
    result: { echoed: "hi" },
    toolCallId: "call-1",
    toolCall: { toolCallId: "call-1", function: { arguments: {} } },
  });

  const phaseResults = [{ toolCallId: "call-1", toolName: "ext_echo", result: { echoed: "hi" }, duration: 5 }];
  await middleware.onToolPhaseComplete?.(undefined, {
    toolCalls: [],
    results: phaseResults,
    needsApproval: [],
    needsClientExecution: [],
  });

  assert.equal(phaseResults[0].result.note, "rewritten", "modifiedResult applied via onToolPhaseComplete");
}

// --- 3. Observe-only tool:after stays unchanged (backward compat) ------------
{
  const runner = new ExtensionRunner({ getEnvVar: () => undefined, onRegisterTool: () => {} });
  let observed = null;
  await runner.loadExtension({
    id: "observe",
    name: "Observe",
    version: "1.0.0",
    activate(ctx) {
      ctx.registerInterceptor("tool:after:read_file", (event) => {
        observed = event.payload.result;
      });
    },
  });

  const middleware = createExtensionsMiddleware({
    getExtensionRunner: () => runner,
    getSessionId: () => "sess-3",
    emitEvent: () => {},
  });

  const r3 = [{ toolCallId: "c2", toolName: "read_file", result: { content: "x" }, duration: 1 }];
  await middleware.onAfterToolCall?.(undefined, {
    ok: true,
    toolName: "read_file",
    duration: 1,
    result: { content: "x" },
    toolCallId: "c2",
    toolCall: { toolCallId: "c2", function: { arguments: {} } },
  });
  await middleware.onToolPhaseComplete?.(undefined, {
    toolCalls: [],
    results: r3,
    needsApproval: [],
    needsClientExecution: [],
  });

  assert.equal(observed.content, "x");
  assert.equal(r3[0].result.content, "x", "observe-only result unchanged");
}

// --- 4. Runtime enable/disable (view + full unregistration) ------------------
{
  const registered = [];
  const unregistered = [];
  const runner = new ExtensionRunner({
    getEnvVar: () => undefined,
    onRegisterTool: (d) => registered.push(d.name),
    onUnregisterTool: (name) => unregistered.push(`tool:${name}`),
    onUnregisterCommand: (name) => unregistered.push(`cmd:${name}`),
  });
  let deactivated = false;

  await runner.loadExtension({
    id: "mgmt",
    name: "Mgmt",
    version: "1.0.0",
    activate(ctx) {
      ctx.registerTool({
        name: "mgmt_tool",
        description: "management test tool",
        inputSchema: { type: "object", properties: {} },
        execute: async () => ({ ok: true }),
      });
      ctx.registerCommand({
        name: "mgmt-cmd",
        description: "management test command",
        execute: async () => "mgmt",
      });
    },
    deactivate() {
      deactivated = true;
    },
  });

  let infos = runner.getExtensionInfos();
  assert.equal(infos.length, 1, "one extension loaded");
  assert.equal(infos[0].enabled, true, "extension starts enabled");
  assert.deepEqual(infos[0].tools, ["mgmt_tool"]);
  assert.deepEqual(infos[0].commands, [
    { name: "mgmt-cmd", hasOptions: false, description: "management test command" },
  ]);

  // Disable: deactivate() + unregister tool/command/interceptor artifacts.
  let res = await runner.setEnabled("mgmt", false);
  assert.equal(res.ok, true, res.message);
  assert.equal(deactivated, true, "deactivate() called on disable");
  assert.ok(unregistered.includes("tool:mgmt_tool"), "tool unregistered");
  assert.ok(unregistered.includes("cmd:mgmt-cmd"), "command unregistered");
  assert.ok(!runner.getTools().some((t) => t.name === "mgmt_tool"), "tool removed from registry");
  infos = runner.getExtensionInfos();
  assert.equal(infos[0].enabled, false, "extension disabled");

  // Re-enable: activate() re-registers artifacts.
  res = await runner.setEnabled("mgmt", true);
  assert.equal(res.ok, true, res.message);
  assert.ok(
    runner.getTools().some((t) => t.name === "mgmt_tool"),
    "tool re-registered on enable"
  );
  assert.ok(
    runner.getCommands().some((c) => c.name === "mgmt-cmd"),
    "command re-registered on enable"
  );
  infos = runner.getExtensionInfos();
  assert.equal(infos[0].enabled, true, "extension re-enabled");

  // Unknown id handled gracefully.
  res = await runner.setEnabled("nope", true);
  assert.equal(res.ok, false, "unknown id rejected");

  await runner.destroyAll();
}

// --- 5. Ownership collision + partial-activate + re-enable/disable leak ---------
{
  const unregistered = [];
  const runner = new ExtensionRunner({
    getEnvVar: () => undefined,
    onUnregisterTool: (name) => unregistered.push(`tool:${name}`),
    onUnregisterCommand: (name) => unregistered.push(`cmd:${name}`),
  });

  // ext-a registers tool "shared" and command "shared-cmd"
  await runner.loadExtension({
    id: "a",
    name: "A",
    version: "1.0.0",
    activate(ctx) {
      ctx.registerTool({
        name: "shared",
        description: "a tool",
        inputSchema: { type: "object", properties: {} },
        execute: async () => ({}),
      });
      ctx.registerCommand({ name: "shared-cmd", description: "a cmd", execute: async () => "a" });
    },
  });

  // ext-b overwrites the same tool/command names
  await runner.loadExtension({
    id: "b",
    name: "B",
    version: "1.0.0",
    activate(ctx) {
      ctx.registerTool({
        name: "shared",
        description: "b tool (overwrites)",
        inputSchema: { type: "object", properties: {} },
        execute: async () => ({}),
      });
      ctx.registerCommand({ name: "shared-cmd", description: "b cmd", execute: async () => "b" });
    },
  });

  assert.equal(runner.getTool("shared").description, "b tool (overwrites)", "b owns shared now");

  // Disabling a (the original owner) hands the name back with a's entry removed. The host is
  // told, because the host — not the runner — decides what becomes live: only it knows whether
  // another extension registered the name. b's tool must stay, so this notification is not a
  // removal. (The runner's own registry reflects its bookkeeping, not what the tools record
  // holds, so `getTool` is checked after b's disable below.)
  let res = await runner.setEnabled("a", false);
  assert.equal(res.ok, true, res.message);
  assert.ok(runner.getTool("shared"), "disable-a keeps b's tool");
  assert.ok(!unregistered.includes("cmd:shared-cmd"), "disable-a keeps b's command");

  // Disabling b (the current owner) removes the name.
  res = await runner.setEnabled("b", false);
  assert.equal(res.ok, true, res.message);
  assert.ok(unregistered.includes("tool:shared"), "disable-b unregisters shared");
  assert.ok(unregistered.includes("cmd:shared-cmd"), "disable-b unregisters shared-cmd");
  assert.ok(!runner.getTool("shared"), "tool removed after disable-b");

  // Re-enable b, then disable again: no duplicate/leak, artifacts tracked correctly.
  res = await runner.setEnabled("b", true);
  assert.equal(res.ok, true, res.message);
  assert.ok(runner.getTool("shared"), "b re-enabled tool");
  res = await runner.setEnabled("b", false);
  assert.equal(res.ok, true, res.message);
  let counts = unregistered.filter((u) => u === "tool:shared").length;
  assert.equal(counts, 3, "one notification per registration released (a's, then b's twice)");
  assert.ok(!runner.getTool("shared"), "tool removed after final disable-b");

  await runner.destroyAll();
}

// --- 6. Partial activate failure rolls back; re-enable works cleanly ------------
{
  const unregistered = [];
  const runner = new ExtensionRunner({
    getEnvVar: () => undefined,
    onUnregisterTool: (name) => unregistered.push(`tool:${name}`),
  });

  // activate registers a tool then throws → partial artifact must be rolled back.
  let activations = 0;
  let deactivations = 0;
  await runner.loadExtension({
    id: "flaky",
    name: "Flaky",
    version: "1.0.0",
    activate(ctx) {
      activations++;
      ctx.registerTool({
        name: "partial_tool",
        description: "registered before failure",
        inputSchema: { type: "object", properties: {} },
        execute: async () => ({}),
      });
      if (activations === 1) throw new Error("boom");
    },
    deactivate() {
      deactivations++;
    },
  });

  let info = runner.getExtensionInfos()[0];
  assert.equal(info.state, "error", "flaky initial activate failed");
  assert.deepEqual(info.tools, [], "partial tool rolled back after failed activate");
  assert.ok(!runner.getTool("partial_tool"), "partial tool not in registry");
  assert.ok(unregistered.includes("tool:partial_tool"), "partial tool unregistered on rollback");
  assert.equal(deactivations, 1, "failed activate releases the resources it acquired");

  // Re-enable: activate succeeds (second run), registers cleanly.
  let res = await runner.setEnabled("flaky", true);
  assert.equal(res.ok, true, res.message);
  assert.equal(activations, 2, "activate ran again on enable");
  info = runner.getExtensionInfos()[0];
  assert.deepEqual(info.tools, ["partial_tool"], "exactly one registration after re-enable");
  assert.ok(runner.getTool("partial_tool"), "tool registered on re-enable");

  // Disable again: exactly one unregister (no duplicate from the failed attempt).
  res = await runner.setEnabled("flaky", false);
  assert.equal(res.ok, true, res.message);
  const counts = unregistered.filter((u) => u === "tool:partial_tool").length;
  assert.equal(counts, 2, "rollback + final disable = 2 unregisters, no extra");
  assert.ok(!runner.getTool("partial_tool"), "tool removed on final disable");
  assert.equal(deactivations, 2, "final disable releases the re-enabled instance exactly once");

  await runner.destroyAll();
}

console.log("extension-pi-like validation passed");
