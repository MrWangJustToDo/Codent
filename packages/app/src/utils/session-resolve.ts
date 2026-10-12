/**
 * Resolve the active root AgentSession, or a child/subagent session by id via the host.
 *
 * One runtime holds exactly one live root session; other ids (subagents) are
 * reached through `host.connect`.
 *
 * reactivity-store selectors / getReadonlyState() wrap stored objects as
 * readonly proxies. Session/Host are live handles (`subscribe`, `dispatch`,
 * `connect`) — always unwrap with {@link toRaw} before calling methods.
 */

import { toRaw } from "reactivity-store";

import { useAgent } from "../hooks/use-agent.js";

import type { AgentSession, AgentSessionHost } from "@codent/core";

function unwrapHandle<T extends object>(value: T | null | undefined): T | null {
  if (value == null) return null;
  return toRaw(value);
}

export function getActiveSession(): AgentSession | null {
  return unwrapHandle(useAgent.getReadonlyState().session);
}

export function getActiveHost(): AgentSessionHost | null {
  return unwrapHandle(useAgent.getReadonlyState().host);
}

/** Root session, or `host.connect(agentId)` for a child / subagent. */
export function resolveAgentSession(agentId: string | null | undefined): AgentSession | null {
  if (!agentId) return null;
  const session = getActiveSession();
  const host = getActiveHost();
  if (session?.id === agentId) return session;
  return unwrapHandle(host?.connect(agentId));
}
