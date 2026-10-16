/**
 * What the agent tells a client about a session's state: the modes it advertises, the id it
 * addresses the session by, and why a turn ended.
 *
 * Split out of `agent.ts` (a subject of its own, and that file is at the line ceiling).
 */

import { MODE_IDS, MODE_META } from "./session-config-options.js";

import type { SessionMode, SessionModeState, StopReason } from "@agentclientprotocol/sdk";
import type { AgentMode, AgentSession } from "@codent/core";

/**
 * The legacy `modes` field, kept alongside `configOptions` during the protocol's transition.
 *
 * The spec says agents with mode-like configuration SHOULD send both: `configOptions` for clients
 * that understand it, `modes` for those that only read the older API. The mode vocabulary itself
 * lives in `session-config-options.ts` (one home, shared with the `category: "mode"` option).
 */
export function sessionModes(current: AgentMode): SessionModeState {
  const availableModes: SessionMode[] = MODE_IDS.map((id) => ({ id, ...MODE_META[id] }));
  return { currentModeId: current, availableModes };
}

/**
 * The ACP session id for a live session: the **disk** session id (`ses_…`), never the agent id.
 *
 * `AgentSession.id` is the agent id (`agent_…`, `local-agent-session.ts`), and the two are not
 * interchangeable: `session/load` / `session/resume` address a PERSISTED conversation, and
 * `session/list` / `session/delete` hand out disk ids too. Exposing the agent id here (as this
 * did) made the id returned by `session/new` unusable for `session/load`, and made
 * `session/delete` / `session/fork`'s "find the live bridge" lookups miss every session
 * enumerated from disk.
 *
 * `host.create` mints one via `managed.ensureSessionData()` before returning, so this is always
 * present for a root session.
 */
export function diskSessionId(session: AgentSession): string {
  const active = session.getSnapshot().activeSessionId;
  if (!active) {
    // Not expected for a root session (see above). Fail loudly rather than fall back to the
    // agent id, which would silently reintroduce the two-id-spaces bug this guards against.
    throw new Error(`ACP session has no disk session id (agent ${session.id})`);
  }
  return active;
}

export function stopReasonFor(bridge: {
  session: AgentSession;
  cancelled: boolean;
  lastFinishReason: string | undefined;
}): StopReason {
  const snapshot = bridge.session.getSnapshot();
  if (bridge.cancelled || snapshot.status === "aborted") return "cancelled";
  if (snapshot.status === "error") return "end_turn";
  const { iteration } = snapshot;
  if (iteration.max > 0 && iteration.current >= iteration.max) return "max_turn_requests";
  if (bridge.lastFinishReason === "length") return "max_tokens";
  return "end_turn";
}
