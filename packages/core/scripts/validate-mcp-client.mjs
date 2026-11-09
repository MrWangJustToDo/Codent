/**
 * validate:mcp-client — the MCP client's trust surface.
 *
 * Four behaviours are asserted, all of them security-relevant and all of them previously absent:
 *
 *  1. Approval is derived from the server's own tool annotations, fail-closed, with the per-server
 *     override winning (`deriveNeedsApproval` + `resolveServerPolicy`).
 *  2. The client does not claim a capability it cannot answer: `elicitation` is on the wire only
 *     when an elicit hook exists (`mcpClientOptions` → serialized `initialize` capabilities).
 *  3. An elicit answer is normalized, and a throwing hook degrades to `decline` instead of hanging.
 *  4. A server's `input_required` becomes a failure that names the server and the request, and the
 *     `sampling` case says explicitly that this runtime cannot answer it.
 *
 * The manager-level cases drive `initialize` directly: a disabled server and an unusable policy
 * both decide before any transport is created, so they need no child process.
 */

import { MCPInputRequiredError } from "@tanstack/ai-mcp";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  deriveNeedsApproval,
  describeInputRequired,
  formatMcpStatus,
  MCP_APPROVAL_MODES,
  McpManager,
  mcpClientOptions,
  resolveServerPolicy,
} from "../dist/dev.mjs";

// ============================================================================
// Harness
// ============================================================================

let failures = 0;
function check(name, fn) {
  try {
    const result = fn();
    if (result instanceof Promise) throw new Error("check() is synchronous; use checkAsync()");
    console.log(`  ok   ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`  FAIL ${name}\n       ${error instanceof Error ? error.message : String(error)}`);
  }
}
async function checkAsync(name, fn) {
  try {
    await fn();
    console.log(`  ok   ${name}`);
  } catch (error) {
    failures += 1;
    console.error(`  FAIL ${name}\n       ${error instanceof Error ? error.message : String(error)}`);
  }
}

// ============================================================================
// 1. Policy: defaults and rejection
// ============================================================================

console.log("policy");

check("absent fields default to enabled + annotations", () => {
  const policy = resolveServerPolicy("srv", { transport: "stdio", command: "x" });
  assert.deepEqual(policy, { enabled: true, approval: "annotations" });
});

check("enabled:false is honoured", () => {
  assert.equal(resolveServerPolicy("srv", { transport: "stdio", command: "x", enabled: false }).enabled, false);
});

check("approval override wins over the default", () => {
  assert.equal(resolveServerPolicy("srv", { transport: "stdio", command: "x", approval: "always" }).approval, "always");
  assert.equal(resolveServerPolicy("srv", { transport: "stdio", command: "x", approval: "never" }).approval, "never");
});

check("an unusable approval value fails loudly, naming the server and the accepted set", () => {
  // Reaches the runtime through session create options, which never pass the config-file schema.
  assert.throws(
    () => resolveServerPolicy("bad-srv", { transport: "stdio", command: "x", approval: "sometimes" }),
    (error) => {
      assert.match(error.message, /bad-srv/);
      for (const mode of MCP_APPROVAL_MODES) assert.match(error.message, new RegExp(mode));
      return true;
    }
  );
});

// ============================================================================
// 2. Approval derivation
// ============================================================================

console.log("approval derivation");

check("no annotations gates (fail-closed)", () => {
  assert.equal(deriveNeedsApproval({}, "annotations"), true);
});

check("readOnlyHint:true does not gate", () => {
  assert.equal(deriveNeedsApproval({ annotations: { readOnlyHint: true } }, "annotations"), false);
});

check("destructiveHint:true gates", () => {
  assert.equal(deriveNeedsApproval({ annotations: { destructiveHint: true } }, "annotations"), true);
});

check("contradictory annotations resolve to destructive", () => {
  assert.equal(
    deriveNeedsApproval({ annotations: { readOnlyHint: true, destructiveHint: true } }, "annotations"),
    true
  );
});

check("approval:always overrides readOnlyHint", () => {
  assert.equal(deriveNeedsApproval({ annotations: { readOnlyHint: true } }, "always"), true);
});

check("approval:never overrides destructiveHint (explicit user choice)", () => {
  assert.equal(deriveNeedsApproval({ annotations: { destructiveHint: true } }, "never"), false);
});

// ============================================================================
// 3. Capability honesty + elicit answers
// ============================================================================

console.log("elicitation");

const transport = { type: "custom" };

/**
 * The handshake the server actually sees: the SDK spreads its defaults first, so reproducing that
 * merge is the only way to assert "we do not claim elicitation". The merge is pinned by the
 * assertion on the installed SDK below, so it cannot silently drift from upstream.
 */
function onTheWire(clientOptions) {
  return JSON.parse(JSON.stringify({ elicitation: { form: {} }, sampling: {}, ...clientOptions?.capabilities }));
}

check("without a hook the handshake carries no elicitation capability", () => {
  const options = mcpClientOptions("srv", transport, { enabled: true, approval: "annotations" });
  const wire = onTheWire(options.clientOptions);
  assert.equal("elicitation" in wire, false, "elicitation must not be advertised without a handler");
  assert.deepEqual(wire, { sampling: {} });
});

check("with a hook the capability is advertised and the handler is wired", () => {
  const options = mcpClientOptions("srv", transport, { enabled: true, approval: "annotations" }, async () => "accept");
  assert.equal(typeof options.onElicit, "function");
  assert.equal(options.clientOptions, undefined, "a hook must not strip the capability");
});

check("the handler and the claim are one decision, never split", () => {
  // Measured against @modelcontextprotocol/client 2.3.1: `setRequestHandler('elicitation/create')`
  // throws CAPABILITY_NOT_SUPPORTED when the capability is not declared. A handler without the
  // claim would fail EVERY MCP connection at construction; a claim without a handler is the lie
  // this change removes. Both combinations must therefore stay impossible.
  for (const hook of [undefined, async () => "accept"]) {
    const options = mcpClientOptions("srv", transport, { enabled: true, approval: "annotations" }, hook);
    const advertised = "elicitation" in onTheWire(options.clientOptions);
    assert.equal(advertised, typeof options.onElicit === "function", `hook=${Boolean(hook)} splits the pair`);
  }
});

check("needsApproval is wired from the policy", () => {
  const options = mcpClientOptions("srv", transport, { enabled: true, approval: "always" });
  assert.equal(options.needsApproval({ annotations: { readOnlyHint: true } }), true);
});

await checkAsync("shorthand answers are normalized for the wire", async () => {
  const options = mcpClientOptions("srv", transport, { enabled: true, approval: "annotations" }, async () => "accept");
  assert.deepEqual(await options.onElicit({ message: "allow?" }), { action: "accept" });
});

await checkAsync("object answers pass through with their content", async () => {
  const options = mcpClientOptions("srv", transport, { enabled: true, approval: "annotations" }, async () => ({
    action: "accept",
    content: { site: "example.com" },
  }));
  assert.deepEqual(await options.onElicit({ message: "site?" }), {
    action: "accept",
    content: { site: "example.com" },
  });
});

await checkAsync("a throwing hook degrades to decline and is recorded", async () => {
  const notes = [];
  const options = mcpClientOptions(
    "srv",
    transport,
    { enabled: true, approval: "annotations" },
    async () => {
      throw new Error("no UI");
    },
    (note) => notes.push(note)
  );
  assert.deepEqual(await options.onElicit({ message: "allow?" }), { action: "decline" });
  assert.equal(notes.length, 1);
  assert.match(notes[0], /no UI/);
});

await checkAsync("a manager without a hook reports elicitation unavailable", async () => {
  const manager = new McpManager({}, {});
  assert.equal(manager.isElicitationAvailable(), false);
  // Nothing recorded yet: the SDK answers an undeclared request itself, so core has nothing to
  // report and an idle session must not accumulate noise.
  assert.deepEqual(manager.takeDiagnostics(), []);
});

// ============================================================================
// 4. `input_required` mapping
// ============================================================================

console.log("input_required");

check("form requests name the server, the kind and the request", () => {
  const text = describeInputRequired("js", new MCPInputRequiredError("form", { message: "Allow Chrome?" }));
  assert.match(text, /"js"/);
  assert.match(text, /needs user input/);
  assert.match(text, /Allow Chrome\?/);
  assert.match(text, /ask the user/);
});

check("sampling requests state that this runtime cannot answer them", () => {
  const text = describeInputRequired("js", new MCPInputRequiredError("sampling", { maxTokens: 64 }));
  assert.match(text, /cannot answer/);
  assert.match(text, /maxTokens/);
});

// ============================================================================
// 5. The dependency patch that makes any of this reachable
// ============================================================================

console.log("dependency patch");

// Upstream 1.0.0 calls `connectTransport(options)` without the elicit handler, so without the patch
// every assertion above would describe an option the client ignores. A reinstall that drops the
// patch is silent (`pnpm install` restores the published file), which is exactly why it is asserted
// here instead of trusted.
const aiMcpClient = readFileSync(
  new URL("../node_modules/@tanstack/ai-mcp/dist/esm/client.js", import.meta.url),
  "utf8"
);
check("the elicit handler reaches connectTransport (patched dependency is installed)", () => {
  assert.match(aiMcpClient, /connectTransport\(options,\s*options\.onElicit\)/);
});

check("the capability merge this guard mirrors is still what the SDK does", () => {
  // `onTheWire()` above reproduces this spread. If upstream changes the defaults (adds `url`
  // elicitation, drops `sampling`), the mirror would quietly stop matching the handshake — so the
  // source of truth is asserted here and the mirror must be updated with it.
  assert.match(aiMcpClient, /elicitation:\s*\{\s*form:\s*\{\s*\}\s*\}/);
  assert.match(aiMcpClient, /\.\.\.clientOptions\?\.capabilities/);
});

check("the SDK stamps the approval flag on a gated tool (not the fixture)", () => {
  // The presentation fixture sets `needsApproval: true` by hand, so on its own it cannot prove
  // where the flag comes from. This is the client-side stamp the extension then forwards.
  const aiMcpTools = readFileSync(
    new URL("../node_modules/@tanstack/ai-mcp/dist/esm/tools.js", import.meta.url),
    "utf8"
  );
  assert.match(aiMcpTools, /needsApproval\.\?\.[^]*\.needsApproval\s*=\s*true|needsApproval\s*=\s*true/);
});

const aiMcpTypes = readFileSync(
  new URL("../node_modules/@tanstack/ai-mcp/dist/esm/types.d.ts", import.meta.url),
  "utf8"
);
check("the option is typed, so a caller cannot pass it unchecked", () => {
  assert.match(aiMcpTypes, /onElicit\?:/);
});

check("the patch is declared and its file exists, so a reinstall reapplies it", () => {
  const workspace = readFileSync(new URL("../../../pnpm-workspace.yaml", import.meta.url), "utf8");
  assert.match(workspace, /patchedDependencies:/);
  assert.match(workspace, /@tanstack\/ai-mcp@1\.0\.0/);
  const patch = readFileSync(new URL("../../../patches/@tanstack__ai-mcp@1.0.0.patch", import.meta.url), "utf8");
  assert.match(patch, /options\.onElicit/);
});

// ============================================================================
// 6. `/mcp` rendering
// ============================================================================

console.log("/mcp status");

const connectedRow = {
  name: "probe",
  transport: "stdio",
  toolCount: 3,
  status: "connected",
  enabled: true,
  approvalMode: "always",
};
const disabledRow = {
  name: "off",
  transport: "stdio",
  toolCount: 0,
  status: "disabled",
  enabled: false,
  approvalMode: "never",
};
const failedRow = {
  name: "bad",
  transport: "http",
  url: "https://x/mcp",
  toolCount: 0,
  status: "failed",
  enabled: true,
  approvalMode: "annotations",
  error: "boom",
};

check("approval mode and tool count are shown for a connected server", () => {
  const text = formatMcpStatus([connectedRow], false);
  assert.match(text, /approval=always/);
  assert.match(text, /3 tools/);
});

check("a disabled server is not rendered as a failure", () => {
  const text = formatMcpStatus([disabledRow], true);
  assert.match(text, /–\s+off/);
  assert.equal(/✗/.test(text), false, "a deliberate disable must not use the failure glyph");
  assert.match(text, /1 disabled/);
});

check("a failed server keeps its error line", () => {
  const text = formatMcpStatus([failedRow], true);
  assert.match(text, /✗/);
  assert.match(text, /failed: boom/);
});

check("elicitation availability is stated once", () => {
  assert.match(formatMcpStatus([connectedRow], false), /elicitation unavailable/);
  assert.match(formatMcpStatus([connectedRow], true), /elicitation available/);
});

// ============================================================================
// 7. Manager-level: disabled servers and unusable policy need no transport
// ============================================================================

console.log("manager (no transport)");

await checkAsync("a disabled server connects nothing and is reported as disabled", async () => {
  const manager = new McpManager({}, {});
  const tools = await manager.initialize({
    mcpServers: { off: { transport: "stdio", command: "no-such-binary", enabled: false } },
  });
  assert.deepEqual(Object.keys(tools), []);
  const [status] = manager.getServerStatuses();
  assert.equal(status.status, "disabled");
  assert.equal(status.enabled, false);
  assert.equal(status.toolCount, 0);
});

await checkAsync("an unusable policy is a failed server, not a silent default", async () => {
  const manager = new McpManager({}, {});
  const tools = await manager.initialize({
    mcpServers: { bad: { transport: "stdio", command: "no-such-binary", approval: "sometimes" } },
  });
  assert.deepEqual(Object.keys(tools), []);
  const [status] = manager.getServerStatuses();
  assert.equal(status.status, "failed");
  assert.match(status.error, /sometimes/);
  assert.match(status.error, /expected one of/);
});

// `forceKill` used to clear the client map without closing anything, so a teardown left HTTP/SSE
// transports open (and `deactivate`'s `shutdown()` then iterated an empty map).
await checkAsync("forceKill closes attached clients, not just the reference", async () => {
  const manager = new McpManager({}, {});
  let closed = 0;
  manager.clients.set("s1", {
    close: async () => {
      closed += 1;
    },
  });
  manager.forceKill();
  await Promise.resolve();
  assert.equal(closed, 1, "close() is initiated synchronously");
  assert.equal(manager.getConnectedServers().length, 0, "and the map is cleared");
});

// `shutdown()` awaits `client.close()`. A re-enable can start inside that window; the old shutdown
// must not clear the NEW incarnation's statuses (a single `closed` boolean could not express this,
// which is what `generation` is for).
await checkAsync("a shutdown in flight does not clear a newer incarnation's state", async () => {
  const manager = new McpManager({}, {});
  let releaseClose;
  const closing = new Promise((resolve) => {
    releaseClose = resolve;
  });
  manager.clients.set("old", { close: () => closing });
  const shutdown = manager.shutdown();
  await manager.initialize({
    mcpServers: { off: { transport: "stdio", command: "no-such-binary", enabled: false } },
  });
  assert.equal(manager.getServerStatuses()[0]?.status, "disabled");
  releaseClose();
  await shutdown;
  assert.equal(manager.getServerStatuses()[0]?.status, "disabled", "the newer incarnation keeps its server list");
});

// ============================================================================

if (failures > 0) {
  console.error(`\nvalidate:mcp-client — ${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nvalidate:mcp-client — all checks passed");
