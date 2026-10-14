/**
 * Offline validation for the im-bridge outbound tool GROUPING and inbound
 * ATTACHMENTS:
 *
 * - consecutive tool calls collapse into ONE message that is edited in place,
 *   while assistant text still splits groups (order preserved);
 * - an approval / ask_user is never merged (its buttons need their own message),
 *   terminally splits the groups around it, and is never re-absorbed after it
 *   resolves (which would duplicate its line);
 * - inbound images ride the dispatch as multimodal `ContentPart[]`, and an
 *   empty message (sticker / voice) is dropped instead of opening an empty turn.
 *
 * Run (builds first):
 *   pnpm --filter @codent/im-bridge validate:bridge
 */

import assert from "node:assert/strict";
import { rmSync } from "node:fs";

import { TEMP_RM_OPTIONS } from "../../core/scripts/helpers/temp-cleanup.mjs";

import { CHAT, approvalPart, startBridge, startedBridges, tmpBase, waitFor } from "./validate-bridge-harness.mjs";

function textMsg(role, id, text) {
  return { role, id, createdAt: new Date(), parts: [{ type: "text", content: text }] };
}

function toolPart(id, name, input, output) {
  return {
    type: "tool-call",
    id,
    name,
    arguments: JSON.stringify(input),
    state: output === undefined ? "input-complete" : "output-available",
    ...(output !== undefined ? { output } : {}),
  };
}

/** One assistant turn's parts, with the run's real user message in front. */
function run(parts, userText) {
  return [textMsg("user", "u1", userText), { role: "assistant", id: "a1", parts }];
}

const IMAGE = {
  type: "image",
  dataUrl: "data:image/png;base64,iVBORw0KGgo=",
  mediaType: "image/png",
  filename: "shot.png",
};

/** Last log index whose text satisfies the predicate (-1 when none). */
function lastIndex(log, predicate) {
  return log.reduce((acc, entry, index) => (entry.text !== undefined && predicate(entry.text) ? index : acc), -1);
}

async function testToolGroupCollapse() {
  const { adapter, host } = await startBridge();
  await adapter.emitMessage({ platform: "mock", chat: CHAT, userId: "u1", text: "work", raw: null });
  const session = [...host.sessions.values()][0];
  await waitFor(() => adapter.sent.length === 1, 2000, "placeholder");
  const placeholderId = adapter.sent[0].ref.messageId;

  // First tool completes → the group claims the ⏳ placeholder with ONE line.
  session.state.messages = run([toolPart("g1", "grep", { pattern: "x" }, { matches: [1, 2] })], "work");
  session.emit("messages", session.state.messages);
  await waitFor(
    () => adapter.log.some((entry) => entry.op === "edit" && entry.text.includes("grep")),
    2000,
    "group posted"
  );
  assert.ok(
    adapter.log.some(
      (entry) => entry.op === "edit" && entry.messageId === placeholderId && entry.text.startsWith("✅ grep")
    ),
    "the group claims the placeholder and leads with the status glyph"
  );
  assert.ok(
    !adapter.log.some((entry) => entry.text !== undefined && entry.text.includes("📎")),
    "tool lines carry no attachment emoji"
  );

  // Two more complete → the SAME message is edited, never re-sent.
  session.state.messages = run(
    [
      toolPart("g1", "grep", { pattern: "x" }, { matches: [1, 2] }),
      toolPart("g2", "read_file", { path: "a.ts" }, { success: true }),
      toolPart("g3", "run_command", { command: "pnpm build" }, { success: true }),
    ],
    "work"
  );
  session.emit("messages", session.state.messages);
  await waitFor(
    () => adapter.log.some((entry) => entry.op === "edit" && entry.text.includes("run_command")),
    2000,
    "group edit with every line"
  );
  const finalGroup = adapter.edits.filter((entry) => entry.messageId === placeholderId).at(-1);
  assert.ok(
    finalGroup.text.includes("grep") &&
      finalGroup.text.includes("read_file") &&
      finalGroup.text.includes("run_command"),
    "all three tool lines live in ONE message"
  );
  assert.equal(adapter.sent.length, 1, "no per-tool messages — only the placeholder");

  // A following assistant text is still its own message (order preserved).
  session.state.messages = run(
    [
      toolPart("g1", "grep", { pattern: "x" }, { matches: [1, 2] }),
      toolPart("g2", "read_file", { path: "a.ts" }, { success: true }),
      toolPart("g3", "run_command", { command: "pnpm build" }, { success: true }),
      { type: "text", content: "group done" },
      toolPart("g4", "list_file", { path: "." }, { success: true }),
    ],
    "work"
  );
  session.emit("messages", session.state.messages);
  await waitFor(
    () => adapter.log.some((entry) => entry.op === "send" && entry.text === "group done"),
    2000,
    "text after group"
  );
  const groupIndex = lastIndex(adapter.log, (text) => text.includes("read_file"));
  const textIndex = adapter.log.findIndex((entry) => entry.text === "group done");
  const tailIndex = lastIndex(adapter.log, (text) => text.includes("list_file"));
  assert.ok(groupIndex < textIndex, "the tool group message precedes the assistant text");
  assert.ok(tailIndex === -1 || textIndex < tailIndex, "the assistant text precedes the next group");
  console.log("✓ consecutive tool calls collapse into ONE edited message; text still splits groups");
}

async function testApprovalSplitsToolGroups() {
  const { adapter, host } = await startBridge({ IM_BRIDGE_APPROVAL_TTL_MS: "5000" });
  await adapter.emitMessage({ platform: "mock", chat: CHAT, userId: "u1", text: "work", raw: null });
  const session = [...host.sessions.values()][0];
  await waitFor(() => adapter.sent.length === 1, 2000, "placeholder");

  const t1 = toolPart("g1", "grep", { pattern: "x" }, { matches: [1] });
  const t2 = toolPart("g2", "read_file", { path: "a.ts" }, { success: true });

  session.state.messages = run([t1, t2, approvalPart()], "work");
  session.emit("messages", session.state.messages);
  await waitFor(() => adapter.log.some((entry) => entry.buttons?.length > 0), 2000, "approval row");
  const approvalEntry = adapter.log.find((entry) => entry.buttons?.length > 0);
  assert.ok(approvalEntry.text.includes("awaiting approval"), "approval row shows its pending state");
  assert.ok(!approvalEntry.text.includes("grep"), "the approval is NOT merged into the tool group");

  const groupEntry = adapter.log.find((entry) => entry.text !== undefined && entry.text.includes("grep"));
  assert.ok(groupEntry && groupEntry.text.includes("read_file"), "the preceding tools share one group message");
  assert.notEqual(groupEntry.messageId, approvalEntry.messageId, "group and approval are separate messages");
  assert.ok(
    adapter.log.indexOf(groupEntry) < adapter.log.indexOf(approvalEntry),
    "the group renders before its approval (order preserved)"
  );

  // Resolve → the row updates in place, and the tool must NOT be re-absorbed by
  // the group that follows it (no duplicated line across two messages).
  const approve = approvalEntry.buttons.find((button) => button.label === "✅ Approve");
  await adapter.emitButton({
    platform: "mock",
    chat: CHAT,
    messageId: approvalEntry.messageId,
    userId: "u1",
    data: approve.data,
    ack: async () => {},
  });
  const resolved = {
    ...approvalPart(),
    state: "tool-result",
    approval: { id: "ap1", needsApproval: true, approved: true },
    output: "ok",
  };
  session.state.messages = run(
    [t1, t2, resolved, toolPart("g3", "run_command", { command: "pnpm build" }, { success: true })],
    "work"
  );
  session.emit("messages", session.state.messages);
  await waitFor(
    () => adapter.log.some((entry) => entry.text !== undefined && entry.text.includes("pnpm build")),
    2000,
    "post-approval group"
  );
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.ok(
    !adapter.log.some(
      (entry) => entry.text !== undefined && entry.text.includes("npm test") && entry.text.includes("pnpm build")
    ),
    "the resolved approval is not re-absorbed into the following group"
  );
  console.log("✓ approval stays on its own message and terminally splits the tool groups around it");
}

async function testInboundImageAttachment() {
  const { adapter, host } = await startBridge();
  await adapter.emitMessage({
    platform: "mock",
    chat: CHAT,
    userId: "u1",
    text: "what is this?",
    attachments: [IMAGE],
    raw: null,
  });
  await waitFor(() => host.sessions.size === 1, 2000, "session creation");
  const session = [...host.sessions.values()][0];
  await waitFor(() => session.dispatched.length === 1, 2000, "dispatch");
  const content = session.dispatched[0].content;
  assert.equal(session.dispatched[0].type, "send");
  assert.ok(Array.isArray(content), "an attachment turns the content into ContentPart[]");
  assert.deepEqual(content[0], { type: "text", content: "what is this?" });
  assert.equal(content[1].type, "image");
  assert.deepEqual(content[1].source, { type: "url", value: IMAGE.dataUrl });
  assert.equal(content[1].metadata.filename, "shot.png");
  assert.equal(content[1].metadata.imageIndex, 1);

  // A caption-less photo still dispatches — as image-only content.
  const photoOnly = { chatId: "chat2", chatType: "private" };
  await adapter.emitMessage({
    platform: "mock",
    chat: photoOnly,
    userId: "u1",
    text: "",
    attachments: [IMAGE],
    raw: null,
  });
  await waitFor(() => host.sessions.size === 2, 2000, "photo-only session");
  const second = [...host.sessions.values()][1];
  await waitFor(() => second.dispatched.length === 1, 2000, "photo-only dispatch");
  const secondContent = second.dispatched[0].content;
  assert.ok(Array.isArray(secondContent) && secondContent.length === 1, "image-only content has no empty text part");
  assert.equal(secondContent[0].type, "image");

  // Text-only messages keep dispatching a plain string.
  const textOnly = { chatId: "chat3", chatType: "private" };
  await adapter.emitMessage({ platform: "mock", chat: textOnly, userId: "u1", text: "plain", raw: null });
  await waitFor(() => host.sessions.size === 3, 2000, "text-only session");
  const third = [...host.sessions.values()][2];
  await waitFor(() => third.dispatched.length === 1, 2000, "text-only dispatch");
  assert.equal(third.dispatched[0].content, "plain");
  console.log("✓ inbound images → multimodal ContentPart[]; photo-only works; text-only stays a string");
}

async function testEmptyInboundIgnored() {
  const { adapter, host } = await startBridge();
  await adapter.emitMessage({ platform: "mock", chat: CHAT, userId: "u1", text: "   ", raw: null });
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(host.sessions.size, 0, "an empty message (sticker / voice) opens no session and no empty turn");
  console.log("✓ empty inbound message is ignored");
}

const tests = [
  testToolGroupCollapse,
  testApprovalSplitsToolGroups,
  testInboundImageAttachment,
  testEmptyInboundIgnored,
];

let failed = 0;
for (const test of tests) {
  try {
    await test();
  } catch (error) {
    failed += 1;
    console.error(`✗ ${test.name}:`, error);
  }
}

for (const bridge of startedBridges) {
  await bridge.stop().catch(() => {});
}
rmSync(tmpBase, TEMP_RM_OPTIONS);

if (failed > 0) {
  console.error(`\n${failed}/${tests.length} validation(s) FAILED`);
  process.exit(1);
}
console.log(`\nAll ${tests.length} validations passed.`);
