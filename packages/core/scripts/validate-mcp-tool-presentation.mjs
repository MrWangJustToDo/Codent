/**
 * Validation: MCP tools declare a presentation descriptor, and their registrations are
 * owner-scoped so nothing leaks across a server restart.
 *
 * Two bugs this pins, both of which were silent:
 *
 *  1. The MCP extension registered every discovered tool with `ctx.registerTool` and no
 *     `present`, so an MCP tool resolved **no descriptor at all**. Its name is not in the
 *     built-in table either, so the fallback could not cover it: the tool lost both its row
 *     (`keepsCompactRow` false) and its result block (`hasDetailedOutputBlock` false), and a
 *     remote host could not recover either — the catalog is built from
 *     registered + declared + built-in, and an MCP tool was in none of them.
 *
 *  2. The model-output registration used the **default** owner (the tool name), while the
 *     extension registry removes MCP registrations by the extension's id. The removal was
 *     therefore a miss: entries survived `shutdown()`, a name shared with a built-in kept
 *     shadowing that built-in's shaping, and nothing ever pruned the stack.
 *
 * The assertions drive the **real** `createMcpExtension` through a real `ExtensionRunner`,
 * with only the network boundary (`McpManager.initialize`) stubbed. A hand-written
 * `registerTool` call would test nothing: the bug WAS the missing field at that call site, so
 * the test has to read the call site's actual argument.
 *
 * Run: pnpm --filter @codent/core run validate:mcp-tool-presentation
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, normalize, parse, resolve, sep } from "node:path";

import {
  ExtensionRunner,
  MCP_TOOL_OWNER,
  McpManager,
  createMcpExtension,
  declareToolPresentation,
  describeToolPresentations,
  forgetToolPresentationOwner,
  getToolPresentation,
  hydrateToolPresentations,
  keepsCompactRow,
  registerCoreEnv,
  toModelOutputRegistry,
} from "../dist/dev.mjs";

import { TEMP_RM_OPTIONS } from "./helpers/temp-cleanup.mjs";

// ============================================================================
// CoreEnv — the extension reads it while activating
// ============================================================================
//
// `activateMcp` calls `loadMcpConfig`, which reads through `getEnv().fs`. Without an env the
// activation fails before registering anything, and every assertion below would pass
// vacuously against an empty tool list — so a real (temp-dir) env is part of the harness.

const root = await mkdtemp(join(tmpdir(), "codent-mcp-presentation-"));

// `activateMcp` returns early when no config file loads, so the harness has to supply one
// (with at least one server entry) or the extension never reaches its `registerTool` call —
// which is the call site under test. The server itself is never contacted: `initialize` is
// stubbed below.
await mkdir(join(root, ".agents"), { recursive: true });
await writeFile(
  join(root, ".agents", "mcp.json"),
  JSON.stringify({ mcpServers: { probe: { transport: "stdio", command: "true" } } })
);

registerCoreEnv({
  rootPath: root,
  path: {
    join: (...p) => join(...p),
    dirname: (p) => dirname(p),
    basename: (p, ext) => (ext ? basename(p, ext) : basename(p)),
    extname: (p) => extname(p),
    resolve: (...p) => resolve(...p),
    normalize: (p) => normalize(p),
    isAbsolute: (p) => isAbsolute(p),
    getSep: () => sep,
    parse: (p) => parse(p),
  },
  getPlatform: async () => "test",
  getArch: async () => "test",
  getEnv: async () => ({}),
  homedir: async () => root,
  byteLength: (s) => Buffer.byteLength(s, "utf-8"),
  fs: {
    // `loadMcpConfig` reads `.agents/mcp.json` / `.mcp.json` as **cwd-relative** paths (it does
    // not join `rootPath`), so the stubs resolve against `root` — the same thing a host whose
    // cwd is the workspace root would do. Reading the bare relative path instead would miss the
    // fixture below and the activation would silently register nothing.
    readFile: async (p) => readFile(join(root, p), "utf-8"),
    stat: async (p) => {
      const s = await stat(join(root, p));
      return { size: s.size, isFile: s.isFile(), isDirectory: s.isDirectory() };
    },
    readdir: async (p) => (await readdir(join(root, p))).map((name) => ({ name, type: "file" })),
    writeFile: async (p, c) => writeFile(join(root, p), c),
    mkdir: async (p) => {
      await mkdir(join(root, p), { recursive: true });
    },
    exists: async (p) => {
      try {
        await stat(join(root, p));
        return true;
      } catch {
        return false;
      }
    },
    remove: async (p) => rm(join(root, p), TEMP_RM_OPTIONS),
  },
});

// ============================================================================
// Harness — the real extension, a stubbed transport
// ============================================================================

/** Two tools, one of which shares a built-in name. */
const MCP_TOOLS = {
  mcp__probe_do_thing: {
    name: "mcp__probe_do_thing",
    description: "probe tool",
    inputSchema: { type: "object", properties: {} },
    execute: async () => ({ ok: true }),
  },
  // Deliberately a built-in name: this is the case where a wrong owner leaves the stale
  // handler shadowing the built-in's own shaping.
  read_file: {
    name: "read_file",
    description: "mcp read_file",
    inputSchema: { type: "object", properties: {} },
    execute: async () => ({ ok: true }),
  },
};

/** A `McpManager` stand-in: same surface `createMcpExtension` uses, no network. */
function makeStubManager() {
  const state = { initialized: 0, shutdowns: 0, tools: MCP_TOOLS };
  return {
    state,
    setConfigSource: () => {},
    async initialize() {
      state.initialized++;
      return state.tools;
    },
    async shutdown() {
      state.shutdowns++;
      // Deliberately does NOT clean registries — that is what bug 2 was about, and the
      // extension path must not depend on the manager remembering to.
      return undefined;
    },
    getServerStatuses: () => [{ name: "probe", transport: "stdio", toolCount: 2, status: "connected" }],
    // Handshake instructions (`MCPClient.instructions`, `@tanstack/ai-mcp` 0.8+); the
    // extension surfaces these as a turn-context section.
    getServerInstructions: () => [{ server: "probe", instructions: "Call mcp__probe_do_thing to do the thing." }],
  };
}

/** The descriptor the extension is expected to declare, for assertions that need it directly. */
const MCP_DESCRIPTOR = { category: "other", keepRow: true, detailed: true };

/**
 * Activate the real MCP extension and collect what it registered.
 *
 * `ExtensionRunner.loadExtension` is the production activation path: it builds the `ctx` the
 * extension receives, so `ctx.registerTool` here is the same call the bug was in. The host
 * callbacks (`onRegisterTool`) are what mirror a registration into the tool record in
 * production, so collecting `def` there is reading the real thing rather than a re-declaration.
 */
async function activateMcpExtension() {
  const manager = makeStubManager();
  const toolDefs = [];

  const runner = new ExtensionRunner({
    getEnvVar: () => undefined,
    cwd: root,
    onRegisterTool: (def) => toolDefs.push(def),
    onRegisterCommand: () => {},
    onUnregisterTool: () => {},
  });

  const extension = createMcpExtension({ mcpManager: manager });
  await runner.loadExtension(extension);

  // Guard the harness itself: everything below asserts on `toolDefs`, so an activation that
  // silently registered nothing would make the whole file pass for the wrong reason.
  assert.equal(manager.state.initialized, 1, "the extension reached its initialize() call");

  return { manager, toolDefs, extension, runner };
}

// ============================================================================
// 1. The descriptor reaches the declaration
// ============================================================================

const { manager, toolDefs, extension, runner } = await activateMcpExtension();

assert.ok(toolDefs.length > 0, "the MCP extension registered its tools through the runner");

for (const def of toolDefs) {
  assert.ok(def.present, `MCP tool "${def.name}" declares a presentation descriptor`);
  assert.equal(def.present.category, "other", `"${def.name}" is bucketed generically, not guessed from its name`);
  assert.equal(def.present.keepRow, true, `"${def.name}" keeps its row in compact display`);
  assert.equal(
    def.present.detailed,
    true,
    `"${def.name}" keeps its result block — without this the host's "no renderer" guard drops it`
  );
  assert.equal(
    def.present.text,
    undefined,
    `"${def.name}" claims no text renderer — that field asserts a curated single line exists`
  );
}

console.log(`✓ ${toolDefs.length} MCP tools declare keepRow + detailed under a generic category`);

// ============================================================================
// 1b. Server handshake instructions reach the model as a turn-context section
// ============================================================================
//
// `MCPClient.instructions` (`@tanstack/ai-mcp` 0.8+) carries the server's own usage
// guidance from the connect handshake. The extension surfaces it through its single
// context provider (one per extension, keyed by id) alongside the disabled notice.

{
  const { turnContextSections } = await runner.collectBeforeAgentStart("probe", "sess-mcp");
  const mcpSection = turnContextSections.find((section) => section.id === "codent-mcp");
  assert.ok(mcpSection, "the MCP extension contributes a turn-context section");
  assert.match(
    mcpSection.content,
    /Call mcp__probe_do_thing to do the thing\./,
    "the server's handshake instructions reach the model"
  );
  assert.match(mcpSection.content, /### probe/, "the section names the originating server");
}

console.log("✓ MCP handshake instructions surface as a turn-context section");

// ============================================================================
// 2. The declared descriptor actually resolves, and it is what decides rows
// ============================================================================

const MCP_NAME = "mcp__probe_do_thing";

const MCP_OWNER = "agent:codent-mcp";

// Pre-condition: this name means nothing to core, so before the declaration it resolved to
// no descriptor and folded. Asserted so "it resolves now" is not vacuous.
assert.equal(getToolPresentation(`${MCP_NAME}_never_declared`), undefined, "an undeclared MCP name has no descriptor");

declareToolPresentation(MCP_NAME, MCP_DESCRIPTOR, MCP_OWNER);

const resolved = getToolPresentation(MCP_NAME);
assert.ok(resolved, "a declared MCP tool resolves a descriptor");
assert.equal(resolved.category, "other");
assert.equal(resolved.keepRow, true);
assert.equal(resolved.detailed, true);

// The two host-side gates the descriptor feeds. These are the whole point: `false` on either
// is a tool whose result the user cannot see in compact display.
assert.equal(keepsCompactRow(MCP_NAME), true, "an MCP tool keeps its compact row");
assert.equal(
  keepsCompactRow("mcp__undeclared_thing"),
  false,
  "…and a name with no descriptor still folds, so the row rule is doing the work"
);

console.log("✓ a declared MCP tool keeps its row, and an undeclared one does not");

// ============================================================================
// 3. The descriptor ships to hosts
// ============================================================================

const catalogEntry = describeToolPresentations().find((entry) => entry.name === MCP_NAME);
assert.ok(catalogEntry, "an MCP tool is in the published catalog");
assert.equal(catalogEntry.keepRow, true, "its row rule ships");
assert.equal(catalogEntry.detailed, true, "its block rule ships");
assert.equal(catalogEntry.hasText, false, "and no renderer is claimed, because there is none");

// A host that never created the tools (remote session) learns the rules by adoption.
// MCP entries must survive that path, or a remote renderer folds MCP rows again.
hydrateToolPresentations([{ name: "mcp__adopted_thing", category: "other", keepRow: true, detailed: true }]);
assert.equal(keepsCompactRow("mcp__adopted_thing"), true, "an adopted MCP descriptor keeps its row remotely");

console.log("✓ MCP descriptors ship in the catalog and survive adoption");

// ============================================================================
// 4. Owner-scoped removal — no leak, no cross-owner damage
// ============================================================================

// The extension registry removes by owner on unload; the MCP declaration must come off and
// leave nothing behind.
forgetToolPresentationOwner(MCP_NAME, MCP_OWNER);
assert.equal(getToolPresentation(MCP_NAME), undefined, "removing the owner drops the MCP descriptor");
assert.equal(
  describeToolPresentations().some((entry) => entry.name === MCP_NAME),
  false,
  "and it leaves the catalog, so a remote host stops ruling dead rows"
);

// Two servers exposing the same tool name must not clobber each other. This is the property
// the owner-scoped path exists for, and the reason the unscoped registration is gone.
declareToolPresentation(MCP_NAME, MCP_DESCRIPTOR, "server-a");
declareToolPresentation(MCP_NAME, MCP_DESCRIPTOR, "server-b");
forgetToolPresentationOwner(MCP_NAME, "server-b");
assert.equal(getToolPresentation(MCP_NAME)?.keepRow, true, "server-a's declaration survives server-b's removal");
forgetToolPresentationOwner(MCP_NAME, "server-a");

// A tool shadowing a built-in must restore the built-in's own declaration, not leave the
// name undescribed — the failure that would silently drop a built-in's row out of compact view.
declareToolPresentation("read_file", MCP_DESCRIPTOR, "mcp-server");
assert.equal(getToolPresentation("read_file")?.category, "other", "the MCP declaration is live over the built-in");
forgetToolPresentationOwner("read_file", "mcp-server");
assert.equal(getToolPresentation("read_file")?.category, "reads", "the built-in's own declaration returns");

console.log("✓ owner-scoped removal is exact: no leak, no cross-owner damage");

// ============================================================================
// 5. The model-output registration carries the owner the removal looks for
// ============================================================================
//
// Bug 2. `toModelOutputRegistry.register(name, fn)` defaults `ownerId` to the tool name, but
// the extension registry removes by the extension's id — so the removal missed and the entry
// stayed, shadowing a same-named built-in's shaping for the rest of the process.
//
// The owner is asserted through the manager's **composed observable** rather than by reading
// its source or re-issuing the registration here: a validator that registers with the owner
// itself only proves the registry works, and would pass with the manager still calling the
// default. `ownerKeyFor` asks what a removal must pass to make the entry go away, which is
// only the owner if the manager actually used it.

assert.equal(MCP_TOOL_OWNER, "codent-mcp", "the owner is the MCP extension's id, so its removals match");

{
  const probe = "mcp__probe_shaping";
  const mcpManager = new McpManager();
  mcpManager.registerModelOutputFor(probe);

  const live = () =>
    toModelOutputRegistry.get(probe)?.({
      toolCallId: "c1",
      input: {},
      output: { content: [{ type: "text", text: "hi" }] },
    });

  // The extension registry's removal, using the owner it derives for the MCP extension.
  toModelOutputRegistry.removeOwner(probe, MCP_TOOL_OWNER);
  assert.equal(
    await live(),
    undefined,
    "removing under the MCP owner drops the manager's registration — a different owner would leave it behind"
  );
  assert.equal(toModelOutputRegistry.stackDepth(probe), 0, "and the entry is gone, not merely shadowed");
}

// Re-connecting must not accumulate: same owner, one entry.
{
  const probe = "mcp__probe_repeat";
  const mcpManager = new McpManager();
  mcpManager.registerModelOutputFor(probe);
  mcpManager.registerModelOutputFor(probe);
  assert.equal(toModelOutputRegistry.stackDepth(probe), 1, "a re-registration replaces the owner's own entry");
  toModelOutputRegistry.removeOwner(probe, MCP_TOOL_OWNER);
  assert.equal(toModelOutputRegistry.stackDepth(probe), 0, "and one removal clears it");
}

// A built-in's own shaping survives the MCP tool that shadowed it, once the server goes away.
{
  const shared = "read_file";
  toModelOutputRegistry.register(shared, () => "builtin-shaped", shared);
  const mcpManager = new McpManager();
  mcpManager.registerModelOutputFor(shared);

  const live = () => toModelOutputRegistry.get(shared)?.({ toolCallId: "c1", input: {}, output: {} });
  assert.equal(await live(), await toModelOutputRegistry.get(shared)({ toolCallId: "c", input: {}, output: {} }));
  assert.equal(toModelOutputRegistry.stackDepth(shared), 2, "the MCP entry stacks over the built-in's");

  toModelOutputRegistry.removeOwner(shared, MCP_TOOL_OWNER);
  assert.equal(await live(), "builtin-shaped", "dropping the MCP owner restores the built-in's shaping");
  assert.equal(toModelOutputRegistry.stackDepth(shared), 1, "the built-in's entry was never touched");
}

console.log("✓ the MCP model-output entry is owner-scoped and removable");

// ============================================================================
// 6. The manager's own teardown drops its registrations
// ============================================================================
//
// Nothing else removes them: the extension registry's removal runs per *registered extension
// tool*, and the MCP extension never unregisters on deactivate. So the manager has to clean up
// after itself, or every connect/reconnect cycle leaves the name occupied — and a name shared
// with a built-in keeps shadowing that built-in's shaping for the rest of the process.

for (const lifecycle of [
  ["shutdown", (m) => m.shutdown()],
  ["forceKill", (m) => m.forceKill()],
]) {
  const [label, run] = lifecycle;
  const probe = `mcp__probe_${label}`;
  const mcpManager = new McpManager();
  mcpManager.registerModelOutputFor(probe);
  assert.equal(toModelOutputRegistry.stackDepth(probe), 1, `${label}: registration exists before teardown`);

  // `forceKill` reads CoreEnv for stdio transports; there are none here, but the env is
  // registered in the harness above so the call does not throw before reaching the cleanup.
  await run(mcpManager);

  assert.equal(toModelOutputRegistry.stackDepth(probe), 0, `${label} drops this manager's registrations`);
}

// A reconnect after teardown must start clean rather than stack on top of a leaked entry.
{
  const probe = "mcp__probe_reconnect";
  const first = new McpManager();
  first.registerModelOutputFor(probe);
  await first.shutdown();
  const second = new McpManager();
  second.registerModelOutputFor(probe);
  assert.equal(toModelOutputRegistry.stackDepth(probe), 1, "a reconnect leaves exactly one entry, not a growing stack");
  toModelOutputRegistry.removeOwner(probe, MCP_TOOL_OWNER);
}

console.log("✓ teardown drops the manager's registrations, and a reconnect starts clean");

// ============================================================================
// 7. Deactivation shuts the manager down (no dangling servers)
// ============================================================================

await extension.deactivate?.();
assert.equal(manager.state.shutdowns, 1, "deactivating the MCP extension shuts its servers down");
await runner.destroyAll();

console.log("\nmcp-tool-presentation validation passed");
