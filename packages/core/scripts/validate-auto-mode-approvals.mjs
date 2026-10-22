/**
 * Auto mode must ANSWER the approvals the run is parked on.
 *
 * A pending approval is a question the run is suspended on. Switching to auto mode answers it by
 * definition, but the answer used to be recorded by the TUI's `/mode` command — a host-side
 * workaround, because the app layer happened to have the pending parts in hand. Every protocol host
 * (ACP, remote session) dispatches the same `mode.set` and therefore left the run suspended on a
 * prompt the user had already dismissed by choosing auto. `mode.toggle` (Shift+Tab) had the same gap
 * even in the TUI.
 *
 * The rule now lives in the ONE mode-change path both routes share (`mode.set` / `mode.toggle` in
 * the local session dispatch): the policy (`shouldAutoApprovePendingTools`) decides, the chat
 * controller records the decisions and resumes the pump.
 *
 * Run: pnpm --filter @codent/core run validate:auto-mode-approvals
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { clearCoreEnv, createLocalAgentSession, registerCoreEnv } from "../dist/dev.mjs";
import { AgentManager } from "../dist/index.mjs";

import { TEMP_RM_OPTIONS } from "./helpers/temp-cleanup.mjs";

// ============================================================================
// Fixture
// ============================================================================

const rootPath = await fs.promises.mkdtemp(path.join(os.tmpdir(), "auto-mode-approvals-"));
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

/** One assistant turn holding a tool call that is waiting for an approval. */
const pendingMessages = () => [
  {
    id: "m-approval",
    role: "assistant",
    parts: [
      {
        id: "tc1",
        type: "tool-call",
        name: "run_command",
        arguments: JSON.stringify({ command: "npm run build" }),
        state: "approval-requested",
        approval: { id: "ap1", needsApproval: true },
      },
    ],
  },
];

const manager = new AgentManager();
const managed = await manager.createManagedAgent({ name: "auto-approvals", model: "test-model" });
const chat = managed.initChat(manager);
// Keep the pump out of the assertion. This gate is about the DECISIONS (and the single resume), and a
// live pump would try to reach a model this validator deliberately does not configure.
chat.enqueueRunOnce = async () => {};

const session = createLocalAgentSession({ managed, manager });
const approvalOf = () => chat.getMessages()[0].parts[0].approval;
const tableRow = () =>
  managed
    .getApprovals()
    .toArray()
    .find((row) => row.toolCallId === "tc1");

// ============================================================================
// 1. Entering auto answers the pending approval
// ============================================================================

chat.setMessages(pendingMessages());
managed.statusController.reconcileWithPolicy(chat.getMessages(), "during-run");
assert.equal(managed.getPendingApprovalCount(), 1, "fixture: one approval is pending");

const enteredAuto = await session.dispatch({ type: "mode.set", mode: "auto" });
assert.equal(enteredAuto.ok, true);
assert.equal(session.getSnapshot().mode, "auto", "the mode switch still reports auto");
assert.equal(approvalOf().approved, true, "auto mode approves the pending tool call");
assert.equal(tableRow()?.status, "approved", "the approval table records the decision");
assert.equal(managed.getPendingApprovalCount(), 0, "no approval is left pending");
assert.equal(
  chat.getMessages()[0].parts[0].approval?.approved,
  true,
  "the channel (the SoT persisted to disk) carries the decision"
);

// ============================================================================
// 2. Leaving auto does NOT answer them
// ============================================================================

chat.setMessages(pendingMessages());
managed.statusController.reconcileWithPolicy(chat.getMessages(), "during-run");
await session.dispatch({ type: "mode.set", mode: "normal" });
assert.equal(approvalOf().approved, undefined, "normal mode leaves the approval to the user");
assert.equal(managed.getPendingApprovalCount(), 1, "…and it is still counted as pending");

// ============================================================================
// 3. mode.toggle (Shift+Tab) answers them too
// ============================================================================

const toggled = await session.dispatch({ type: "mode.toggle" });
assert.equal(toggled.ok, true);
assert.equal(session.getSnapshot().mode, "auto", "toggle from normal enters auto");
assert.equal(approvalOf().approved, true, "toggle answers the pending approval like an explicit switch");

// ============================================================================
// 4. A plan switch that disables auto leaves approvals alone
// ============================================================================

chat.setMessages(pendingMessages());
managed.statusController.reconcileWithPolicy(chat.getMessages(), "during-run");
await session.dispatch({ type: "mode.set", mode: "plan" });
assert.equal(approvalOf().approved, undefined, "plan mode does not auto-approve");
assert.equal(session.getSnapshot().mode, "plan");

// ============================================================================
// Cleanup
// ============================================================================

clearCoreEnv();
manager.destroyAgent(managed.id);
await fs.promises.rm(rootPath, TEMP_RM_OPTIONS);

console.log("auto-mode approval validation passed");
