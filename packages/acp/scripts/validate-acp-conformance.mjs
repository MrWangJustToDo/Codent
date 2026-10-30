/* eslint-disable max-lines -- Justified: this is the one regression suite for the conformance change.
 * Its cases share the same in-process session/client doubles; splitting them would either duplicate
 * that harness or turn one readable sequence of per-defect checks into several files that drift. */

/**
 * ACP v1 conformance regressions for the harden-acp-v1-conformance change.
 *
 * These cover the paths the older validators could not see because they reused a live bridge:
 * cancellation/timeout settlement, cold resume, load replay of tool results, the stable handle,
 * `always` policy, per-session `cwd`, failed-run visibility, extension command refresh, and the
 * catalog/list edge cases.
 *
 * Run: `pnpm --filter @codent/acp run validate:acp`
 */

import { client as createClient, methods } from "@agentclientprotocol/sdk";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { TEMP_RM_OPTIONS } from "../../core/scripts/helpers/temp-cleanup.mjs";
import {
  DEFAULT_INTERACTION_TIMEOUT_MS,
  AcpProjector,
  approvalPolicyKey,
  bootstrapLocalAcp,
  commandsFromSnapshot,
  createAcpAgent,
  mapPermissionOutcome,
  paginateSessions,
  promptBlocksToContent,
  toolDiffsFor,
  toolKindFor,
  toolStatusFor,
} from "../dist/index.mjs";

import { createChecker, finish } from "./acp-report.mjs";
import { TOOL_CALL, makeHost, makeSession, runClient } from "./acp-session-double.mjs";
import { baseSnapshot } from "./session-fixture.mjs";

const checker = createChecker();
const check = checker.check;

const tick = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));

// ===========================================================================
// A. Pure units
// ===========================================================================

check(
  "permission: allow-always is an approval with the always marker",
  JSON.stringify(mapPermissionOutcome({ outcome: { outcome: "selected", optionId: "allow-always" } })) ===
    JSON.stringify({ approved: true, always: true })
);
check(
  "permission: reject-always is a rejection with the always marker",
  JSON.stringify(mapPermissionOutcome({ outcome: { outcome: "selected", optionId: "reject-always" } })) ===
    JSON.stringify({ approved: false, always: true })
);
check(
  "permission: a client cancel maps to null (the caller must still deny)",
  mapPermissionOutcome({ outcome: { outcome: "cancelled" } }) === null
);
check("interaction timeout defaults to five minutes", DEFAULT_INTERACTION_TIMEOUT_MS === 5 * 60 * 1000);

check("tool status: input-streaming is pending, not executing", toolStatusFor("input-streaming", false) === "pending");
check("tool status: input-complete is pending", toolStatusFor("input-complete", false) === "pending");
check("tool status: approval-responded is in progress", toolStatusFor("approval-responded", false) === "in_progress");
check(
  "tool status: a cancel is a terminal non-success, never completed",
  toolStatusFor("complete", true, true) === "failed"
);

// Tool kind comes from the SESSION's descriptor, not the built-in table by name. An extension's
// editing tool is an `edit`; a tool that shadows a built-in name but declares nothing must not
// inherit the built-in's kind.
check(
  "tool kind follows the session descriptor (extension edit)",
  toolKindFor("ext_write", {
    resolvePresentation: (name) => (name === "ext_write" ? { category: "edits" } : undefined),
  }) === "edit"
);
check(
  "tool kind: an undeclared shadowing name is not the built-in kind",
  toolKindFor("read_file", { resolvePresentation: () => undefined }) === "other"
);
check(
  "built-in-only kind overrides do not apply to a shadowing tool",
  toolKindFor("delete_file", { resolvePresentation: () => ({ category: "edits" }), isBuiltin: () => false }) ===
    "edit" && toolKindFor("delete_file", { isBuiltin: () => true }) === "delete"
);

{
  // `commands` is the per-name live registration; flattening `extensions[].commands` used to
  // advertise a shadowed name twice, one of which could never run. A built-in collision is
  // filtered because dispatch resolves built-ins first.
  // TWO extensions claim `memory`, and one claims `mode` (a built-in). Only the live registration
  // is advertisable, and only when a built-in does not win the name.
  const cmds = commandsFromSnapshot({
    extensions: {
      extensions: [
        { commands: [{ name: "memory", description: "shadowed claim", hasOptions: false }] },
        { commands: [{ name: "memory", description: "mem", hasOptions: false }] },
        { commands: [{ name: "mode", description: "shadowed builtin", hasOptions: false }] },
      ],
      commands: [
        { name: "memory", description: "mem", hasOptions: false },
        { name: "mode", description: "shadowed builtin", hasOptions: false },
      ],
    },
  });
  check(
    "only the live extension command is advertised",
    cmds.extension.filter((c) => c.name === "memory").length === 1 &&
      cmds.extension.find((c) => c.name === "memory")?.description === "mem"
  );
  check("an extension command shadowed by a builtin is not advertised", !cmds.extension.some((c) => c.name === "mode"));
  check(
    "commands include builtin + extension",
    cmds.builtin.some((c) => c.name === "mode") && cmds.extension.some((c) => c.name === "memory")
  );
  check("UI-only commands are not advertised", !cmds.builtin.some((c) => c.name === "quit"));
}

{
  const diffs = toolDiffsFor(
    "edit_file",
    {
      path: "src/a.ts",
      edits: [
        { oldString: "one", newString: "two" },
        { oldString: "three", newString: "four" },
      ],
    },
    "/ws"
  );
  check(
    "edit_file emits one diff per replacement",
    diffs.length === 2 && diffs[0].oldText === "one" && diffs[1].oldText === "three"
  );
}
{
  const diff = toolDiffsFor("write_file", { path: "src/a.ts", content: "new" }, "/ws", "old")[0];
  check("write_file overwrite carries the real oldText", diff?.oldText === "old" && diff?.newText === "new");
}

{
  const mapped = promptBlocksToContent(
    [
      { type: "text", text: "before" },
      { type: "image", mimeType: "image/png", data: "AAAA" },
      { type: "text", text: "after" },
    ],
    { image: true, audio: true, embeddedContext: true }
  );
  check(
    "prompt parts keep the client's order across text/image/text",
    Array.isArray(mapped.content) &&
      mapped.content[0]?.type === "text" &&
      mapped.content[1]?.type === "image" &&
      mapped.content[2]?.type === "text"
  );
}

{
  const messages = [
    {
      parts: [{ type: "tool-call", id: "t1", toolCallId: "t1", name: "run_command", input: { command: "git status" } }],
    },
  ];
  check(
    "always policy key for run_command is the leading program",
    approvalPolicyKey({ toolName: "run_command", toolCallId: "t1" }, messages) === "run_command:git"
  );
  const other = [
    {
      parts: [{ type: "tool-call", id: "t2", toolCallId: "t2", name: "run_command", input: { command: "rm -rf /" } }],
    },
  ];
  check(
    "always policy does not approve a different program",
    approvalPolicyKey({ toolName: "run_command", toolCallId: "t2" }, other) === "run_command:rm"
  );
}

{
  const page = paginateSessions(
    [
      { id: "bad", name: "bad", version: 7, modelStyle: "openai", model: "m", createdAt: 0, updatedAt: Number.NaN },
      { id: "ok", name: "ok", version: 7, modelStyle: "openai", model: "m", createdAt: 0, updatedAt: 1 },
    ],
    "/ws"
  );
  check(
    "session/list skips a row with an invalid updatedAt",
    page.sessions.length === 1 && page.sessions[0].sessionId === "ok"
  );
}

// ===========================================================================
// B. In-process session doubles
// ===========================================================================
//
// The doubles (session / host / real SDK client) live in `acp-session-double.mjs` so the text-mode
// `ask_user` check drives the same fakes — a second copy is how a fake drifts from production and a
// validator starts passing for the wrong reason.

// --- cancelled permission settles ------------------------------------------
{
  let permissionCalls = 0;
  const host = makeHost(() => {
    const built = makeSession({
      id: "cancel-approval",
      onCommand: async (command, api) => {
        if (command.type === "send") {
          api.setSnapshot({ status: "waiting", messages: [{ id: "m1", role: "assistant", parts: [TOOL_CALL()] }] });
          api.emit("messages", api.snapshot.messages);
          api.emit("interaction", {
            approvals: [{ approvalId: "ap1", toolName: "run_command", toolCallId: "tc1" }],
            askUser: [],
          });
          api.emit("state", api.snapshot);
        }
        if (command.type === "respondApproval") {
          api.setSnapshot({ status: "completed", messages: api.snapshot.messages });
          api.emit("state", api.snapshot);
        }
        return { ok: true };
      },
    });
    return { ...built, session: built.session };
  });
  const app = createAcpAgent({ host, defaults: { model: "fake-model" }, rootPath: "/ws" });
  const { value } = await runClient(
    app,
    async (cx) => {
      const s = await cx.request(methods.agent.session.new, { cwd: "/ws", mcpServers: [] });
      const prompt = await cx.request(methods.agent.session.prompt, {
        sessionId: s.sessionId,
        prompt: [{ type: "text", text: "go" }],
      });
      return { s, prompt };
    },
    {
      [methods.client.session.requestPermission]: async () => {
        permissionCalls += 1;
        return { outcome: { outcome: "cancelled" } };
      },
    }
  );
  const dispatched = host.created[0].api.dispatched;
  check("a client-cancelled permission asks the client once", permissionCalls === 1);
  check(
    "a client-cancelled permission settles as a denial",
    dispatched.some((c) => c.type === "respondApproval" && c.approvalId === "ap1" && c.approved === false)
  );
  check("a client-cancelled permission resolves the turn (no park)", value.prompt.stopReason === "end_turn");
}

// --- session/cancel settles a pending approval ------------------------------
{
  let permissionCalls = 0;
  const host = makeHost(() =>
    makeSession({
      id: "cancel-turn",
      onCommand: async (command, api) => {
        if (command.type === "send") {
          api.setSnapshot({ status: "waiting", messages: [{ id: "m1", role: "assistant", parts: [TOOL_CALL()] }] });
          api.emit("messages", api.snapshot.messages);
          api.emit("interaction", {
            approvals: [{ approvalId: "ap1", toolName: "run_command", toolCallId: "tc1" }],
            askUser: [],
          });
          api.emit("state", api.snapshot);
          return; // hang
        }
        if (command.type === "respondApproval") {
          api.setSnapshot({ status: "aborted", messages: api.snapshot.messages });
          api.emit("state", api.snapshot);
        }
        if (command.type === "stop") {
          api.setSnapshot({ status: "aborted", messages: api.snapshot.messages });
          api.emit("state", api.snapshot);
        }
        return { ok: true };
      },
    })
  );
  const app = createAcpAgent({ host, defaults: { model: "fake-model" }, rootPath: "/ws" });
  const { value } = await runClient(
    app,
    async (cx) => {
      const s = await cx.request(methods.agent.session.new, { cwd: "/ws", mcpServers: [] });
      const prompt = cx.request(methods.agent.session.prompt, {
        sessionId: s.sessionId,
        prompt: [{ type: "text", text: "go" }],
      });
      await tick(20);
      await cx.notify(methods.agent.session.cancel, { sessionId: s.sessionId });
      return { prompt: await prompt };
    },
    {
      [methods.client.session.requestPermission]: async () => {
        permissionCalls += 1;
        return new Promise(() => undefined); // never answers
      },
    }
  );
  check("session/cancel asks the client for the permission once", permissionCalls === 1);
  check("session/cancel resolves the prompt as cancelled", value.prompt.stopReason === "cancelled");
}

// --- timeout settlement -----------------------------------------------------
{
  let permissionCalls = 0;
  const host = makeHost(() =>
    makeSession({
      id: "timeout",
      onCommand: async (command, api) => {
        if (command.type === "send") {
          api.setSnapshot({ status: "waiting", messages: [{ id: "m1", role: "assistant", parts: [TOOL_CALL()] }] });
          api.emit("messages", api.snapshot.messages);
          api.emit("interaction", {
            approvals: [{ approvalId: "ap1", toolName: "run_command", toolCallId: "tc1" }],
            askUser: [],
          });
          api.emit("state", api.snapshot);
        }
        if (command.type === "respondApproval") {
          api.setSnapshot({ status: "completed", messages: api.snapshot.messages });
          api.emit("state", api.snapshot);
        }
        return { ok: true };
      },
    })
  );
  const app = createAcpAgent({
    host,
    defaults: { model: "fake-model" },
    rootPath: "/ws",
    interactionTimeoutMs: 30,
  });
  const { updates, value } = await runClient(
    app,
    async (cx) => {
      const s = await cx.request(methods.agent.session.new, { cwd: "/ws", mcpServers: [] });
      return await cx.request(methods.agent.session.prompt, {
        sessionId: s.sessionId,
        prompt: [{ type: "text", text: "go" }],
      });
    },
    {
      [methods.client.session.requestPermission]: async () => {
        permissionCalls += 1;
        return new Promise(() => undefined);
      },
    }
  );
  check("an unanswered permission times out and resolves the turn", value.stopReason === "end_turn");
  check("the timeout still asked the client once", permissionCalls === 1);
  check(
    "the timeout is explained by a warning notice",
    updates.some(
      (u) =>
        u.update.sessionUpdate === "notice" &&
        u.update.severity === "warning" &&
        /timed out/i.test(u.update.title ?? "")
    )
  );
}

// --- cold resume does not replay -------------------------------------------
{
  const oldMessages = [
    { id: "u1", role: "user", parts: [{ type: "text", content: "old question" }] },
    { id: "a1", role: "assistant", parts: [{ type: "text", content: "old answer" }] },
  ];
  const host = makeHost((options) => {
    const id = options.resumeSessionId ? "resumed" : "fresh";
    return makeSession({
      id,
      diskId: options.resumeSessionId ?? "ses_resumed",
      messages: oldMessages,
      onCommand: async () => ({ ok: true }),
    });
  });
  const app = createAcpAgent({ host, defaults: { model: "fake-model" }, rootPath: "/ws" });
  const { updates } = await runClient(app, async (cx) => {
    await cx.request(methods.agent.session.resume, {
      sessionId: "ses_resumed",
      cwd: "/ws",
      mcpServers: [],
    });
    await tick(20);
  });
  const texts = updates
    .map((u) => u.update)
    .filter((u) => u.sessionUpdate === "agent_message_chunk" || u.sessionUpdate === "user_message_chunk")
    .map((u) => u.content?.text ?? "");
  check(
    "a cold session/resume does not replay the transcript",
    !texts.some((t) => t.includes("old answer") || t.includes("old question"))
  );
  check(
    "a cold session/resume still seeds plan/commands",
    updates.some((u) => u.update.sessionUpdate === "plan") &&
      updates.some((u) => u.update.sessionUpdate === "available_commands_update")
  );
}

// --- load replays tool results ---------------------------------------------
{
  const messages = [
    {
      id: "a1",
      role: "assistant",
      parts: [
        { type: "tool-call", id: "tc1", name: "read_file", input: { path: "a.ts" }, state: "complete" },
        { type: "tool-result", toolCallId: "tc1", content: "file contents", state: "complete" },
      ],
    },
  ];
  const host = makeHost((options) =>
    makeSession({
      id: "load",
      diskId: options.resumeSessionId ?? "ses_load",
      messages,
      onCommand: async () => ({ ok: true }),
    })
  );
  const app = createAcpAgent({ host, defaults: { model: "fake-model" }, rootPath: "/ws" });
  const { updates } = await runClient(app, async (cx) => {
    await cx.request(methods.agent.session.load, { sessionId: "ses_load", cwd: "/ws", mcpServers: [] });
    await tick(20);
  });
  const all = updates.map((u) => u.update);
  const call = all.find((u) => u.sessionUpdate === "tool_call" && u.toolCallId === "tc1");
  const result = all.find(
    (u) => u.sessionUpdate === "tool_call_update" && u.toolCallId === "tc1" && u.status === "completed"
  );
  const resultText = JSON.stringify(result?.content ?? []);
  check("load replays the tool call", Boolean(call));
  check("load replays the tool RESULT (not only the call)", Boolean(result) && resultText.includes("file contents"));
}

// --- max_tokens / max_turn_requests ----------------------------------------
for (const [label, finishReason, iteration, expected] of [
  ["max_tokens", "length", { current: 1, max: 100 }, "max_tokens"],
  ["max_turn_requests", "tool_calls", { current: 100, max: 100 }, "max_turn_requests"],
  ["natural completion at the ceiling", "stop", { current: 100, max: 100 }, "end_turn"],
]) {
  const host = makeHost(() =>
    makeSession({
      id: `stop-${label}`,
      onCommand: async (command, api) => {
        if (command.type === "send") {
          // The REAL post-finalize shape: `iteration` is cleared, and the turn's reading survives on
          // `lastIteration`. The old fixture hand-built `completed + iteration 100/100` — a shape
          // core never produces — which is how the dead `max_turn_requests` branch stayed green.
          api.setSnapshot({
            status: "completed",
            iteration: { current: 0, max: iteration.max },
            lastIteration: iteration,
            lastFinishReason: finishReason,
          });
          api.emit("state", api.snapshot);
        }
        return { ok: true };
      },
    })
  );
  const app = createAcpAgent({ host, defaults: { model: "fake-model" }, rootPath: "/ws" });
  const { value } = await runClient(app, async (cx) => {
    const s = await cx.request(methods.agent.session.new, { cwd: "/ws", mcpServers: [] });
    return await cx.request(methods.agent.session.prompt, {
      sessionId: s.sessionId,
      prompt: [{ type: "text", text: "go" }],
    });
  });
  check(`stop reason: ${label}`, value.stopReason === expected);
}

// --- failed run visibility ------------------------------------------------
{
  const host = makeHost(() =>
    makeSession({
      id: "failed",
      onCommand: async (command, api) => {
        if (command.type === "send") {
          api.setSnapshot({ status: "error", error: "provider exploded" });
          api.emit("state", api.snapshot);
        }
        return { ok: true };
      },
    })
  );
  const app = createAcpAgent({ host, defaults: { model: "fake-model" }, rootPath: "/ws" });
  const { updates } = await runClient(app, async (cx) => {
    const s = await cx.request(methods.agent.session.new, { cwd: "/ws", mcpServers: [] });
    await cx.request(methods.agent.session.prompt, {
      sessionId: s.sessionId,
      prompt: [{ type: "text", text: "go" }],
    });
    await tick(20);
  });
  const notice = updates.map((u) => u.update).find((u) => u.sessionUpdate === "notice" && u.severity === "error");
  check(
    "a failed run is visible before the stop reason",
    Boolean(notice) && String(notice.title).includes("provider exploded")
  );
}

// --- stable handle + rebinding --------------------------------------------
{
  let currentDisk = "ses_before";
  const host = makeHost(() =>
    makeSession({
      id: "rebind",
      diskId: currentDisk,
      onCommand: async (command, api) => {
        if (command.type === "session.new") {
          currentDisk = "ses_after";
          api.setSnapshot({ activeSessionId: currentDisk, messages: [] });
          api.emit("state", api.snapshot);
        }
        return { ok: true };
      },
    })
  );
  const app = createAcpAgent({ host, defaults: { model: "fake-model" }, rootPath: "/ws" });
  const { updates, value } = await runClient(app, async (cx) => {
    const s = await cx.request(methods.agent.session.new, { cwd: "/ws", mcpServers: [] });
    await cx.request(methods.agent.session.prompt, {
      sessionId: s.sessionId,
      prompt: [{ type: "text", text: "/new" }],
    });
    await tick(20);
    // The disk id from a rebind must be loadable, and the response must name the stable handle.
    const load = await cx.request(methods.agent.session.load, {
      sessionId: "ses_after",
      cwd: "/ws",
      mcpServers: [],
    });
    // The handle still addresses the session; the disk id moved.
    const snap = await cx.request(methods.agent.session.prompt, {
      sessionId: s.sessionId,
      prompt: [{ type: "text", text: "/mode status" }],
    });
    return { id: s.sessionId, snap, load };
  });
  const info = updates
    .map((u) => u.update)
    .find((u) => u.sessionUpdate === "session_info_update" && u._meta?.diskSessionId === "ses_after");
  check("the ACP handle stays stable after /new", value.id === "ses_before");
  check("session_info_update exposes the new disk session id", Boolean(info));
  check("load by the new disk id reports the stable handle", value.load?._meta?.sessionId === "ses_before");
  check("a prompt on the stable handle still works", typeof value.snap.stopReason === "string");
}

// --- always policy ---------------------------------------------------------
{
  let permissionCalls = 0;
  const approvals = [];
  const host = makeHost(() =>
    makeSession({
      id: "always",
      onCommand: async (command, api) => {
        if (command.type === "send") {
          api.setSnapshot({ status: "waiting", messages: [{ id: "m1", role: "assistant", parts: [TOOL_CALL()] }] });
          api.emit("messages", api.snapshot.messages);
          api.emit("interaction", {
            approvals: [{ approvalId: "ap1", toolName: "run_command", toolCallId: "tc1" }],
            askUser: [],
          });
          api.emit("state", api.snapshot);
        }
        if (command.type === "respondApproval") {
          approvals.push(command);
          if (approvals.length === 1) {
            api.emit("interaction", {
              approvals: [{ approvalId: "ap2", toolName: "run_command", toolCallId: "tc1" }],
              askUser: [],
            });
          } else {
            api.setSnapshot({ status: "completed", messages: api.snapshot.messages });
            api.emit("state", api.snapshot);
          }
        }
        return { ok: true };
      },
    })
  );
  const app = createAcpAgent({ host, defaults: { model: "fake-model" }, rootPath: "/ws" });
  await runClient(
    app,
    async (cx) => {
      const s = await cx.request(methods.agent.session.new, { cwd: "/ws", mcpServers: [] });
      await cx.request(methods.agent.session.prompt, {
        sessionId: s.sessionId,
        prompt: [{ type: "text", text: "go" }],
      });
    },
    {
      [methods.client.session.requestPermission]: async () => {
        permissionCalls += 1;
        return { outcome: { outcome: "selected", optionId: "allow-always" } };
      },
    }
  );
  check("allow-always asks the client once for the same tool", permissionCalls === 1);
  check(
    "allow-always auto-approves the next matching approval",
    approvals.every((a) => a.approved === true)
  );
}

// --- elicitation decline settles as cancelled ------------------------------
{
  let result = null;
  const host = makeHost(() =>
    makeSession({
      id: "ask",
      onCommand: async (command, api) => {
        if (command.type === "send") {
          const ask = {
            type: "tool-call",
            id: "ask1",
            name: "ask_user",
            input: { question: "Continue?", options: ["yes", "no"] },
            state: "input-complete",
          };
          api.setSnapshot({ status: "awaiting_user", messages: [{ id: "m1", role: "assistant", parts: [ask] }] });
          api.emit("messages", api.snapshot.messages);
          api.emit("interaction", {
            approvals: [],
            askUser: [{ toolCallId: "ask1", question: "Continue?", options: ["yes", "no"] }],
          });
          api.emit("state", api.snapshot);
        }
        if (command.type === "addToolResult") {
          result = command;
          api.setSnapshot({ status: "completed", messages: api.snapshot.messages });
          api.emit("state", api.snapshot);
        }
        return { ok: true };
      },
    })
  );
  const app = createAcpAgent({ host, defaults: { model: "fake-model" }, rootPath: "/ws" });
  await runClient(
    app,
    async (cx) => {
      const s = await cx.request(methods.agent.session.new, { cwd: "/ws", mcpServers: [] });
      await cx.request(methods.agent.session.prompt, {
        sessionId: s.sessionId,
        prompt: [{ type: "text", text: "go" }],
      });
    },
    {
      [methods.client.elicitation.create]: async () => ({ action: "decline" }),
    }
  );
  check(
    "an elicitation decline settles the tool as cancelled (not an empty answer)",
    result?.output?.cancelled === true
  );
}

// --- per-session cwd -------------------------------------------------------
{
  const roots = [];
  const host = makeHost(() => makeSession({ id: "root", onCommand: async () => ({ ok: true }) }));
  const app = createAcpAgent({
    host,
    defaults: { model: "fake-model" },
    rootPath: "/ws",
    createSessionHost: async (context) => {
      roots.push(context.rootPath);
      return { host: host, dispose: async () => undefined };
    },
  });
  const { updates } = await runClient(app, async (cx) => {
    await cx.request(methods.agent.session.new, { cwd: "/ws2", mcpServers: [] });
    await tick(20);
  });
  check("session/new builds the session runtime at its cwd", roots.includes("/ws2"));
  void updates;
}

{
  const app = createAcpAgent({
    host: makeHost(() => makeSession({ id: "relative", onCommand: async () => ({ ok: true }) })),
    defaults: { model: "fake-model" },
    rootPath: "/ws",
  });
  let refused = false;
  await runClient(app, async (cx) => {
    try {
      await cx.request(methods.agent.session.new, { cwd: "relative/path", mcpServers: [] });
    } catch {
      refused = true;
    }
  });
  check("a relative cwd is refused, not silently re-based", refused);
}

// --- session/list cwd ------------------------------------------------------
{
  const app = createAcpAgent({
    host: makeHost(() => makeSession({ id: "list", onCommand: async () => ({ ok: true }) })),
    defaults: { model: "fake-model" },
    rootPath: "/ws",
    listPersistedSessionsAt: async (root) => [
      {
        id: "ses_other",
        name: "other",
        version: 7,
        modelStyle: "openai",
        model: "m",
        createdAt: 0,
        updatedAt: 1,
        root,
      },
    ],
  });
  const { value } = await runClient(app, async (cx) => {
    return await cx.request(methods.agent.session.list, { cwd: "/other/" });
  });
  check("session/list honours cwd instead of pretending to filter", value.sessions[0]?.cwd === "/other");
  let relativeRejected = false;
  await runClient(app, async (cx) => {
    try {
      await cx.request(methods.agent.session.list, { cwd: "relative" });
    } catch {
      relativeRejected = true;
    }
  });
  check("session/list refuses a relative cwd", relativeRejected);
}

// --- empty session/list ---------------------------------------------------
{
  const app = createAcpAgent({
    host: makeHost(() => makeSession({ id: "empty-list", onCommand: async () => ({ ok: true }) })),
    defaults: { model: "fake-model" },
    rootPath: "/ws",
    listPersistedSessionsAt: async () => [],
  });
  const { value } = await runClient(app, async (cx) => {
    return await cx.request(methods.agent.session.list, { cwd: "/empty" });
  });
  check(
    "session/list on an empty workspace returns an empty page, not an error",
    Array.isArray(value.sessions) && value.sessions.length === 0
  );
}

// --- live MCP reconciliation ----------------------------------------------
{
  const host = makeHost(() => makeSession({ id: "mcp", onCommand: async () => ({ ok: true }) }));
  const app = createAcpAgent({ host, defaults: { model: "fake-model" }, rootPath: "/ws" });
  const { value } = await runClient(app, async (cx) => {
    const s = await cx.request(methods.agent.session.new, {
      cwd: "/ws",
      mcpServers: [{ name: "a", command: "/bin/true", args: [], env: [] }],
    });
    try {
      await cx.request(methods.agent.session.resume, {
        sessionId: s.sessionId,
        cwd: "/ws",
        mcpServers: [{ name: "b", command: "/bin/false", args: [], env: [] }],
      });
      return { rejected: false };
    } catch {
      return { rejected: true };
    }
  });
  check("a live load/resume with a different MCP list is refused", value.rejected);
}

// --- extension command refresh --------------------------------------------
{
  const listeners = new Set();
  const emitted = [];
  const session = {
    getSnapshot: () => baseSnapshot("ext", { messages: [] }),
    subscribe: (handler) => {
      listeners.add(handler);
      return () => listeners.delete(handler);
    },
  };
  const projector = new AcpProjector(session, {
    rootPath: "/ws",
    emit: (update) => emitted.push(update),
    commands: () => ({ builtin: [], extension: [{ name: "hello", description: "Say hello" }] }),
    client: { compaction: true, notices: true },
  });
  projector.start();
  for (const listener of listeners) {
    listener({
      channel: "extensions",
      payload: { extensions: [{ id: "e", commands: [{ name: "hello", description: "Say hello" }] }] },
      ts: Date.now(),
    });
  }
  check(
    "an extension-set change re-advertises available_commands_update",
    emitted.some(
      (u) => u.sessionUpdate === "available_commands_update" && u.availableCommands?.some((c) => c.name === "hello")
    )
  );
  projector.stop();
}

// --- denied tool status ---------------------------------------------------
{
  const listeners = new Set();
  const emitted = [];
  const session = {
    getSnapshot: () => baseSnapshot("denied", { messages: [] }),
    subscribe: (handler) => {
      listeners.add(handler);
      return () => listeners.delete(handler);
    },
  };
  const projector = new AcpProjector(session, {
    rootPath: "/ws",
    emit: (update) => emitted.push(update),
    commands: () => ({ builtin: [], extension: [] }),
    client: { compaction: true, notices: true },
  });
  projector.start();
  const denied = TOOL_CALL({ approval: { needsApproval: true, approved: false } });
  // The real denial path appends a synthetic result part with `state: "complete"` and no
  // `success: false`; that must NOT upgrade the row to completed.
  const denialResult = {
    type: "tool-result",
    toolCallId: "tc1",
    content: "User denied this tool call.",
    state: "complete",
  };
  for (const listener of listeners) {
    listener({
      channel: "messages",
      payload: [{ id: "m1", role: "assistant", parts: [denied, denialResult] }],
      ts: Date.now(),
    });
  }
  const last = [...emitted].reverse().find((u) => u.sessionUpdate === "tool_call_update" && u.toolCallId === "tc1");
  check(
    "a denied tool call is reported as failed",
    emitted.some((u) => u.sessionUpdate === "tool_call" && u.toolCallId === "tc1" && u.status === "failed") &&
      last?.status === "failed"
  );
  projector.stop();
}

// --- write_file oldText while args stream ---------------------------------
{
  const listeners = new Set();
  const emitted = [];
  const session = {
    getSnapshot: () => baseSnapshot("write-diff", { messages: [] }),
    subscribe: (handler) => {
      listeners.add(handler);
      return () => listeners.delete(handler);
    },
  };
  const projector = new AcpProjector(session, {
    rootPath: "/ws",
    emit: (update) => emitted.push(update),
    commands: () => ({ builtin: [], extension: [] }),
    client: { compaction: true, notices: true },
    readFile: async (path) => (path === "/ws/src/a.ts" ? "old content" : null),
  });
  projector.start();
  const push = (parts) => {
    for (const listener of listeners) {
      listener({ channel: "messages", payload: [{ id: "m1", role: "assistant", parts }], ts: Date.now() });
    }
  };
  push([
    {
      type: "tool-call",
      id: "w1",
      name: "write_file",
      arguments: '{"path":',
      state: "input-streaming",
    },
  ]);
  push([
    {
      type: "tool-call",
      id: "w1",
      name: "write_file",
      input: { path: "src/a.ts", content: "new content" },
      state: "input-complete",
    },
  ]);
  await tick(20);
  const diff = emitted
    .filter((u) => u.toolCallId === "w1" && Array.isArray(u.content))
    .flatMap((u) => u.content)
    .find((c) => c.type === "diff" && c.oldText === "old content");
  check("write_file reads the real oldText once the path is known", Boolean(diff));
  projector.stop();
}

// --- re-selecting the current model preserves modelInfo -------------------
{
  const host = makeHost(() =>
    makeSession({
      id: "modelinfo",
      model: "m1",
      modelInfo: { capabilities: ["reasoning"], contextWindow: 200000 },
      onCommand: async (command, api) => {
        if (command.type === "model.set") {
          api.setSnapshot({ model: command.model, modelInfo: command.modelInfo ?? null, messages: [] });
        }
        return { ok: true };
      },
    })
  );
  const app = createAcpAgent({
    host,
    defaults: { model: "m1" },
    rootPath: "/ws",
    models: { entries: [{ style: "openai", baseURL: "https://example/v1", models: ["m1", "m2"] }] },
  });
  await runClient(app, async (cx) => {
    const s = await cx.request(methods.agent.session.new, { cwd: "/ws", mcpServers: [] });
    const current = s.configOptions?.find((o) => o.category === "model")?.currentValue;
    await cx.request(methods.agent.session.setConfigOption, {
      sessionId: s.sessionId,
      configId: "model",
      value: current,
    });
  });
  const built = host.created[0];
  check(
    "re-selecting the current model does not dispatch model.set",
    !built.api.dispatched.some((command) => command.type === "model.set")
  );
  check(
    "re-selecting the current model keeps modelInfo/capabilities",
    built.api.snapshot.modelInfo?.contextWindow === 200000 &&
      built.api.snapshot.modelInfo?.capabilities?.includes("reasoning")
  );
}

// --- seed after the response ----------------------------------------------
{
  let sawResponse = false;
  let seedBeforeResponse = false;
  const updates = [];
  const clientApp = createClient({ name: "seed-client" }).onNotification(methods.client.session.update, (ctx) => {
    if (!sawResponse && ctx.params.update.sessionUpdate === "available_commands_update") {
      seedBeforeResponse = true;
    }
    updates.push(ctx.params.update);
  });
  const host = makeHost(() => makeSession({ id: "seed", retained: true, onCommand: async () => ({ ok: true }) }));
  const app = createAcpAgent({ host, defaults: { model: "fake-model" }, rootPath: "/ws" });
  await clientApp.connectWith(app, async (cx) => {
    await cx.request(methods.agent.initialize, { protocolVersion: 1, clientCapabilities: {} });
    await cx.request(methods.agent.session.new, { cwd: "/ws", mcpServers: [] });
    sawResponse = true;
    await tick(20);
  });
  check("session/new seeds commands after the response frame", seedBeforeResponse === false);
  check(
    "…and the seed does arrive",
    updates.some((u) => u.sessionUpdate === "available_commands_update")
  );
  check(
    "retained state plus the seed does not duplicate plan/usage",
    updates.filter((u) => u.sessionUpdate === "plan").length <= 1 &&
      updates.filter((u) => u.sessionUpdate === "usage_update").length <= 1
  );
}

// --- delete a stale listed id does not close the live session -------------
{
  let currentDisk = "ses_old";
  const deleted = [];
  const host = makeHost(() =>
    makeSession({
      id: "stale-delete",
      diskId: currentDisk,
      onCommand: async (command, api) => {
        if (command.type === "session.new") {
          currentDisk = "ses_new";
          api.setSnapshot({ activeSessionId: currentDisk, messages: [] });
          api.emit("state", api.snapshot);
        }
        return { ok: true };
      },
    })
  );
  host.deleteSession = async (id) => {
    deleted.push(id);
    return true;
  };
  const app = createAcpAgent({ host, defaults: { model: "fake-model" }, rootPath: "/ws" });
  const { value } = await runClient(app, async (cx) => {
    const s = await cx.request(methods.agent.session.new, { cwd: "/ws", mcpServers: [] });
    await cx.request(methods.agent.session.prompt, {
      sessionId: s.sessionId,
      prompt: [{ type: "text", text: "/new" }],
    });
    await cx.request(methods.agent.session.delete, { sessionId: s.sessionId });
    // The live handle must still address the NEW conversation.
    const prompt = await cx.request(methods.agent.session.prompt, {
      sessionId: s.sessionId,
      prompt: [{ type: "text", text: "/mode status" }],
    });
    return prompt;
  });
  check("deleting a stale listed id deletes THAT disk id", deleted.includes("ses_old") && !deleted.includes("ses_new"));
  check("deleting a stale id does not close the live handle", typeof value.stopReason === "string");
}

// --- fork rebinds the client-env session id -------------------------------
{
  let boundId;
  const host = makeHost(() =>
    makeSession({
      id: "fork-env",
      onCommand: async (command, api) => {
        if (command.type === "session.clone") {
          api.setSnapshot({ activeSessionId: "ses_forked", messages: [] });
          return { ok: true, data: { sessionId: "ses_forked" } };
        }
        return { ok: true };
      },
    })
  );
  const app = createAcpAgent({
    host,
    defaults: { model: "fake-model" },
    rootPath: "/ws",
    createSessionHost: async (context) => {
      boundId = context.sessionId;
      return { host, dispose: async () => undefined };
    },
  });
  const { value } = await runClient(app, async (cx) => {
    const s = await cx.request(methods.agent.session.new, { cwd: "/ws", mcpServers: [] });
    const before = boundId?.();
    const forked = await cx.request(methods.agent.session.fork, {
      sessionId: s.sessionId,
      cwd: "/ws",
      mcpServers: [],
    });
    return { before, after: boundId?.(), forked };
  });
  check("client-env binding starts at the new session's disk id", value.before?.startsWith("ses_"));
  check("fork rebinds the client-env session id to the new disk id", value.after === value.forked.sessionId);
}

// --- legacy set_model re-advertises configOptions -------------------------
{
  const host = makeHost(() =>
    makeSession({
      id: "legacy-model",
      model: "m1",
      onCommand: async (command, api) => {
        if (command.type === "model.set") api.setSnapshot({ model: command.model, messages: [] });
        return { ok: true };
      },
    })
  );
  const app = createAcpAgent({
    host,
    defaults: { model: "m1" },
    rootPath: "/ws",
    models: { entries: [{ style: "openai", baseURL: "https://example/v1", models: ["m1", "m2"] }] },
  });
  const { updates, value } = await runClient(app, async (cx) => {
    const s = await cx.request(methods.agent.session.new, { cwd: "/ws", mcpServers: [] });
    const response = await cx.request("session/set_model", { sessionId: s.sessionId, modelId: "0:m2" });
    // A reopened thread must carry the same legacy state, not `{}` (the picker then showed the old model).
    const loaded = await cx.request(methods.agent.session.load, {
      sessionId: s.sessionId,
      cwd: "/ws",
      mcpServers: [],
    });
    // Re-selecting the model the load response just advertised must stay silent: load/resume seed
    // the "last advertised" mirrors, so the first set does not produce a redundant update.
    await cx.request(methods.agent.session.setConfigOption, {
      sessionId: s.sessionId,
      configId: "model",
      value: "0:m2",
    });
    // A COLD load has no live mirrors; re-selecting the model it just advertised must still be
    // silent. Without seeding, `advertised()` sees `undefined` and broadcasts a redundant update.
    const cold = await cx.request(methods.agent.session.load, {
      sessionId: "ses_cold",
      cwd: "/ws",
      mcpServers: [],
    });
    await cx.request(methods.agent.session.setConfigOption, {
      sessionId: cold._meta?.sessionId ?? "ses_cold",
      configId: "model",
      value: "0:m1",
    });
    await tick(20);
    return { response, loaded, cold };
  });
  const update = updates
    .map((u) => u.update)
    .find(
      (u) =>
        u.sessionUpdate === "config_option_update" &&
        u.configOptions?.some((o) => o.category === "model" && o.currentValue === "0:m2")
    );
  check(
    "legacy session/set_model returns the updated legacy `models` state",
    value?.response?.models?.currentModelId === "0:m2",
    JSON.stringify(value?.response?.models)
  );
  check(
    "…and the complete updated configOptions",
    value?.response?.configOptions?.some((option) => option.category === "model" && option.currentValue === "0:m2")
  );
  check(
    "session/load carries the legacy `models` state for a picker that reads it",
    value?.loaded?.models?.currentModelId === "0:m2",
    JSON.stringify(value?.loaded?.models)
  );
  check(
    "re-selecting the loaded model stays silent (load seeded the mirrors)",
    updates.filter((u) => u.update.sessionUpdate === "config_option_update").length === 1,
    String(updates.filter((u) => u.update.sessionUpdate === "config_option_update").length)
  );
  check(
    "…including after a COLD load (the first advertisement of that process)",
    value?.cold?.models?.currentModelId === "0:m1" &&
      updates.filter((u) => u.update.sessionUpdate === "config_option_update").length === 1,
    JSON.stringify(value?.cold?.models)
  );
  check("legacy session/set_model re-advertises configOptions", Boolean(update));
}

// --- compaction states ----------------------------------------------------
{
  const listeners = new Set();
  const emitted = [];
  const session = {
    getSnapshot: () => baseSnapshot("compact", { messages: [] }),
    subscribe: (handler) => {
      listeners.add(handler);
      return () => listeners.delete(handler);
    },
  };
  const projector = new AcpProjector(session, {
    rootPath: "/ws",
    emit: (update) => emitted.push(update),
    commands: () => ({ builtin: [], extension: [] }),
    client: { compaction: true, notices: true },
  });
  projector.start();
  const push = (channel, payload) => {
    for (const listener of listeners) listener({ channel, payload, ts: Date.now() });
  };
  push("state", { ...baseSnapshot("compact"), status: "compacting" });
  push("lifecycle", { type: "compaction:auto-complete", payload: {} });
  // Cache-cleanup failures are a direct `warn` row now, not `compaction:auto-error`; there is no
  // lifecycle event left to misclassify as a compaction outcome.
  push("state", { ...baseSnapshot("compact"), status: "compacting" });
  push("state", { ...baseSnapshot("compact"), status: "error" });
  check(
    "a manual compaction that leaves compacting in error is failed",
    emitted.some((u) => u.sessionUpdate === "compaction_update" && u.status === "failed")
  );

  // The real manual path restores the PREVIOUS status on failure (often `idle`), so the command
  // result — not the state transition — must decide the row.
  projector.beginManualCompaction();
  push("state", { ...baseSnapshot("compact"), status: "compacting" });
  push("state", { ...baseSnapshot("compact"), status: "idle" });
  projector.finishManualCompaction("failed", "manual compaction failed");
  check(
    "a failed manual compaction is failed even when the status restores to idle",
    emitted.some(
      (u) => u.sessionUpdate === "compaction_update" && u.status === "failed" && u.error === "manual compaction failed"
    )
  );
  projector.stop();

  // The summary stream closes in `finally`, so an auto error can arrive AFTER its `end`. It must
  // patch the same row, not create a second compaction id.
  const lateListeners = new Set();
  const late = [];
  const lateProjector = new AcpProjector(
    {
      getSnapshot: () => baseSnapshot("late-compact", { messages: [] }),
      subscribe: (handler) => {
        lateListeners.add(handler);
        return () => lateListeners.delete(handler);
      },
    },
    {
      rootPath: "/ws",
      emit: (update) => late.push(update),
      commands: () => ({ builtin: [], extension: [] }),
      client: { compaction: true, notices: true },
    }
  );
  lateProjector.start();
  const pushLate = (channel, payload) => {
    for (const listener of lateListeners) listener({ channel, payload, ts: Date.now() });
  };
  pushLate("state", { ...baseSnapshot("late-compact"), status: "compacting" });
  pushLate("summary", { type: "reset", source: "compact", key: "compact:late", epoch: "c-late" });
  pushLate("summary", { type: "append", key: "compact:late", chunk: "summary" });
  pushLate("summary", { type: "end", key: "compact:late" });
  pushLate("lifecycle", { type: "compaction:auto-error", payload: { error: "late failure" } });
  const lateUpdates = late.filter((u) => u.sessionUpdate === "compaction_update");
  check(
    "a late auto-compaction error patches the same row",
    lateUpdates.at(-1)?.status === "failed" && new Set(lateUpdates.map((u) => u.compactionId)).size === 1
  );
  lateProjector.stop();
}

// --- real bootstrap rejects an inaccessible cwd ---------------------------
{
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "acp-conformance-root-"));
  const previous = {
    MODEL: process.env.MODEL,
    MODEL_STYLE: process.env.MODEL_STYLE,
    BASE_URL: process.env.BASE_URL,
    API_KEY: process.env.API_KEY,
  };
  process.env.MODEL = "test-model";
  process.env.MODEL_STYLE = "openai";
  process.env.BASE_URL = "https://example/v1";
  process.env.API_KEY = "test-key";
  try {
    const boot = await bootstrapLocalAcp({ cwd: root, clientEnv: false });
    let rejected = false;
    try {
      await boot.createSessionHost({
        rootPath: path.join(root, "missing", "workspace"),
        sessionId: () => undefined,
        clientCapabilities: undefined,
        client: () => {
          throw new Error("not connected");
        },
      });
    } catch (error) {
      rejected = error?.code === -32602;
    }
    check("the real bootstrap rejects an inaccessible cwd as invalidParams", rejected);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await fs.rm(root, TEMP_RM_OPTIONS);
  }
}

finish(checker.failures);
