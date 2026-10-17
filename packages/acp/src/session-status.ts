/**
 * What the agent tells a client about a session's state: the modes it advertises, the id it
 * addresses the session by, and why a turn ended.
 *
 * Split out of `agent.ts` (a subject of its own, and that file is at the line ceiling).
 */

import { MODE_IDS, MODE_META, legacySessionModelState, sessionConfigOptions } from "./session-config-options.js";

import type { AcpModelCatalogEntry, LegacySessionModelState } from "./session-config-options.js";
import type { SessionConfigOption, SessionMode, SessionModeState, StopReason } from "@agentclientprotocol/sdk";
import type { AgentMode, AgentSession, AgentSessionSnapshot } from "@codent/core";

/**
 * The legacy `modes` field, kept alongside `configOptions` during the protocol's transition.
 *
 * The spec says agents with mode-like configuration SHOULD send both: `configOptions` for clients
 * that understand it, `modes` for those that only read the older API. The mode vocabulary itself
 * lives in `session-config-options.ts` (one home, shared with the `category: "mode"` option).
 */
/**
 * The `modes` + `configOptions` pair every session-creating response carries.
 *
 * `new`, `load`, `resume` and `fork` all answer the same question — "which mode and model may this
 * client choose from?" — so they answer it with one builder. `load`/`resume` used to return `{}`: the
 * selectors survived `session/new` and vanished on reopen, which is the client losing its model picker
 * after a thread was restored (the legacy `modes` field goes along for clients that still read it).
 */
export function sessionSelectors(
  snapshot: AgentSessionSnapshot,
  catalog: AcpModelCatalogEntry[] | undefined,
  selectedEntryIndex?: number
): { modes: SessionModeState; configOptions: SessionConfigOption[]; models?: LegacySessionModelState } {
  const models = legacySessionModelState(catalog, snapshot.model, selectedEntryIndex);
  return {
    modes: sessionModes(snapshot.mode),
    configOptions: sessionConfigOptions(snapshot, catalog, selectedEntryIndex),
    // Older clients read `models` and call `session/set_model`; newer ones read the `model` config
    // option. Both are the same catalog, so the two surfaces cannot disagree.
    ...(models ? { models } : {}),
  };
}

/** {@link sessionSelectors} for a live bridge — the shape `load` / `resume` answer with. */
export function sessionSelectorsFor(
  bridge: { session: AgentSession; selectedModelEntryIndex?: number },
  catalog: AcpModelCatalogEntry[] | undefined
): { modes: SessionModeState; configOptions: SessionConfigOption[] } {
  return sessionSelectors(bridge.session.getSnapshot(), catalog, bridge.selectedModelEntryIndex);
}

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
