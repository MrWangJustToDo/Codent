/**
 * Auto mode must CLOSE the client's approval dialog.
 *
 * Core answers every pending approval when auto mode turns on, and resumes the run. The request that
 * asked the client (`session/request_permission`) is still open at that moment, and leaving it open is
 * not cosmetic: the client shows a dialog for a tool that already ran, and its late answer re-decides
 * an approval (`deny` after the fact would rewrite a completed call).
 *
 * So the interaction handler reconciles: an approval that is no longer in the session's pending snapshot
 * is cancelled. This is the host half; the core half (the approval actually being answered) is
 * `validate:auto-mode-approvals`.
 *
 * Run: node scripts/validate-acp-auto-approval.mjs
 */

import { client as createClient, methods } from "@agentclientprotocol/sdk";

import { createAcpAgent } from "../dist/index.mjs";

import { createChecker, finish } from "./acp-report.mjs";
import { baseSnapshot } from "./session-fixture.mjs";

const checker = createChecker();
const check = checker.check;

const APPROVAL_ID = "ap1";
const TOOL_CALL_ID = "tc1";
const APPROVED_COMMAND = "npm run build --filter @codent/app";

const approvalMessages = [
  {
    id: "m-approval",
    role: "assistant",
    parts: [
      {
        id: TOOL_CALL_ID,
        type: "tool-call",
        name: "run_command",
        input: { command: APPROVED_COMMAND },
        state: "input-complete",
      },
    ],
  },
];

/** A session whose `mode.set auto` behaves like core: it answers the pending approval. */
function makeSession(id) {
  const listeners = new Set();
  let snapshot = baseSnapshot(id, { messages: approvalMessages });
  const dispatched = [];

  const emit = (event) => {
    for (const listener of listeners) listener({ ...event, ts: Date.now() });
  };

  return {
    id,
    dispatched,
    getSnapshot: () => snapshot,
    getSummaryStreamSnapshot: () => null,
    subscribe: (handler) => {
      listeners.add(handler);
      return () => listeners.delete(handler);
    },
    dispatch: async (command) => {
      dispatched.push(command);
      if (command.type === "mode.set" && command.mode === "auto") {
        // What core now does on the same dispatch: the approval is answered and the interaction
        // snapshot no longer lists it (the pump resumes; the run continues).
        snapshot = baseSnapshot(id, { status: "running", messages: approvalMessages });
        emit({ channel: "interaction", payload: { approvals: [], askUser: [] }, ts: Date.now() });
        emit({ channel: "state", payload: snapshot, ts: Date.now() });
      }
      return { ok: true };
    },
    /** A run suspends on an approval — the snapshot the host turns into a client prompt. */
    suspend() {
      snapshot = baseSnapshot(id, { status: "waiting", messages: approvalMessages });
      emit({
        channel: "interaction",
        payload: {
          approvals: [{ approvalId: APPROVAL_ID, toolName: "run_command", toolCallId: TOOL_CALL_ID }],
          askUser: [],
        },
      });
      emit({ channel: "state", payload: snapshot });
    },
  };
}

async function waitFor(predicate, timeoutMs = 2000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return predicate();
}

const session = makeSession("s-auto-approval");
let permissionAsked = 0;
let permissionCancelled = false;

const client = createClient({ name: "auto-approval-client" }).onRequest(
  methods.client.session.requestPermission,
  async (ctx) => {
    permissionAsked += 1;
    // Hold the dialog open until the host cancels it, exactly like a user who never answers.
    await new Promise((resolve) => {
      if (ctx.signal.aborted) {
        permissionCancelled = true;
        resolve();
        return;
      }
      ctx.signal.addEventListener(
        "abort",
        () => {
          permissionCancelled = true;
          resolve();
        },
        { once: true }
      );
    });
    return { outcome: { outcome: "cancelled" } };
  }
);

const app = createAcpAgent({
  host: {
    async create() {
      return { session };
    },
    connect: () => null,
    list: () => [],
    async destroy() {},
  },
  defaults: { model: "fake-model" },
  rootPath: "/ws",
});

await client.connectWith(app, async (cx) => {
  await cx.request(methods.agent.initialize, { protocolVersion: 1, clientCapabilities: {} });
  const started = await cx.request(methods.agent.session.new, { cwd: "/ws", mcpServers: [] });

  session.suspend();
  const asked = await waitFor(() => permissionAsked === 1);
  check("a pending approval is asked to the client", asked && permissionAsked === 1);
  check("the dialog stays open while nothing resolves it", permissionCancelled === false);

  await cx.request(methods.agent.session.setMode, { sessionId: started.sessionId, modeId: "auto" });

  check(
    "the mode change reaches the session",
    session.dispatched.some((c) => c.type === "mode.set" && c.mode === "auto")
  );
  const cancelled = await waitFor(() => permissionCancelled);
  check("switching to auto cancels the client's outstanding approval request", cancelled);
  check(
    "the host does not answer the approval on the client's behalf",
    session.dispatched.every((c) => c.type !== "respondApproval")
  );
});

finish(checker.failures);
