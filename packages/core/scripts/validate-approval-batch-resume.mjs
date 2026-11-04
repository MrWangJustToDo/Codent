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
import { fileURLToPath } from "node:url";

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
// 3a. An ERROR turn settles the same held call
//
// Reuses the real agent from section 3 with a stream that fails before producing a tool phase.
// The request is one the engine parked beside the gated call and never ran; leaving it
// `input-complete` meant the NEXT user turn executed the failed turn's arguments.
// ============================================================================
{
  // A fresh agent: section 3 left the shared one parked on a pending approval, and a parked turn
  // defers the next `sendMessage` instead of starting the failing stream this case needs.
  const errorManaged = await manager.createManagedAgent({ name: "approval-error", model: "capturing-model" });
  errorManaged.setTextAdapter({
    adapter: {
      kind: "text",
      name: "erroring",
      model: "capturing-model",
      "~types": {},
      chatStream() {
        return (async function* () {
          yield { type: "RUN_ERROR", message: "boom" };
        })();
      },
      async structuredOutput() {
        throw new Error("not implemented");
      },
    },
    model: "capturing-model",
    modelStyle: "openai",
  });
  const errorChat = errorManaged.initChat(manager);

  const errorStuckId = "call_read_file_error";
  errorChat.setMessages([
    { id: "e-u1", role: "user", parts: [{ type: "text", content: "read it" }] },
    {
      id: "e-a1",
      role: "assistant",
      parts: [
        { type: "tool-call", id: errorStuckId, name: "read_file", state: "input-complete", input: { path: "a.ts" } },
      ],
    },
  ]);

  await errorChat.sendMessage("continue").catch(() => undefined);
  await errorChat.runChain;

  const errorPart = errorChat
    .getMessages()
    .flatMap((message) => message.parts)
    .find((part) => part.type === "tool-call" && part.id === errorStuckId);
  assert.equal(errorPart?.state, "error", "the held call is settled on an error terminal too");
  assert.equal(errorPart?.output?.cancelled, true, "…as a cancel, not a fabricated result");
  assert.equal(errorManaged.getStatus(), "error", "the turn is still reported as failed");
}

// ============================================================================
// 3b. The settle is a TERMINAL rule, not a `finished` rule
//
// An error/aborted turn has no later phase that could produce the held result either. Leaving it
// `input-complete` meant the NEXT user turn continued that tool phase with the failed turn's
// arguments — a write that nobody approved in this turn.
// ============================================================================
{
  const controllerSrc = fs.readFileSync(
    fileURLToPath(new URL("../src/managers/controllers/agent-chat-controller.ts", import.meta.url)),
    "utf8"
  );
  assert.match(
    controllerSrc,
    /if \(outcomeKind !== "waiting" && !waitingForUser\) \{\s*this\.applyCancelledIncompleteTools\(true\)/,
    "every non-waiting terminal (error/aborted too) settles the calls the engine could not run"
  );
  assert.match(
    controllerSrc,
    /const stillWaiting = hasPendingInteraction\([\s\S]{0,120}if \(!stillWaiting\) this\.applyCancelledIncompleteTools\(true\)/,
    "the pump's catch path settles them too, but preserves a pending ask_user"
  );
  // A preserved question must also be named in the status on the abort path (interruptCurrentRun
  // finalizes directly and never reaches `applyRunOutcome`).
  assert.match(
    controllerSrc,
    /finalizeChat\(\{[\s\S]{0,1400}?parkOnPendingQuestion\(this\.channel\.getMessages\(\)\)/,
    "the Esc path parks on a still-pending ask_user instead of reporting aborted"
  );
}

// ============================================================================
// 3c. A FAILED turn that still owes an `ask_user` is parked on the USER
//
// `ask_user` is a client tool: the server run cannot answer it, and the terminal paths deliberately
// do not cancel it (that would lose the question and the input). The status therefore has to name
// the wait. Left as `error`, the input queue admitted `sendMessage`, the next pump broke on the
// pending interaction, and `deriveChatOutcome` re-derived `error` from the status it never left —
// every later message was appended and never sent, with no visible change.
// ============================================================================
{
  const askedManaged = await manager.createManagedAgent({ name: "error-awaiting-ask", model: "capturing-model" });
  askedManaged.setTextAdapter({
    adapter: {
      kind: "text",
      name: "erroring-ask",
      model: "capturing-model",
      "~types": {},
      chatStream() {
        return (async function* () {
          yield { type: "RUN_ERROR", message: "boom while asking" };
        })();
      },
      async structuredOutput() {
        throw new Error("not implemented");
      },
    },
    model: "capturing-model",
    modelStyle: "openai",
  });
  const askedChat = askedManaged.initChat(manager);
  askedChat.setMessages([
    { id: "q-u1", role: "user", parts: [{ type: "text", content: "ask me first" }] },
    {
      id: "q-a1",
      role: "assistant",
      parts: [
        {
          type: "tool-call",
          id: "call_ask_error",
          name: "ask_user",
          state: "input-complete",
          // A REAL part carries `arguments` as a JSON string; `input` alone reads as a truncated
          // arg stream and gets cancelled as incomplete (which is what a broken stream must do).
          arguments: JSON.stringify({ question: "which one?", options: [{ label: "a" }, { label: "b" }] }),
        },
      ],
    },
  ]);

  await askedChat.sendMessage("go").catch(() => undefined);
  await askedChat.runChain;

  const askPart = askedChat
    .getMessages()
    .flatMap((message) => message.parts)
    .find((part) => part.type === "tool-call" && part.id === "call_ask_error");
  assert.equal(askPart?.output, undefined, "the question is still answerable");
  assert.equal(askedManaged.getStatus(), "awaiting_user", "a failed turn that owes an answer awaits the user");
  assert.equal(
    await askedChat.sendMessage("another message"),
    "queued",
    "input queues behind the question instead of opening a turn that breaks immediately"
  );

  // Esc on a parked question must not ANSWER it: the abort path has its own settle pass, and a
  // plain `settleToolCalls(..., { includeInFlight: true })` would cancel the pending `ask_user`
  // (it looks in-flight), making the park below a no-op and discarding the question.
  askedChat.stop();
  const afterStopPart = askedChat
    .getMessages()
    .flatMap((message) => message.parts)
    .find((part) => part.type === "tool-call" && part.id === "call_ask_error");
  assert.equal(afterStopPart?.output, undefined, "Esc keeps the question answerable");
  assert.equal(askedManaged.getStatus(), "awaiting_user", "…and the status still names the user wait");
}

// ============================================================================
// 3d. A stale aborted controller does not turn a SETUP failure into a cancel
//
// `currentAbortController` survives a finished run (it is cleared on session reset, not at run
// end), so after an Esc the previous controller is still current and aborted. The pump flips the
// status to `running` before the stream, so if the adapter is built first and rejects (missing
// style/key), `isAbortedNow()` saw the OLD signal: the turn finalized as `finished`, the error text
// vanished and post-run memory extraction ran. `prepareForRun` (which mints THIS run's controller)
// therefore runs before the adapter is built.
// ============================================================================
{
  // A create with no modelStyle / adapter: resolving one rejects, which is the setup failure.
  const staleManaged = await manager.createManagedAgent({ name: "stale-abort", model: "no-style-model" });
  const staleChat = staleManaged.initChat(manager);

  // What an Esc on a previous run leaves behind: a controller that is still current and aborted.
  staleManaged.run.setupAbortController(undefined, { onAborted: () => undefined });
  staleManaged.run.abort("user-cancelled");
  assert.equal(staleManaged.run.currentAbortController?.signal.aborted, true, "the stale controller is aborted");

  staleChat.setMessages([{ id: "s-u1", role: "user", parts: [{ type: "text", content: "hello" }] }]);
  // The rejection surfaces from the run span, which the pump handles; it must not reject the call.
  await staleChat.sendMessage("hello").catch(() => undefined);
  await staleChat.runChain;

  assert.equal(
    staleManaged.getStatus(),
    "error",
    "the setup failure is a failed turn, not a cancel of the previous run"
  );
  assert.match(staleManaged.getError() ?? "", /modelStyle|adapter/i, "the failure reason is kept");
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
