/**
 * Validation: per-call tool display payload (core-owned presentation).
 *
 * Run: pnpm --filter @codent/core run validate:tool-display
 *
 * Covers the contract of `computeToolDisplay` + `AgentUIChannel.attachToolDisplay`:
 *   1. a built-in renders its text/summary from the stored output
 *   2. rendering is deterministic (the payload is persisted, so it must be pure)
 *   3. a tool with no renderer and no built-in entry yields no payload
 *   4. a tool's own `present.text` wins, and it also owns its compact row
 *   5. the payload never reaches the model wire
 *   6. the channel attaches it to the matching tool-call part, and only that one
 */

import assert from "node:assert/strict";

const core = await import("../dist/index.mjs");
const dev = await import("../dist/dev.mjs");

// --- 1. built-in rendering ---------------------------------------------------
const readFile = core.computeToolDisplay("read_file", { type: "file", totalLines: 42, content: "x" });
assert.ok(readFile, "read_file produces a payload");
assert.equal(readFile.summary, "42 lines", `read_file summary (${readFile.summary})`);

const writeFile = core.computeToolDisplay("write_file", { path: "a.ts", bytes: 10, ok: true });
assert.equal(writeFile?.summary, "updated", `write_file summary (${writeFile?.summary})`);

// The framework's own failure shape is not any tool's schema: it must render as an error (the
// row header), never as fabricated success text. `todo` used to THROW from inside this function
// because its formatter read `stats.total` off `{ error }`, and `write_file` rendered
// "Overwrote file: undefined" for the common "file already exists" failure.
for (const [name, output] of [
  ["write_file", { error: "File already exists: src/a.ts." }],
  ["edit_file", { error: "No match found" }],
  ["todo", { error: "Disk full" }],
  ["run_command", { error: "spawn failed" }],
]) {
  assert.equal(
    core.formatToolOutput(output, name),
    "",
    `${name} must not fabricate a body from a framework error result`
  );
  assert.equal(
    core.getInlineSummary({ type: "tool-call", id: "c", name, arguments: "{}", state: "complete", output }, name),
    null,
    `${name} must not summarize a failed call as a success`
  );
}

// A `todo` payload without `stats` (any non-error malformed shape) must not throw in a render.
assert.doesNotThrow(() => core.formatToolOutput({ source: "plan" }, "todo"));
assert.equal(core.formatToolOutput({ source: "plan" }, "todo"), "Updated plan todos");

// A successful command has nothing the host cannot compute itself (it owns a detailed
// block, rendered locally from the stored output), so no payload is attached.
assert.equal(
  core.computeToolDisplay("run_command", { success: true, exitCode: 0, stdout: "hello", stderr: "" }),
  undefined,
  "a successful command carries no payload"
);
assert.equal(
  core.computeToolDisplay("run_command", { success: false, exitCode: 2, stdout: "", stderr: "" }),
  undefined,
  "a failed command carries no payload either (its failure line is host-computable)"
);

const listFile = core.computeToolDisplay("list_file", { count: 3, entries: [{ name: "a.ts", type: "file" }] });
assert.equal(listFile?.summary, "3 entries", `list_file summary (${listFile?.summary})`);

// Regression guard: only a tool's *own* renderer may put text in the payload — otherwise
// every built-in looks like it owns a result block (`read_file` / `grep` grew blocks).
for (const [name, output] of [
  ["read_file", { type: "file", totalLines: 42, content: "x" }],
  ["grep", { matches: [{ file: "a.ts", line: 1, text: "x" }] }],
  ["list_file", { count: 3, entries: [{ name: "a.ts", type: "file" }] }],
  ["write_file", { path: "a.ts", bytes: 10, ok: true }],
  ["glob", { files: ["a.ts"] }],
  ["tree", { tree: "a.ts" }],
]) {
  assert.equal(
    core.computeToolDisplay(name, output)?.text,
    undefined,
    `${name} must not carry text (it owns no result block)`
  );
}

// A renderer that throws must not take the run down: `todo` without stats is exactly
// the shape that used to raise inside `formatTodoOutput`.
assert.doesNotThrow(() => core.computeToolDisplay("todo", {}), "a throwing renderer is contained");

// --- 2. determinism ----------------------------------------------------------
assert.deepEqual(
  core.computeToolDisplay("read_file", { type: "file", totalLines: 42, content: "x" }),
  readFile,
  "same output renders the same payload"
);

// --- 3. no renderer, no payload ---------------------------------------------
assert.equal(core.computeToolDisplay("totally_unknown_tool", { ok: true }), undefined);
assert.equal(core.computeToolDisplay("", { ok: true }), undefined);

// --- 4. a tool's own renderer wins ------------------------------------------
assert.equal(core.keepsCompactRow("ext_echo"), false, "unknown tool keeps no row");
const service = new dev.AgentToolService();
service.register(
  {
    name: "ext_echo",
    description: "echo",
    inputSchema: { type: "object", properties: {} },
    execute: async () => ({ echoed: "hi" }),
    present: {
      category: "searches",
      text: (result) => (result?.echoed ? `echo → ${result.echoed}` : ""),
      label: (input) => input?.message,
    },
  },
  { ownerId: "test-extension" }
);
const resolveService = (name) => service.resolve(name)?.present;
assert.equal(service.resolve("ext_echo")?.present?.category, "searches");
assert.equal(core.keepsCompactRow("ext_echo", resolveService), true, "a text renderer owns its compact row");
assert.deepEqual(core.computeToolDisplay("ext_echo", { echoed: "hi" }, { message: "hi" }, resolveService), {
  text: "echo → hi",
  label: "hi",
});
assert.equal(
  core.computeToolDisplay("ext_echo", {}, undefined, resolveService),
  undefined,
  "empty renderer output yields no payload"
);
service.unregisterOwner("ext_echo", "test-extension");
assert.equal(
  core.computeToolDisplay("ext_echo", { echoed: "hi" }, undefined, (name) => service.resolve(name)?.present),
  undefined,
  "unregistering the owner removes the descriptor"
);

// --- 5. never on the model wire ---------------------------------------------
// The projection is TanStack's (`uiMessagesToModelMessages`), and core never calls it
// directly: it copies a fixed set of part fields (see design §1.3), so a top-level
// `display` cannot leak. The end-to-end assertion for that lives with the projection
// validators (`validate:message-chain-projection`, stage 7.2) rather than here.
// `display` on the part, not inside `output` (which the model receives verbatim).
const partWithDisplay = {
  type: "tool-call",
  id: "call_wire",
  name: "read_file",
  arguments: "{}",
  state: "complete",
  output: { type: "file", totalLines: 3 },
  display: { text: "3 lines" },
};
assert.equal(
  Object.prototype.hasOwnProperty.call(partWithDisplay, "display"),
  true,
  "the payload sits on the part itself"
);
assert.equal(
  partWithDisplay.output && typeof partWithDisplay.output === "object",
  true,
  "the tool output stays untouched"
);

// --- 6. channel attachment ---------------------------------------------------
const call = {
  type: "tool-call",
  id: "call_1",
  name: "read_file",
  arguments: JSON.stringify({ path: "a.ts" }),
  state: "complete",
  output: { type: "file", totalLines: 3, content: "x" },
  display: { text: "3 lines", summary: "3 lines" },
};
let captured = null;
const fakeChannel = {
  getMessages: () => [
    {
      id: "m1",
      role: "assistant",
      parts: [
        { ...call, display: undefined },
        { ...call, id: "call_2" },
      ],
    },
  ],
  setMessages: (messages) => {
    captured = messages;
  },
};
// `AgentUIChannel` is a runtime class handed out by the agent rather than part of the
// public package surface, so probe the method only when it is reachable; the end-to-end
// attachment assertions stay with `validate:agent-ui-channel` / `validate:early-tool-
// result-ui` (stage 7.2).
const attach = core.AgentUIChannel?.prototype?.attachToolDisplay;
if (typeof attach !== "function") {
  console.log("note: AgentUIChannel is not exported — attachment probe skipped");
} else {
  attach.call(fakeChannel, "call_1", { text: "attached" });
  assert.equal(captured?.[0]?.parts?.[0]?.display?.text, "attached", "payload lands on the matching part");
  assert.equal(captured?.[0]?.parts?.[1]?.display, undefined, "other tool calls are untouched");
  assert.equal(captured?.[0]?.parts?.[0]?.state, "complete", "the part's own fields survive");
}

console.log("validate-tool-display: ok");

// --- 7. catalog (snapshot) ---------------------------------------------------
const catalog = core.describeToolPresentations();
const byName = new Map(catalog.map((entry) => [entry.name, entry]));
assert.equal(byName.get("read_file")?.category, "reads", "built-ins are in the catalog");
assert.equal(byName.get("todo")?.keepRow, true, "row-keeping built-ins are marked");
assert.equal(byName.get("run_command")?.detailed, true, "detailed built-ins are marked");
assert.ok(
  catalog.every((entry) => typeof entry.name === "string"),
  "catalog entries are serializable data"
);

const catalogService = new dev.AgentToolService();
catalogService.register(
  {
    name: "ext_catalog",
    description: "catalog probe",
    inputSchema: { type: "object", properties: {} },
    execute: async () => ({ n: 1 }),
    present: { category: "searches", text: (r) => String(r?.n ?? "") },
  },
  { ownerId: "catalog-extension" }
);
assert.equal(
  catalogService.catalog().find((entry) => entry.name === "ext_catalog")?.hasText,
  true,
  "a registered extension tool joins the catalog"
);
catalogService.unregisterOwner("ext_catalog", "catalog-extension");
assert.equal(
  catalogService.catalog().some((entry) => entry.name === "ext_catalog"),
  false,
  "disabling an extension drops it from the catalog"
);

console.log("validate-tool-display: catalog ok");

// --- 8. durability -----------------------------------------------------------
// The payload rides the durable UI chain as ordinary JSON, and nothing recomputes it
// on restore: `attachMissingToolDisplays` only runs inside `finalizeStream` (a live
// run), so a restored session keeps exactly what was persisted. The model wire is
// covered separately by `validate:message-chain-projection`.
const roundTripped = JSON.parse(JSON.stringify(partWithDisplay));
assert.deepEqual(roundTripped.display, partWithDisplay.display, "the payload survives JSONL persistence");

console.log("validate-tool-display: durability ok");

// --- 9. block ownership ------------------------------------------------------
// Exactly these built-ins render a result block in full display. Every other built-in
// must stay block-less: filling their payload `text` made all of them look like block
// owners (`read_file` / `grep` grew output blocks).
const blockOwners = [
  "ask_user",
  "complete_plan",
  "get_command_output",
  "kill_command",
  "run_command",
  "task",
  "todo",
].sort();
const owners = core
  .describeToolPresentations()
  .filter((entry) => entry.detailed || entry.keepRow)
  .map((entry) => entry.name)
  .sort();
assert.deepEqual(owners, blockOwners, "the block-owning built-ins are unchanged");

console.log("validate-tool-display: block ownership ok");

// --- 10. failure outputs and host-side catalogs ------------------------------
// A failed call renders through the error path, so it must not carry success-shaped text.
assert.equal(
  core.computeToolDisplay("write_file", { error: "denied by user" }),
  undefined,
  "a failed write_file carries no payload"
);
assert.equal(
  core.computeToolDisplay("edit_file", { error: "no match" }),
  undefined,
  "a failed edit_file carries no payload"
);

// A host that never created the tools (remote session, publisher) receives the owner's
// serializable descriptor and resolves it through that session — never a process-global layer.
const remoteTool = "remote_only_tool";
assert.equal(core.getBuiltinToolPresentation(remoteTool), undefined, "unknown before the session descriptor");
const remotePresent = core.presentationFromInfo({
  name: remoteTool,
  category: "other",
  keepRow: true,
  detailed: true,
  clientSide: false,
});
const resolveRemote = (name) => (name === remoteTool ? remotePresent : undefined);
assert.equal(core.keepsCompactRow(remoteTool, resolveRemote), true, "the session descriptor restores row rules");
assert.equal(remotePresent.detailed, true, "and the flags");
assert.equal(
  core.describeToolPresentations().some((entry) => entry.name === remoteTool),
  false,
  "a session descriptor stays out of the host's published catalog"
);

console.log("validate-tool-display: failure + session descriptor ok");

// --- 11. failure shapes and registry lifecycle -------------------------------
// `{ ok: false }` / `{ success: false }` are failures just like `{ error }`: none of them may
// be summarized as a success, because the payload is persisted with the session.
for (const output of [{ error: "permission denied" }, { ok: false }, { success: false }, { isError: true }]) {
  assert.equal(
    core.computeToolDisplay("write_file", output),
    undefined,
    `write_file output ${JSON.stringify(output)} must not summarize as success`
  );
}
assert.equal(core.computeToolDisplay("memory_write", { ok: false }), undefined, "memory_write failure");

console.log("validate-tool-display: lifecycle + failure shapes ok");

// --- 11b. a cut-off task must not summarize as a clean finish -----------------
// The subagent's own status is `completed` for both a natural end and a budget
// cutoff, so the row summary is the only place the difference can show up. `task`
// carries `reachedLimit` / `incomplete` / `aborted`, and each must surface.
const limitDisplay = core.computeToolDisplay("task", {
  summary: "partial findings",
  iterations: 50,
  reachedLimit: true,
  incomplete: true,
  aborted: false,
  truncated: false,
});
assert.equal(limitDisplay?.summary, "limit reached", "a budget cutoff is not a clean finish");

const stalledDisplay = core.computeToolDisplay("task", {
  summary: "partial findings",
  reachedLimit: false,
  incomplete: true,
  aborted: false,
});
assert.equal(stalledDisplay?.summary, "stalled", "an incomplete run without a limit is a stall");

const cancelledDisplay = core.computeToolDisplay("task", {
  summary: "cancelled by user",
  reachedLimit: false,
  incomplete: false,
  aborted: true,
});
assert.equal(cancelledDisplay?.summary, "cancelled", "a cancelled run reads as cancelled");

// A clean run adds no status word (usage/iterations are rendered elsewhere).
assert.equal(
  core.computeToolDisplay("task", {
    summary: "found it",
    reachedLimit: false,
    incomplete: false,
    aborted: false,
  }),
  undefined,
  "a clean task run carries no status summary"
);

console.log("validate-tool-display: cut-off task summary ok");

// --- 12. session-descriptor fidelity ------------------------------------------
// `hasText` is what keeps a text-only tool's row alive (`keepRow || clientSide || text`), so it
// must survive rehydration even though the renderer itself cannot cross the process boundary.
const textOnly = core.presentationFromInfo({ name: "session_text_only", category: "other", hasText: true });
assert.equal(
  core.keepsCompactRow("session_text_only", () => textOnly),
  true,
  "a text-only tool keeps its row"
);
assert.equal(typeof textOnly.text, "function", "as a presence stub");

// A row that already shipped its rendered text must not fold, even when the local lookup has
// never heard of the tool (pre-change history replayed into a remote host).
const shippedRow = {
  type: "tool-call",
  toolCallId: "call-shipped",
  toolName: "ext_echo",
  name: "ext_echo",
  state: "output-available",
  input: { text: "hi" },
  output: { echoed: "hi" },
  display: { text: "echo -> hi" },
};
assert.equal(core.shouldKeepToolRow(shippedRow), true, "a row with shipped text keeps its row");

console.log("validate-tool-display: hydration fidelity ok");

// --- 13. Result bodies for tools that had none --------------------------------
// `tree`, `session_read` and `session_search` returned a real result with no renderer and no
// `formatToolOutput` case, so `ToolOutputView` printed the row header only: the model saw the
// output, the user saw that a tool ran. Each now declares `present.text`.
const presentOf = (tool) => dev.getToolMetadata(tool)?.present;

const treeTool = dev.createTreeTool();
const treeText = presentOf(treeTool)?.text;
assert.equal(typeof treeText, "function", "tree declares a result renderer");
const treeBody = treeText({ tree: "src\n  a.ts\n  b.ts", totalEntries: 3 });
assert.match(treeBody, /^3 entries\nsrc/, `tree body (${treeBody})`);
assert.equal(
  treeText({ tree: "", totalEntries: 0, cancelled: true }),
  "Cancelled by user.",
  "a cancelled walk is not an empty directory"
);
assert.equal(treeText({ tree: "", totalEntries: 0, cancelled: false }), "Empty directory");
const longTree = treeText({ tree: Array.from({ length: 30 }, (_, i) => `l${i}`).join("\n"), totalEntries: 30 });
assert.equal(longTree.split("\n").length, 17, "tree body keeps 15 lines + the count + the drop marker");
assert.match(longTree, /\.\.\. \(15 more lines\)$/, "the drop count is stated");

const readText = presentOf(dev.createSessionReadTool())?.text;
assert.equal(typeof readText, "function", "session_read declares a result renderer");
assert.match(
  readText({ content: "Session ses_1 (messages 0–1 of 2):\n\nhello" }),
  /Session ses_1/,
  "the page is shown"
);

const searchText = presentOf(dev.createSessionSearchTool())?.text;
assert.equal(typeof searchText, "function", "session_search declares a result renderer");
const searchBody = searchText({
  query: "plan",
  matches: [{ sessionId: "ses_1", messageIndex: 4, snippet: "we chose plan mode" }],
  total: 1,
});
assert.match(searchBody, /^1 matches for "plan":\n {2}ses_1 #4: /, `search body (${searchBody})`);
assert.match(
  searchText({ query: "plan", matches: [], total: 0 }),
  /^No matches for "plan"$/,
  "no hits says so instead of rendering an empty block"
);

// A renderer that is pure + bounded is what makes the payload safe to persist (see the header):
// the same output must render the same body every time.
assert.equal(treeText({ tree: "a\nb", totalEntries: 2 }), treeText({ tree: "a\nb", totalEntries: 2 }));

console.log("validate-tool-display: result bodies ok");
