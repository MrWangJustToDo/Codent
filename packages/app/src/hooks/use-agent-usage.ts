import { useEffect, useState } from "react";
import { createState, toRaw } from "reactivity-store";

import { useAgent } from "./use-agent.js";

import type { AgentSession, TokenUsage, UsageChangeSnapshot } from "@codent/core";

export interface AgentUsageSnapshot {
  total: TokenUsage;
  window: TokenUsage;
  percent: number;
  /** True context-window fill (uncached + cached prompt); see `contextFillTokens`. */
  contextFillTokens: number;
  /** Billed prompt across the session lifetime — denominator for cache share. */
  billedInputTokens: number;
  tokenLimit: number;
  cost: number;
}

export interface AgentUsageView {
  version: number;
  session: AgentSession | null;
  usage: AgentUsageSnapshot | null;
}

const toView = (snap: UsageChangeSnapshot): AgentUsageSnapshot => ({
  total: { ...snap.total },
  window: { ...snap.window },
  percent: snap.percent,
  contextFillTokens: snap.contextFillTokens,
  billedInputTokens: snap.billedInputTokens,
  tokenLimit: snap.tokenLimit,
  cost: snap.cost,
});

const usageState = createState(() => ({ version: 0 }), {
  withActions: (s) => ({
    bump: () => {
      s.version++;
    },
  }),
  withNamespace: "useAgentUsage",
});

/** Reactive view of session usage for footer and slash commands. */
export const useAgentUsage = (): AgentUsageView => {
  const session = toRaw(useAgent((s) => s.session));
  const version = usageState((s) => s.version);
  const [usage, setUsage] = useState<AgentUsageSnapshot | null>(() => {
    if (!session) return null;
    return toView(session.getSnapshot().usage);
  });

  useEffect(() => {
    if (!session) {
      setUsage(null);
      return;
    }

    // The first render is seeded from the snapshot in useState; the retained
    // `usage` replay in subscribe() then keeps this handle's view current.
    return session.subscribe(
      (event) => {
        if (event.channel !== "usage") return;
        // Reactive update only — do NOT bump version here. `version` marks a
        // session identity change (resume/new/compact, via bumpAgentUsage),
        // not every token increment; bumping here would remount AnimateNumber
        // and kill the footer token animation.
        setUsage(toView(event.payload));
      },
      { channels: ["usage"] }
    );
  }, [session]);

  return {
    version,
    session,
    usage,
  };
};

export const bumpAgentUsage = (): void => {
  usageState.getActions().bump();
};
