/**
 * Validates that disabling an extension restores what its tool registration displaced.
 *
 * Run: pnpm --filter @codent/core run validate:extension-tool-restore
 *
 * Background. `ExtensionRegistryService.registerTool` writes straight into the agent's live
 * tools record, which is the ONLY holder of the previous tool — nothing keeps a copy of the
 * built-ins (`agent-factory.ts` spreads `createTools()` into the record and drops the local).
 * `unregisterExtensionTool` therefore used to `delete` the name unconditionally, so an
 * extension that shadowed `read_file` took the built-in with it on disable: `/extensions`
 * off, `read_file` gone, restart required.
 *
 * Two more things the same overwrite broke, both silent:
 *
 *   - `AgentToolService` retains a stale handler, so the unloaded
 *     extension's shaper kept formatting the restored tool's results for the model
 *     (`apply-tool-compact.ts` reads it on every model call).
 *   - The presentation descriptor went with it, so the restored tool was described by the
 *     fallback table — or by nothing at all when it is not a built-in, which sets
 *     `keepsCompactRow` false and drops its historical rows out of the compact view.
 *
 * A third is specific to a HANDOVER (an older extension released while a newer one still holds
 * the name): clearing the whole presentation entry there takes a live owner's descriptor with it
 * and leaves a registered tool described by the fallback table. Section 9 pins that.
 *
 * The design being pinned is a per-name stack in all three registries, keyed by owner:
 *
 *   - `ExtensionRegistryService.toolStacks` — what each owner registered, per name
 *   - `AgentToolService` stacks — what each owner declared / shapes with, per name
 *
 * Entries carry their own implementation, never the one they displaced, so "remove this owner,
 * re-read the top" is the only rule — the same operation whether the owner was on top or buried.
 * That is what makes one owner's release unable to resurrect another's tool, and what the earlier
 * displacement-ledger design got wrong in both directions.
 *
 * What is pinned here:
 *
 *   1. a shadowed built-in comes back on unregister, with its own tool object
 *   2. the extension's `toModelOutput` is rolled back to the built-in's
 *   3. an extension tool that shadowed nothing is still simply removed
 *   4. two extensions on one name: the name is handed back in reverse order, and only the last
 *      one out removes it (no resurrecting the built-in underneath both)
 *   5. a handover drops the older owner's artifacts and leaves the survivor untouched
 *   6. one owner registering the same name twice is released as a unit
 *   7. an owner that never registered the name never deletes it
 *   8. both disable orders, end to end through the real runner
 *   9. a handover keeps the surviving owner's presentation descriptor
 *  10. the per-name stack replaces an owner's entry rather than growing with agents
 */

import assert from "node:assert/strict";

import { createTools, resolveToolsRecord, ExtensionRunner, ManagedAgent } from "../dist/dev.mjs";

// ============================================================================
// Harness
// ============================================================================

function makeAgent(tools, id = "agent_restore") {
  return new ManagedAgent(
    { id, name: id, model: "gpt-4" },
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
      tools,
      todoManager: null,
    }
  );
}

/** Real built-in tool objects — each has already declared its `present` + `toModelOutput`. */
async function makeBuiltinAgent(id) {
  const builtins = resolveToolsRecord(await createTools());
  const record = Object.fromEntries(builtins.map((tool) => [tool.name, tool]));
  return { managed: makeAgent(record, id), builtinReadFile: record.read_file };
}

/** A minimal extension tool definition. `shaper` stands in for the tool's model-facing output. */
function extTool(description, shaper, present) {
  const def = {
    name: "read_file",
    description,
    inputSchema: { type: "object", properties: {} },
    execute: async () => ({}),
  };
  if (shaper) def.toModelOutput = () => shaper;
  if (present) def.present = present;
  return def;
}

/** Shape a stored result the way the wire does, so "whose handler won" is observable. */
function shaped(managed) {
  return managed.getToolModelOutput("read_file")?.({ toolCallId: "c1", input: {}, output: {} });
}

/** The live folder/row flags for `read_file` — `undefined` when nothing describes it. */
function presentation(managed) {
  const present = managed.getToolPresentation("read_file");
  return present ? { category: present.category, keepRow: present.keepRow } : undefined;
}

/** The built-in's own flags, so a test can tell "restored" from "fell back to nothing". */
const BUILTIN_PRESENTATION = { category: "reads", keepRow: undefined };

/** The runner's production wiring, so `setEnabled` exercises the real ownership rules. */
function runnerFor(managed) {
  return new ExtensionRunner({
    onRegisterTool: (def, ownerId) => managed.registerTool(def, ownerId),
    onUnregisterTool: (name, ownerId) => managed.unregisterExtensionTool(name, ownerId),
  });
}

/** An extension that takes `read_file`, tagging tool, shaper and descriptor so they are traceable. */
const ext = (id) => ({
  id,
  name: id,
  version: "1.0.0",
  activate(ctx) {
    ctx.registerTool({
      name: "read_file",
      description: `TOOL-${id}`,
      inputSchema: { type: "object", properties: {} },
      execute: async () => ({}),
      toModelOutput: () => `SHAPER-${id}`,
      present: { category: "edits", keepRow: false },
    });
  },
});

// ============================================================================
// 1. A shadowed built-in comes back
// ============================================================================

{
  const { managed, builtinReadFile } = await makeBuiltinAgent();
  const builtinShaper = shaped(managed);
  assert.equal(
    typeof builtinShaper,
    "string",
    "the built-in read_file must own a model shaper (its output is the shaper's own text)"
  );

  managed.registerTool(extTool("extension read (overwrites the built-in)", "EXTENSION SHAPING"));
  assert.notEqual(managed.tools.read_file, builtinReadFile, "the extension must have taken the name");
  assert.equal(
    shaped(managed),
    "EXTENSION SHAPING",
    "the extension's shaper must win while it is registered (otherwise this probe proves nothing)"
  );

  managed.unregisterExtensionTool("read_file");

  assert.ok(managed.tools.read_file, "the built-in read_file must be restored, not deleted");
  assert.equal(
    managed.tools.read_file,
    builtinReadFile,
    "the restored tool must be the original built-in object, not a re-created one"
  );
}

// ============================================================================
// 2. The extension's `toModelOutput` is rolled back
// ============================================================================

{
  const { managed } = await makeBuiltinAgent();
  const builtinShaper = shaped(managed);

  managed.registerTool(extTool("extension read", "EXTENSION SHAPING"), "ext_a");
  managed.unregisterExtensionTool("read_file", "ext_a");

  assert.equal(
    shaped(managed),
    builtinShaper,
    "the restored tool must shape results with its own handler — a leftover extension handler " +
      "silently formats every later `read_file` result for the model"
  );
  assert.notEqual(shaped(managed), "EXTENSION SHAPING", "the unloaded extension's handler must not survive");
}

// ============================================================================
// 3. A tool that was never shadowing anything is removed outright
//
// A name the extension introduced itself: there is no built-in underneath it, so the top of the
// stack is gone and the entry is dropped from the record. (`defineServerTool` seeds the
// incumbent slot, so the stack starts with an `undefined` tool rather than being absent.)
// ============================================================================

{
  const managed = makeAgent({});

  managed.registerTool(
    {
      name: "fresh_tool",
      description: "registered onto an empty record",
      inputSchema: { type: "object", properties: {} },
      execute: async () => ({}),
    },
    "ext_fresh"
  );
  assert.ok(managed.tools.fresh_tool, "registered onto an empty record");

  managed.unregisterExtensionTool("fresh_tool", "ext_fresh");
  assert.ok(!("fresh_tool" in managed.tools), "a tool with nothing underneath it must be removed");
}

// ============================================================================
// 4. Two extensions on one name: the name is handed back in reverse order
// ============================================================================

{
  const { managed, builtinReadFile } = await makeBuiltinAgent();

  managed.registerTool(extTool("first extension", "first", { category: "reads", keepRow: false }), "first");
  const firstTool = managed.tools.read_file;
  managed.registerTool(extTool("second extension", "second", { category: "commands", keepRow: false }), "second");
  const secondTool = managed.tools.read_file;
  assert.notEqual(firstTool, builtinReadFile);
  assert.notEqual(secondTool, firstTool);
  assert.equal(shaped(managed), "second", "the newest registration is the one in force");
  assert.deepEqual(
    presentation(managed),
    { category: "commands", keepRow: false },
    "and its descriptor is the live one"
  );

  // The newer extension is disabled first: the name goes back to the older one, NOT to the
  // built-in underneath both (popping the wrong entry would expose it early).
  managed.unregisterExtensionTool("read_file", "second");
  assert.equal(managed.tools.read_file, firstTool, "disabling the newer extension must restore the older one's tool");
  assert.notEqual(managed.tools.read_file, builtinReadFile, "the built-in is still shadowed by the first extension");
  assert.equal(shaped(managed), "first", "the older extension's shaper must be back in force");
  assert.deepEqual(
    presentation(managed),
    { category: "reads", keepRow: false },
    "and the older extension's descriptor, not the disabled one's"
  );

  // Only the last one out removes the name for good — which is the built-in returning.
  managed.unregisterExtensionTool("read_file", "first");
  assert.equal(managed.tools.read_file, builtinReadFile, "the built-in returns once every extension is gone");
  assert.notEqual(shaped(managed), "first", "no extension shaper may survive the last unregister");
  assert.deepEqual(
    presentation(managed),
    BUILTIN_PRESENTATION,
    "and the built-in's own descriptor is what remains — an extension's flags left here would " +
      "keep folding read_file rows the built-in wants kept"
  );
}

// ============================================================================
// 5. A handover releases only the older owner's artifacts — through the REAL runner
//
// The runner must not unregister a name a newer extension now owns (that would delete the newer
// extension's tool), but it MUST still release the older owner's artifacts: leaving them behind
// means the next unregister of the same name restores a handler from an extension that was
// disabled long ago.
// ============================================================================

{
  const { managed, builtinReadFile } = await makeBuiltinAgent();
  const runner = runnerFor(managed);

  const makeExt = (description) => ({
    id: description,
    name: description,
    version: "1.0.0",
    activate(ctx) {
      ctx.registerTool({
        name: "read_file",
        description,
        inputSchema: { type: "object", properties: {} },
        execute: async () => ({}),
        present: { category: "edits" },
      });
    },
  });

  await runner.loadExtension(makeExt("first"));
  const firstTool = managed.tools.read_file;
  assert.notEqual(firstTool, builtinReadFile, "the first extension took the name");

  await runner.loadExtension(makeExt("second"));
  const secondTool = managed.tools.read_file;
  assert.notEqual(secondTool, firstTool, "the second extension took the name from the first");

  // Disable the FIRST extension. It no longer owns the name, so its tool must stay — and the
  // runner's own mirror must stop reporting it, which is the one thing the host cannot reach.
  await runner.setEnabled("first", false);
  assert.equal(managed.tools.read_file, secondTool, "the surviving owner's tool must not be touched");
  assert.equal(runner.getTool("read_file")?.description, "second", "the runner's mirror must report the survivor");

  await runner.setEnabled("second", false);
  assert.equal(
    managed.tools.read_file,
    builtinReadFile,
    "the built-in underneath both extensions must come back — a stale entry hands back a tool " +
      "belonging to an extension that is no longer loaded"
  );
  assert.notEqual(managed.tools.read_file, firstTool, "the disabled first extension's tool must not resurface");
  assert.equal(runner.getTool("read_file"), undefined, "and nothing is registered under that name any more");

  await runner.destroyAll();
}

// ============================================================================
// 6. One owner registering the same name twice is released as a unit
//
// An extension can register a name twice inside a single `activate` (a config-driven extension
// building the list, then appending). Both registrations belong to the same owner, and the
// owner is disabled as a whole, so ONE release has to settle the name back to the tool it
// shadowed — and the runner's second (now redundant) call must be a no-op rather than a
// second restore.
//
// An earlier design kept one ledger entry per registration and unwound them one at a time,
// which is where this case was pinned. A stack makes that distinction unnecessary: entries are
// keyed by owner, so an owner's entries for a name go away together, and "remove this owner and
// re-read the top" is the only rule.
// ============================================================================

{
  const { managed, builtinReadFile } = await makeBuiltinAgent();

  managed.registerTool(extTool("registration one", "one"), "same-owner");
  managed.registerTool(extTool("registration two", "two"), "same-owner");
  assert.equal(shaped(managed), "two", "the newest registration of the owner is live");

  managed.unregisterExtensionTool("read_file", "same-owner");
  assert.equal(
    managed.tools.read_file,
    builtinReadFile,
    "releasing the owner must settle the name on what it shadowed, not leave its own tool behind"
  );
  assert.equal(shaped(managed), "{}", "and the built-in's own shaper is in force again");

  // The runner calls the hook once per registration, so it calls again here. Nothing is left
  // to remove; that must not re-write the record or resurrect anything.
  managed.unregisterExtensionTool("read_file", "same-owner");
  assert.equal(managed.tools.read_file, builtinReadFile, "the redundant release must be a no-op");
  assert.equal(shaped(managed), "{}", "and must not disturb the handler either");
}

// ============================================================================
// 7. An owner with no ledger entry never deletes the name
//
// `unregisterExtensionTool` is reachable with an owner that never registered this name (a
// host calling it directly, a registration that happened before the ledger existed). The one
// thing it must never do is remove a tool that is not its own — that is the original defect
// wearing a different hat.
// ============================================================================

{
  const { managed, builtinReadFile } = await makeBuiltinAgent();

  managed.unregisterExtensionTool("read_file", "ext_that_never_registered_this");
  assert.ok(managed.tools.read_file, "an unknown owner must not delete the name");
  assert.equal(managed.tools.read_file, builtinReadFile, "and must leave the current tool exactly as it is");
}

// ============================================================================
// 8. Both disable sequences — through the real runner
//
// The two orders are genuinely different paths through the host stack, not one with a different
// order applied: disabling the NEWER extension first hands the name to the older one, whose own
// disable is then an ordinary unregister; disabling the OLDER first is a handover (it no longer
// owns the name) followed by the last holder leaving.
//
// Both must end on the built-in, and this is the section that caught a runner that decided the
// case itself — its own per-runner `name → owner` map answered "is this name still mine?" with
// `true` on an agent whose tool was never the one taken, so the buried extension took the
// unregister path against a stack holding a live owner and the built-in never came back.
//
// The extensions declare a `present` and a `toModelOutput` too: without them, a descriptor or a
// model-output handler left behind by a disabled extension is invisible even when the restored
// tool object is correct.
// ============================================================================

{
  const newSeq = async () => {
    const { managed, builtinReadFile } = await makeBuiltinAgent();
    const runner = runnerFor(managed);
    await runner.loadExtension(ext("ext_old"));
    const oldTool = managed.tools.read_file;
    await runner.loadExtension(ext("ext_new"));
    const newTool = managed.tools.read_file;
    return { managed, runner, builtinReadFile, oldTool, newTool };
  };

  // 8a. Owner first: ext_new is disabled, the name returns to ext_old, THEN ext_old leaves as the
  // last holder. Everything ext_old displaced has to come back — tool object, handler, descriptor.
  {
    const { managed, runner, builtinReadFile, oldTool } = await newSeq();
    await runner.setEnabled("ext_new", false);
    assert.equal(managed.tools.read_file, oldTool, "disabling the owner hands the name back to the older tool");
    assert.equal(shaped(managed), "SHAPER-ext_old", "and to that tool's own handler");
    assert.deepEqual(
      presentation(managed),
      { category: "edits", keepRow: false },
      "…and to that tool's own descriptor"
    );

    await runner.setEnabled("ext_old", false);

    assert.equal(
      managed.tools.read_file,
      builtinReadFile,
      "the last holder leaving must RESTORE, not merely drop its entry — only dropping it leaves " +
        "the built-in shadowed by an extension that is already disabled"
    );
    assert.equal(shaped(managed), "{}", "and its process-global handler must be rolled back to the built-in's");
    assert.deepEqual(presentation(managed), BUILTIN_PRESENTATION, "and the built-in's descriptor takes over again");
    await runner.destroyAll();
  }

  // 8b. Buried first: ext_old is disabled while ext_new still holds the name, so it is a handover.
  // The survivor's tool, handler and descriptor must all be untouched by it.
  {
    const { managed, runner, builtinReadFile, oldTool, newTool } = await newSeq();
    await runner.setEnabled("ext_old", false);
    assert.equal(managed.tools.read_file, newTool, "the surviving extension's tool must stay in place");
    assert.notEqual(managed.tools.read_file, oldTool, "the disabled extension's tool must not resurface");
    assert.equal(shaped(managed), "SHAPER-ext_new", "and the surviving extension's handler must still be in force");
    assert.deepEqual(
      presentation(managed),
      { category: "edits", keepRow: false },
      "and its descriptor must survive the buried owner's release"
    );

    await runner.setEnabled("ext_new", false);
    assert.equal(managed.tools.read_file, builtinReadFile, "disabling both, buried first, must leave the built-in");
    assert.equal(shaped(managed), "{}", "with its handler");
    assert.deepEqual(presentation(managed), BUILTIN_PRESENTATION, "and its descriptor");
    await runner.destroyAll();
  }
}

// ============================================================================
// 9. A handover keeps the surviving owner's presentation descriptor
//
// Section 8b reaches this through the runner; this reaches the same state through the registry
// call the runner makes, so a failure points at `removeToolOwner` rather than at the runner's
// dispatch — and so the descriptor half cannot be "fixed" by touching the tool stack.
//
// A descriptor is not merely cosmetic: `keepRow` decides whether a tool's completed rows fold,
// and a tool with NO descriptor has `keepsCompactRow` false — its historical rows silently drop
// out of the compact transcript.
// ============================================================================

{
  const { managed, builtinReadFile } = await makeBuiltinAgent();

  managed.registerTool(extTool("buried owner", "buried", { category: "reads", keepRow: false }), "ext_buried");
  managed.registerTool(extTool("surviving owner", "survivor", { category: "searches", keepRow: true }), "ext_survivor");
  assert.deepEqual(presentation(managed), { category: "searches", keepRow: true }, "the survivor's descriptor is live");

  // Releasing the buried owner must drop only ITS descriptor. Clear the whole entry instead and
  // the live tool is described by the fallback table (or, for a name that is not a built-in, by
  // nothing at all).
  managed.unregisterExtensionTool("read_file", "ext_buried");
  assert.deepEqual(
    presentation(managed),
    { category: "searches", keepRow: true },
    "releasing a buried owner must leave the survivor's descriptor exactly as it was"
  );
  assert.equal(shaped(managed), "survivor", "and its handler");

  managed.unregisterExtensionTool("read_file", "ext_survivor");
  assert.deepEqual(
    presentation(managed),
    BUILTIN_PRESENTATION,
    "and when the survivor does leave, the built-in's descriptor is the one that remains"
  );
  assert.equal(managed.tools.read_file, builtinReadFile, "with the built-in tool back in place");
}

// ============================================================================
// 10. An owner's entry is replaced, not stacked, and release is per owner
//
// `defineServerTool` runs once per agent for the same built-in names (`createTools()` is re-run
// per agent), all under the owner default of the tool name itself, in registries that are
// process-global. A blind push would grow an entry per agent created. A different owner is a
// separate claim, and releasing one must not disturb the other's.
// ============================================================================

{
  const { managed } = await makeBuiltinAgent();

  // The built-in already registered `read_file`; re-creating the agent's tools must not add
  // another entry for it.
  const { managed: second } = await makeBuiltinAgent();
  assert.ok(second.tools.read_file, "a second agent also gets read_file");
  assert.notEqual(second.tools.read_file, managed.tools.read_file, "each agent owns its own live tool objects");
  assert.ok(managed.tools.read_file);

  // Two owners on one name: the newest is live, and releasing the buried one leaves it alone.
  managed.registerTool(extTool("owner a", "shaper-a"), "owner_a");
  managed.registerTool(extTool("owner b", "shaper-b"), "owner_b");
  assert.equal(shaped(managed), "shaper-b", "the newest owner's handler is live");

  managed.unregisterExtensionTool("read_file", "owner_a");
  assert.equal(shaped(managed), "shaper-b", "releasing a buried owner must not disturb the live one");
  assert.ok(managed.tools.read_file, "and must not delete the name");

  managed.unregisterExtensionTool("read_file", "owner_b");
  assert.notEqual(shaped(managed), "shaper-b", "releasing the live owner rolls its handler back");
}

// ============================================================================
// 11. The same extension loaded onto two agents keeps two independent claims
//
// Both registries are process-global, and the owner an extension supplies is its own id — so an
// extension loaded onto two agents in one process offers the SAME owner id twice. Those are two
// different tools in two different agents' tool sets, and releasing one agent's claim must leave
// the other's alone.
//
// `ManagedAgent` namespaces the id by agent, which is the only place that knows which agent a
// registration belongs to. Without it, `removeOwner(name, id)` cannot tell the two apart and
// unregistering one owner empties the survivor's stack too — the leak this
// section pins. It is driven through the real runner because the runner's callback is the
// production path for a disable.
// ============================================================================

{
  const sharedDef = (id) => ({
    name: "read_file",
    description: `TOOL-${id}`,
    inputSchema: { type: "object", properties: {} },
    execute: async () => ({}),
    toModelOutput: () => `SHAPER-${id}`,
    present: { category: "edits", keepRow: true },
  });

  // One extension id, loaded onto both agents.
  const shared = (label) => ({
    id: "shared-author/shared-ext",
    name: label,
    version: "1.0.0",
    activate(ctx) {
      ctx.registerTool(sharedDef(label));
    },
  });

  const { managed: agentA, builtinReadFile: aBuiltin } = await makeBuiltinAgent("agent_shared_a");
  const { managed: agentB, builtinReadFile: bBuiltin } = await makeBuiltinAgent("agent_shared_b");
  const runnerA = runnerFor(agentA);
  const runnerB = runnerFor(agentB);

  await runnerA.loadExtension(shared("A"));
  await runnerB.loadExtension(shared("B"));
  const bTool = agentB.tools.read_file;
  assert.notEqual(bTool, bBuiltin, "agent B's extension took the name");
  assert.equal(shaped(agentB), "SHAPER-B", "B's extension is the live owner of the shared name");
  assert.deepEqual(presentation(agentB), { category: "edits", keepRow: true }, "with B's descriptor");

  // Disable it on A only. B's extension is still loaded and running.
  await runnerA.setEnabled("shared-author/shared-ext", false);

  assert.equal(agentA.tools.read_file, aBuiltin, "agent A's own copy is restored");
  assert.equal(
    agentB.tools.read_file,
    bTool,
    "disabling an extension on one agent must not touch the other agent's tool — the same owner " +
      "id is a separate claim once it is scoped by agent"
  );
  assert.equal(
    shaped(agentB),
    "SHAPER-B",
    "and B's model-output handler must still be the one in force — a shared owner id used to " +
      "release B's handler as well"
  );
  assert.deepEqual(
    presentation(agentB),
    { category: "edits", keepRow: true },
    "and B's descriptor must survive too — clearing it leaves B's live tool described by the " + "fallback table"
  );

  // And B can still release its own claim, which restores the built-in.
  await runnerB.setEnabled("shared-author/shared-ext", false);
  assert.equal(agentB.tools.read_file, bBuiltin, "B's own disable restores its built-in");
  assert.equal(shaped(agentB), "{}", "with the built-in's handler");
  assert.deepEqual(presentation(agentB), BUILTIN_PRESENTATION, "and the built-in's descriptor");

  await runnerA.destroyAll();
  await runnerB.destroyAll();
}

// A runtime registration (a command/async callback registering a tool after activate) must publish
// the catalog immediately; activation itself publishes once at the batch boundary.
{
  const events = [];
  const runner = new ExtensionRunner({
    onRegisterTool: () => {},
    onToolRegistrationBatchComplete: () => events.push("batch"),
    onToolRegistrationComplete: () => events.push("runtime"),
  });
  const def = (name) => ({
    name,
    description: name,
    inputSchema: { type: "object", properties: {} },
    execute: async () => ({}),
  });
  const instance = await runner.loadExtension({
    id: "runtime-catalog-ext",
    name: "runtime-catalog-ext",
    version: "1.0.0",
    activate(ctx) {
      ctx.registerTool(def("probe_activation"));
    },
  });
  assert.deepEqual(events, ["batch"], "activation publishes once after the tool batch");
  instance.context.registerTool(def("probe_runtime"));
  assert.deepEqual(events, ["batch", "runtime"], "runtime registration publishes immediately");
  await runner.destroyAll();
}

// A module-declared id is the identity, not the discovered filename. Loading two files that both
// declare `dup-ext` replaces the first; `setEnabled("dup-ext", false)` must then reach the live
// copy instead of leaving an unreachable active instance behind.
{
  const { managed, builtinReadFile } = await makeBuiltinAgent("dup-id-agent");
  const runner = runnerFor(managed);
  const makeDup = (description) => ({
    id: "dup-ext",
    name: `Dup ${description}`,
    version: "1.0.0",
    activate(ctx) {
      ctx.registerTool(extTool(description));
    },
  });

  await runner.loadExtension(makeDup("first"));
  await runner.loadExtension(makeDup("second"));
  assert.equal(
    runner.getExtensionInfos().filter((info) => info.id === "dup-ext").length,
    1,
    "a duplicate module id replaces the previous instance"
  );
  assert.equal(managed.tools.read_file.description, "second", "the later copy owns the tool name");

  const disabled = await runner.setEnabled("dup-ext", false);
  assert.equal(disabled.ok, true, "the live duplicate can be disabled by id");
  assert.equal(managed.tools.read_file, builtinReadFile, "its disable restores the built-in");
  await runner.destroyAll();
}

console.log("extension-tool-restore validation passed");
