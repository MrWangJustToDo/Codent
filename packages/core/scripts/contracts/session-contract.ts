/**
 * Compile-time contract fixture for the public AgentSession API.
 *
 * `validate-agent-session-types.mjs` also asserts JSON round-trips, but JSON cannot
 * prove a command discriminant still exists, nor that snapshot field types are exported
 * from the public entry. This file is included by `tsconfig.typecheck.json` (and the
 * validator runs that project), so a removed command or leaked/unexported snapshot type
 * fails typecheck instead of passing a runtime-only check.
 */

import type {
  AgentSessionCommand,
  AgentSessionCommandResultFor,
  AgentSessionSnapshot,
  McpServerStatus,
  SessionJobSummary,
  SessionJobsSnapshot,
} from "../../src/index.js";

const commands: AgentSessionCommand[] = [
  { type: "send", content: "hi" },
  { type: "queue.pop" },
  { type: "mode.set", mode: "normal" },
  { type: "mode.toggle" },
  { type: "plan.execute" },
  { type: "plan.cancel" },
  { type: "plan.save" },
  { type: "plan.load", name: "p" },
  { type: "plan.list" },
  { type: "plan.complete" },
  { type: "mcp.refresh" },
  { type: "extension.toggle", id: "e", enabled: true },
  { type: "session.resume", sessionId: "ses_x" },
  { type: "session.new" },
  { type: "session.clone" },
  { type: "session.fork", upToMessageId: "m1" },
  { type: "effort.set", effort: "high" },
  { type: "model.set", model: "m" },
  { type: "usage.history" },
];
void commands;

const job: SessionJobSummary = {
  jobId: "j1",
  command: "echo",
  status: "exited",
  exitCode: 0,
  startedAt: 1,
  endedAt: 2,
  pendingPickup: false,
};
const jobs: SessionJobsSnapshot = { jobs: [job] };
void jobs;

const mcp: McpServerStatus = { name: "m", transport: "stdio", toolCount: 0, status: "connected" };
void mcp;

const sessionList: AgentSessionCommandResultFor<"session.list"> = {
  ok: true,
  data: { sessions: [{ id: "ses_x", name: "Session", model: "m", updatedAt: 2, createdAt: 1 }] },
};
void sessionList;
const badSessionList: AgentSessionCommandResultFor<"session.list"> = {
  ok: true,
  // @ts-expect-error a session row must carry the full disk-catalog shape
  data: { sessions: [{ id: "ses_x", name: "Session" }] },
};
void badSessionList;

type SnapshotJobs = AgentSessionSnapshot["jobs"];
const snapshotJobs: SnapshotJobs = jobs;
void snapshotJobs;

// These were removed from AgentSessionCommand; keep them as negative compile assertions.
// @ts-expect-error clear no longer exists
const obsoleteClear: AgentSessionCommand = { type: "clear" };
// @ts-expect-error auto.set no longer exists
const obsoleteAuto: AgentSessionCommand = { type: "auto.set", enabled: true };
// @ts-expect-error plan.enable no longer exists
const obsoletePlanEnable: AgentSessionCommand = { type: "plan.enable" };
// @ts-expect-error plan.disable no longer exists
const obsoletePlanDisable: AgentSessionCommand = { type: "plan.disable" };
// @ts-expect-error plan.toggle no longer exists
const obsoletePlanToggle: AgentSessionCommand = { type: "plan.toggle" };
void obsoleteClear;
void obsoleteAuto;
void obsoletePlanEnable;
void obsoletePlanDisable;
void obsoletePlanToggle;
