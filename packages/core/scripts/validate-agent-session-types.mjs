/**
 * Validates AgentSession command/channel discriminants round-trip JSON.
 *
 * Run: pnpm --filter @codent/core run validate:agent-session-types
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { AGENT_EVENT_META, AGENT_SESSION_CHANNELS, DEFAULT_AGENT_SESSION_CHANNELS } from "../dist/dev.mjs";

assert.ok(AGENT_SESSION_CHANNELS.includes("state"));
assert.ok(AGENT_SESSION_CHANNELS.includes("tool"));
assert.ok(AGENT_SESSION_CHANNELS.includes("summary"));
assert.ok(!AGENT_SESSION_CHANNELS.includes("log"), "log channel removed (persistence-only agent log)");
assert.ok(DEFAULT_AGENT_SESSION_CHANNELS.includes("lifecycle"));
assert.ok(DEFAULT_AGENT_SESSION_CHANNELS.includes("tool"));
assert.ok(DEFAULT_AGENT_SESSION_CHANNELS.includes("summary"));

const commands = [
  { type: "send", content: "hi" },
  { type: "steer", content: "fix" },
  { type: "followUp", content: "later" },
  { type: "stop" },
  { type: "clear" },
  { type: "respondApproval", approvalId: "a1", approved: true, reason: "ok" },
  { type: "addToolResult", toolCallId: "t1", output: { done: true } },
  { type: "setClientToolWaiting", active: true },
  { type: "compact" },
  { type: "rename", name: "x" },
  { type: "auto.set", enabled: true },
  { type: "plan.enable" },
  { type: "plan.disable" },
  { type: "plan.toggle" },
  { type: "plan.execute", sendSteer: true },
  { type: "plan.cancel" },
  { type: "session.resume", sessionId: "s1" },
];

for (const command of commands) {
  const round = JSON.parse(JSON.stringify(command));
  assert.deepEqual(round, command);
}

const event = {
  channel: "usage",
  payload: {
    total: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
    window: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
    percent: 10,
    tokenLimit: 100,
    cost: 0,
  },
  ts: 1,
};
assert.deepEqual(JSON.parse(JSON.stringify(event)), event);

// The lifecycle channel is now derived from AGENT_EVENT_META (replacing the
// former DEFAULT_SESSION_LIFECYCLE_EVENTS include-list).
const lifecycleEvents = Object.entries(AGENT_EVENT_META)
  .filter(([, meta]) => meta.channel === "lifecycle")
  .map(([type]) => type);
assert.ok(lifecycleEvents.includes("agent:stop"));
assert.ok(!lifecycleEvents.includes("plan:enter"));
assert.ok(!lifecycleEvents.includes("subagent:ui-update"));

// ── The projector's own coverage ──────────────────────────────────────────────
//
// `projectChannelEvent` maps a channel to a payload by hand. A channel with no `case` falls into
// `default: return null`, so the event is dropped on the floor — and nothing caught that, because:
//
//  * `AGENT_EVENT_META.channel` is a plain string, so `"plan"` where `"mcp"` belongs type-checks
//    (it is assignable to `AgentSessionChannel`) and the payload is `as`-cast, so a mismatched
//    payload type-checks too;
//  * the per-event validators (validate-command-jobs-channel, …) assert against the META table and
//    read the DEFAULT channel set — never the projector.
//
// `session:jobs` shipped in exactly that state: declared in AGENT_EVENT_META, listed in
// AGENT_SESSION_CHANNELS, in the default set, with a `retain()` — and no projector case, so the one
// consumer (`RemoteSessionClient`'s `case "jobs"`) could never run. These two assertions are the
// guard that was missing.
{
  const sessionSource = readFileSync(
    resolve(dirname(fileURLToPath(import.meta.url)), "../src/agent-session/local-agent-session.ts"),
    "utf8"
  );
  const projector = sessionSource.slice(
    sessionSource.indexOf("function projectChannelEvent"),
    sessionSource.indexOf("class LocalAgentSessionImpl")
  );
  assert.ok(projector.length > 0, "projectChannelEvent must still exist for this guard to mean anything");

  const projected = new Set([...projector.matchAll(/case "([a-z-]+)":/g)].map((m) => m[1]));

  // (1) Every declared channel has a case — an uncovered one is silently dropped.
  const uncovered = AGENT_SESSION_CHANNELS.filter((channel) => !projected.has(channel));
  assert.deepEqual(
    uncovered,
    [],
    `channel(s) declared but absent from projectChannelEvent (events would be dropped): ${uncovered.join(", ")}`
  );

  // (2) The projector has no case for a channel that is not declared.
  const undeclared = [...projected].filter((channel) => !AGENT_SESSION_CHANNELS.includes(channel));
  assert.deepEqual(undeclared, [], `projector case(s) for undeclared channel(s): ${undeclared.join(", ")}`);

  // (3) Every routed event's channel is a real channel — the check the free-typed `channel` field
  //     and the per-case `as` both let through.
  for (const [type, meta] of Object.entries(AGENT_EVENT_META)) {
    if (!meta.channel) continue;
    assert.ok(AGENT_SESSION_CHANNELS.includes(meta.channel), `${type} routes to unknown channel ${meta.channel}`);
  }
}

console.log("agent-session-types validation passed");
