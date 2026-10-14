/**
 * Offline validation for the file-tool content previews in @codent/im-bridge —
 * mock ChatAdapter + fake AgentSession, no server / no Telegram required.
 *
 * These previews are the one deliberate exception to the one-line tool status
 * list: `edit_file` and `write_file` both require approval, so the reviewer must
 * see WHAT is edited / written (not just the path) before tapping Approve in
 * chat. Assertions cover:
 * - edit_file awaiting approval → fenced `- old / + new` rides the tool call's own
 *   message, buttons included;
 * - edit_file completed → the preview survives the ✅ row, whole-file output stays
 *   out of chat;
 * - caps → 2 edits / 4 lines per side / char budget, with a truncation marker;
 * - write_file → `+` lines of the new content, 6-line preview + omitted marker;
 * - failure → error excerpt instead of a preview (nothing was written).
 *
 * Run (builds first):
 *   pnpm --filter @codent/im-bridge validate:bridge
 *   node packages/im-bridge/scripts/validate-bridge-tool-preview.mjs
 */

import assert from "node:assert/strict";
import { rmSync } from "node:fs";

import { TEMP_RM_OPTIONS } from "../../core/scripts/helpers/temp-cleanup.mjs";

import { CHAT, startedBridges, startBridge, tmpBase, waitFor } from "./validate-bridge-harness.mjs";

function textMsg(role, id, text) {
  return { role, id, createdAt: new Date(), parts: [{ type: "text", content: text }] };
}

async function testEditFileDiffPreview() {
  const { adapter, host } = await startBridge({ IM_BRIDGE_APPROVAL_TTL_MS: "5000" });
  await adapter.emitMessage({ platform: "mock", chat: CHAT, userId: "u1", text: "edit it", raw: null });
  const session = [...host.sessions.values()][0];
  await waitFor(() => adapter.sent.length === 1, 2000, "placeholder");

  const editPart = (id, edits, extra = {}) => ({
    type: "tool-call",
    id,
    name: "edit_file",
    arguments: JSON.stringify({ path: "src/foo.ts", edits }),
    state: extra.state ?? "input-complete",
    ...extra,
  });
  const twoEdits = [
    { oldString: "const a = 1;", newString: "const a = 2;" },
    { oldString: "const b = 3;", newString: "const b = 4;" },
  ];
  const runPart = (parts) => {
    session.state.messages = [textMsg("user", "u1", "edit it"), { role: "assistant", id: "a1", parts }];
    session.emit("messages", session.state.messages);
  };
  const latest = () => [...adapter.log].reverse().find((entry) => entry.text.includes("edit_file"));

  // 1) Awaiting approval: the preview rides the tool call's own message, next to
  //    the buttons — no separate message, no path-only row.
  runPart([editPart("t1", twoEdits, { approval: { id: "ap1", needsApproval: true, approved: undefined } })]);
  await waitFor(() => adapter.log.some((entry) => entry.buttons?.length > 0), 2000, "edit approval row");
  const approvalRow = adapter.log.find((entry) => entry.buttons?.length > 0);
  assert.ok(approvalRow.text.startsWith("\u23F8\uFE0F"), "awaiting-approval emoji leads");
  assert.ok(approvalRow.text.includes("edit_file · src/foo.ts"), "path still leads the row");
  assert.ok(approvalRow.text.includes("awaiting approval"), "pending state kept");
  assert.ok(approvalRow.text.includes("```diff"), "diff is fenced for Telegram <pre><code>");
  assert.ok(approvalRow.text.includes("- const a = 1;\n+ const a = 2;"), "edit 1 shows - old / + new");
  assert.ok(approvalRow.text.includes("- const b = 3;\n+ const b = 4;"), "edit 2 shows - old / + new");
  assert.equal((approvalRow.text.match(/```/g) ?? []).length, 2, "one closed fence pair");

  // 2) Completed: the preview survives on the ✅ row, and the (whole-file)
  //    output is never dumped into the chat.
  const huge = "HUGE_WHOLE_FILE_CONTENT";
  runPart([
    editPart("t1", twoEdits, {
      state: "output-available",
      approval: { id: "ap1", needsApproval: true, approved: true },
      output: { path: "src/foo.ts", replacements: 2, oldFile: huge, newFile: huge },
    }),
  ]);
  await waitFor(() => latest().text.startsWith("✅"), 2000, "completed edit row");
  const doneRow = latest();
  assert.ok(doneRow.text.includes("+ const a = 2;"), "preview kept after completion");
  assert.ok(!doneRow.text.includes(huge), "output.oldFile/newFile are not dumped into the chat");

  // 3) Caps: 2 edits shown, per-side lines trimmed, everything else marked.
  const longSide = (prefix) => Array.from({ length: 6 }, (_, index) => `${prefix}${index + 1}`).join("\n");
  runPart([
    editPart(
      "t2",
      [
        { oldString: longSide("old"), newString: longSide("new") },
        { oldString: "x", newString: "y" },
        { oldString: "z", newString: "w" },
      ],
      { state: "output-available", output: { path: "src/foo.ts", replacements: 3 } }
    ),
  ]);
  await waitFor(() => latest().text.includes("more line"), 2000, "capped diff row");
  const cappedRow = latest();
  assert.ok(cappedRow.text.includes("- old1\n- old2\n- old3\n- old4\n+ new1"), "lines per side capped at 4");
  assert.ok(!cappedRow.text.includes("old5"), "overflowing lines dropped");
  assert.ok(cappedRow.text.includes("… 4 more lines, 1 more edit"), "truncation marker accounts for both caps");
  assert.ok(cappedRow.text.length < 4096, "capped block stays well under the platform limit");

  // 4) Failed edit: the error excerpt shows, no preview (nothing was written).
  runPart([
    editPart("t3", twoEdits, {
      state: "output-available",
      output: { success: false, error: "no changes were written: oldString not found" },
    }),
  ]);
  await waitFor(() => latest().text.includes("no changes were written"), 2000, "failed edit row");
  const failedRow = latest();
  assert.ok(failedRow.text.startsWith("❌"), "failure emoji leads");
  assert.ok(!failedRow.text.includes("```diff"), "failed edit shows no diff");
  console.log("✓ edit_file diff preview: shown while awaiting approval + after completion, capped, hidden on failure");
}

/**
 * `write_file` replaces the whole file and its input carries only the NEW
 * content, so the row previews the content as `+` lines (an addition preview,
 * not a diff) — capped to the leading 6 lines with an omitted-lines marker.
 */
async function testWriteFilePreview() {
  const { adapter, host } = await startBridge({ IM_BRIDGE_APPROVAL_TTL_MS: "5000" });
  await adapter.emitMessage({ platform: "mock", chat: CHAT, userId: "u1", text: "write it", raw: null });
  const session = [...host.sessions.values()][0];
  await waitFor(() => adapter.sent.length === 1, 2000, "placeholder");

  const writePart = (id, content, extra = {}) => ({
    type: "tool-call",
    id,
    name: "write_file",
    arguments: JSON.stringify({ path: "src/new-file.ts", content, overwrite: true }),
    state: extra.state ?? "input-complete",
    ...extra,
  });
  const runPart = (parts) => {
    session.state.messages = [textMsg("user", "u1", "write it"), { role: "assistant", id: "a1", parts }];
    session.emit("messages", session.state.messages);
  };
  const latest = () => [...adapter.log].reverse().find((entry) => entry.text.includes("write_file"));

  // Short file: every line shown, no marker, trailing newline not rendered as an
  // empty `+` line.
  runPart([
    writePart("w1", "export const a = 1;\nexport const b = 2;\n", {
      approval: { id: "ap1", needsApproval: true, approved: undefined },
    }),
  ]);
  await waitFor(() => adapter.log.some((entry) => entry.buttons?.length > 0), 2000, "write approval row");
  const approvalRow = adapter.log.find((entry) => entry.buttons?.length > 0);
  assert.ok(approvalRow.text.includes("write_file · src/new-file.ts"), "path still leads the row");
  assert.ok(approvalRow.text.includes("awaiting approval"), "pending state kept");
  assert.ok(approvalRow.text.includes("```diff"), "content is fenced for Telegram <pre><code>");
  assert.ok(approvalRow.text.includes("+ export const a = 1;\n+ export const b = 2;"), "content as + lines");
  assert.ok(!approvalRow.text.includes("+ \n"), "no empty trailing + line");
  assert.ok(!approvalRow.text.includes("more line"), "short file needs no marker");

  // Long file: leading 6 lines previewed, the rest counted.
  const long = Array.from({ length: 20 }, (_, index) => `line ${index + 1}`).join("\n");
  runPart([
    writePart("w2", long, {
      state: "output-available",
      output: { path: "src/new-file.ts", bytesWritten: 200, created: true },
    }),
  ]);
  await waitFor(() => latest().text.includes("more lines"), 2000, "capped write row");
  const cappedRow = latest();
  assert.ok(cappedRow.text.startsWith("✅"), "completed write row");
  assert.ok(cappedRow.text.includes("+ line 1\n+ line 2"), "preview starts at the first line");
  assert.ok(cappedRow.text.includes("+ line 6"), "six lines previewed");
  assert.ok(!cappedRow.text.includes("+ line 7"), "line 7 onward omitted");
  assert.ok(cappedRow.text.includes("… 14 more lines"), "omitted lines counted");

  // Failed write (file exists, overwrite not set): error only, no preview.
  runPart([
    writePart("w3", "nope", {
      state: "output-available",
      approval: { id: "ap2", needsApproval: true, approved: true },
      output: { success: false, error: "File already exists: src/new-file.ts." },
    }),
  ]);
  await waitFor(() => latest().text.includes("File already exists"), 2000, "failed write row");
  const failedRow = latest();
  assert.ok(failedRow.text.startsWith("❌"), "failure emoji leads");
  assert.ok(!failedRow.text.includes("```diff"), "failed write shows no preview");
  console.log("✓ write_file preview: + lines from input, capped at 6 with marker, hidden on failure");
}

// ============================================================================

const tests = [testEditFileDiffPreview, testWriteFilePreview];

let failed = 0;
for (const test of tests) {
  try {
    await test();
  } catch (error) {
    failed += 1;
    console.error(`✗ ${test.name}:`, error);
  }
}

// Tear down live cycles so typing/TTL timers don't hold the process open.
for (const bridge of startedBridges) {
  await bridge.stop().catch(() => {});
}
rmSync(tmpBase, TEMP_RM_OPTIONS);

if (failed > 0) {
  console.error(`\n${failed}/${tests.length} validation(s) FAILED`);
  process.exit(1);
}
console.log(`\nAll ${tests.length} validations passed.`);
