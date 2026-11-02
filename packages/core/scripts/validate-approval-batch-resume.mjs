/**
 * A batch that mixes an approval-gated tool with a plain one — what the contract IS, and what it is not.
 *
 * TanStack parks the whole batch on the gated call and puts every plain call into its `held` list
 * (`executeToolCalls`); a held call produces no result — no output, no error. The two halves of the
 * contract are therefore:
 *
 * 1. **Pending rows never become resolutions.** `approvalsToResumeMap` omits them, so the engine keeps
 *    interrupting; `approval-resume` patches only ANSWERED rows. Auto mode / plan execution answer
 *    through `ApprovalDecisionCoordinator` (channel + table) before the pump resumes — a decision is
 *    never invented inside `onConfig`, where it would exist only as an engine-side map.
 * 2. **A settled turn settles what it could not run.** `AgentChatController.pumpToolPhases` turns any
 *    `input-complete` call left behind into a cancelled result with a paired tool-result, so the row
 *    stops loading and the model can retry instead of receiving an unanswered call forever.
 *
 * Section 4 pins the dependency behaviour that makes this the *chosen* contract: with the gate still
 * pending the engine runs NOTHING; once the gate is answered it runs the whole batch in one pass. So
 * "run them" is what answering the approval already achieves — there is no second pre-approval seam.
 *
 * Run: pnpm --filter @codent/core run validate:approval-batch-resume
 */

import { chat } from "@tanstack/ai";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  approvalsToResumeMap,
  clearCoreEnv,
  createApprovalResumeMiddleware,
  createReadFileTool,
  createRunCommandTool,
  registerCoreEnv,
  TOOL_CANCELLED_MESSAGE,
} from "../dist/dev.mjs";
import { AgentManager } from "../dist/index.mjs";

import { TEMP_RM_OPTIONS } from "./helpers/temp-cleanup.mjs";

// ============================================================================
// 1. The resume map: a pending row is not a resolution
// ============================================================================

const rows = [
  { id: "approval_a", toolCallId: "call_A", status: "pending", updatedAt: 1 },
  { id: "approval_b", toolCallId: "call_B", status: "approved", updatedAt: 2 },
  { id: "approval_c", toolCallId: "call_C", status: "denied", reason: "nope", updatedAt: 3 },
];

{
  const map = approvalsToResumeMap(rows);
  assert.equal(map.has("call_A"), false, "a pending row must still interrupt");
  assert.equal(map.has("approval_a"), false, "…under its approval id either");
  assert.equal(map.get("call_B"), true, "an approved row resolves to true");
  assert.deepEqual(map.get("call_C"), { approved: false, payload: { reason: "nope" } }, "a denial keeps its reason");
}

// ============================================================================
// 2. The middleware patches answered rows only
// ============================================================================

{
  const middleware = createApprovalResumeMiddleware({ getApprovals: () => rows });
  const patch = await middleware.onConfig({}, { messages: [] });
  assert.equal(patch.resumeToolState.approvals.has("call_A"), false, "the pending gate is never pre-approved");
  assert.equal(patch.resumeToolState.approvals.get("call_B"), true, "answered rows are still rebuilt");

  const empty = createApprovalResumeMiddleware({ getApprovals: () => [] });
  assert.equal(await empty.onConfig({}, { messages: [] }), undefined, "an empty table patches nothing");

  const allPending = createApprovalResumeMiddleware({
    getApprovals: () => [{ id: "approval_only", toolCallId: "call_only", status: "pending", updatedAt: 1 }],
  });
  assert.equal(
    await allPending.onConfig({}, { messages: [] }),
    undefined,
    "a table with nothing but pending rows patches nothing at all"
  );
}

// ============================================================================
// 3. Integration: a settled turn settles the calls it left behind
// ============================================================================

const rootPath = await fs.promises.mkdtemp(path.join(os.tmpdir(), "approval-batch-resume-"));
const toAbs = (p) => (path.isAbsolute(p) ? p : path.join(rootPath, p));

registerCoreEnv({
  rootPath,
  getPlatform: async () => "linux",
  getArch: async () => "arm64",
  getEnv: async () => ({}),
  homedir: async () => rootPath,
  fs: {
    readFile: async (p, encoding) => fs.promises.readFile(toAbs(p), encoding),
    writeFile: async (p, content) => fs.promises.writeFile(toAbs(p), content),
    appendFile: async (p, content) => fs.promises.appendFile(toAbs(p), content, "utf8"),
    rename: async (from, to) => fs.promises.rename(toAbs(from), toAbs(to)),
    mkdir: async (p) => fs.promises.mkdir(toAbs(p), { recursive: true }),
    exists: async (p) =>
      fs.promises.access(toAbs(p)).then(
        () => true,
        () => false
      ),
    readdir: async (p) => {
      try {
        const entries = await fs.promises.readdir(toAbs(p), { withFileTypes: true });
        return entries.map((entry) => ({ name: entry.name, type: entry.isDirectory() ? "directory" : "file" }));
      } catch {
        return [];
      }
    },
    stat: async (p) => {
      const stat = await fs.promises.stat(toAbs(p));
      return { isDirectory: stat.isDirectory(), isFile: stat.isFile(), size: stat.size, mtime: stat.mtime };
    },
    remove: async (p) => fs.promises.rm(toAbs(p), TEMP_RM_OPTIONS),
  },
  runCommand: async () => ({ stdout: "", stderr: "", code: 0 }),
  exec: async () => ({ stdout: "", stderr: "", code: 0 }),
  fetch: async () => new Response(),
});

const manager = new AgentManager();
const managed = await manager.createManagedAgent({ name: "approval-batch-resume", model: "capturing-model" });
managed.setTextAdapter({
  adapter: {
    kind: "text",
    name: "capturing",
    model: "capturing-model",
    "~types": {},
    chatStream() {
      return (async function* () {
        yield { type: "TEXT_MESSAGE_CONTENT", delta: "done." };
        yield { type: "RUN_FINISHED", finishReason: "stop" };
      })();
    },
    async structuredOutput() {
      throw new Error("not implemented");
    },
  },
  model: "capturing-model",
  modelStyle: "openai",
});

const agentChat = managed.initChat(manager);

// The shape the engine leaves behind when it holds a batch's plain call: args complete, no result.
const stuckId = "call_read_file_stuck";
agentChat.setMessages([
  { id: "u1", role: "user", parts: [{ type: "text", content: "read the file" }] },
  {
    id: "a1",
    role: "assistant",
    parts: [
      { type: "tool-call", id: stuckId, name: "read_file", state: "input-complete", input: { path: "a.ts" } },
      {
        type: "tool-call",
        id: "call_run_command_ok",
        name: "run_command",
        state: "complete",
        input: { command: "ls" },
        output: { command: "ls", stdout: "", stderr: "", exitCode: 0, durationMs: 1, success: true },
      },
      {
        type: "tool-result",
        toolCallId: "call_run_command_ok",
        state: "complete",
        content: JSON.stringify({ command: "ls", stdout: "", exitCode: 0 }),
      },
    ],
  },
]);

await agentChat.sendMessage("continue");
await agentChat.runChain;

const parts = agentChat.getMessages().flatMap((message) => message.parts);
const stuck = parts.find((part) => part.type === "tool-call" && part.id === stuckId);
assert.ok(stuck, "the settled transcript still carries the call row");
assert.equal(stuck.state, "error", "the skipped call is settled, not left loading");
assert.equal(stuck.output?.cancelled, true, "…as a cancel, so the row is not read as a tool failure");
assert.equal(stuck.output?.error, TOOL_CANCELLED_MESSAGE);
assert.ok(
  parts.some((part) => part.type === "tool-result" && part.toolCallId === stuckId),
  "the wire gets a paired result, so the model is not left with an unanswered tool call"
);
assert.equal(managed.getStatus(), "completed", "the turn itself finished normally");

// A still-pending approval is NOT settled by that pass — it is a legitimate resume state.
{
  const pendingId = "call_run_command_pending";
  agentChat.setMessages([
    { id: "u2", role: "user", parts: [{ type: "text", content: "delete it" }] },
    {
      id: "a2",
      role: "assistant",
      parts: [
        {
          type: "tool-call",
          id: pendingId,
          name: "run_command",
          state: "approval-requested",
          input: { command: "rm -rf build" },
          approval: { id: "approval_pending", needsApproval: true },
        },
      ],
    },
  ]);
  await agentChat.sendMessage("continue");
  await agentChat.runChain;
  const pendingPart = agentChat
    .getMessages()
    .flatMap((message) => message.parts)
    .find((part) => part.id === pendingId);
  assert.equal(pendingPart?.approval?.approved, undefined, "the question is kept for the user");
  assert.equal(pendingPart?.output, undefined, "and the settle pass leaves it alone");
}

// ============================================================================
// 4. The dependency behaviour the contract is built on
// ============================================================================
//
// Not a codent code path: this pins WHY the settle exists, so a future "fix" cannot re-introduce the
// idea that `onConfig` can make a parked batch run. With the gate pending the engine runs nothing;
// once the gate is answered (what the mode coordinator writes before resuming) it runs both — in one
// pass, no pre-approval seam needed.
{
  const ran = [];
  const tools = [
    {
      ...createReadFileTool(),
      execute: async () => {
        ran.push("read_file");
        return { path: "x", content: "ok", totalLines: 0, mode: "text" };
      },
    },
    {
      ...createRunCommandTool(),
      execute: async (args) => {
        ran.push("run_command");
        return {
          command: args.command,
          stdout: "",
          stderr: "",
          exitCode: 0,
          durationMs: 1,
          success: true,
          cachedOutputPath: null,
        };
      },
    },
  ];
  const parked = [
    { id: "u1", role: "user", content: "go" },
    {
      id: "a1",
      role: "assistant",
      content: null,
      toolCalls: [
        { id: "call_A", type: "function", function: { name: "read_file", arguments: '{"path":"a.ts"}' } },
        { id: "call_B", type: "function", function: { name: "run_command", arguments: '{"command":"ls"}' } },
      ],
    },
  ];
  const adapter = {
    kind: "text",
    name: "capturing",
    model: "capturing-model",
    "~types": {},
    chatStream() {
      return (async function* () {
        yield { type: "TEXT_MESSAGE_CONTENT", delta: "done." };
        yield { type: "RUN_FINISHED", finishReason: "stop" };
      })();
    },
    async structuredOutput() {
      throw new Error("not implemented");
    },
  };

  const drain = async (approvals) => {
    ran.length = 0;
    const stream = chat({
      adapter,
      messages: parked,
      threadId: "approval-batch",
      promptCache: "none",
      tools,
      middleware: [createApprovalResumeMiddleware({ getApprovals: () => approvals })],
      agentLoopStrategy: (() => {
        let i = 0;
        return () => ++i <= 2;
      })(),
    });
    for await (const chunk of stream) void chunk;
    return [...ran];
  };

  assert.deepEqual(
    await drain([{ id: "approval_call_B", toolCallId: "call_B", status: "pending", updatedAt: 1 }]),
    [],
    "a pending gate parks the batch: neither the gated call nor the plain one runs"
  );
  assert.deepEqual(
    await drain([{ id: "approval_call_B", toolCallId: "call_B", status: "approved", updatedAt: 1 }]),
    ["read_file", "run_command"],
    "an ANSWERED gate releases the whole batch in one pass"
  );
}

manager.destroyAgent(managed.id);
await manager.settleTeardowns();
clearCoreEnv();
await fs.promises.rm(rootPath, TEMP_RM_OPTIONS);

console.log("approval-batch-resume validation passed");
