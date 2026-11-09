/**
 * Client-side state helpers for the remote session: the shell snapshot, JSON date revival, and the
 * remount-seed merge rules.
 *
 * Extracted from `remote-session-client.ts` (a transport module) so those rules can be read and
 * tested without the SSE loop, and so the client stays under the file-size ceiling.
 */

import type { ToolBufferMap } from "./remote-session-reducer.js";
import type { AgentSessionSnapshot, AgentStreamSnapshot } from "@codent/core";

export function emptySnapshot(agentId: string): AgentSessionSnapshot {
  const emptyTokens = {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
  };
  return {
    agentId,
    name: "",
    status: "idle",
    state: { lifecycle: "ready", run: "idle", wait: "none", outcome: "none", stream: "none" },
    error: "",
    pendingApprovalCount: 0,
    mode: "normal",
    lastStreamDurationMs: 0,
    lastFinishReason: null,
    messages: [],
    queues: { steer: [], followUp: [] },
    // UsageChangeSnapshot shape — the shell must stay valid before first resync.
    usage: {
      total: { ...emptyTokens },
      window: { ...emptyTokens },
      percent: 0,
      contextFillTokens: 0,
      billedInputTokens: 0,
      tokenLimit: 0,
      cost: 0,
    },
    todos: [],
    todosTitle: null,
    plan: { phase: "off" },
    autoMode: false,
    mcp: { servers: [] },
    extensions: { extensions: [], commands: [] },
    toolDescriptors: [],
    interactions: { pending: [], approvals: [], askUser: [] },
    iteration: { current: 0, max: 0 },
    jobs: { jobs: [] },
    subagents: [],
  } as unknown as AgentSessionSnapshot;
}

/**
 * JSON transport turns the Date-typed UIMessage `createdAt` into an ISO string; TanStack's wire
 * conversion calls `createdAt.toISOString()` and would crash on the string form.
 */
export function reviveMessageTimestamps(messages: AgentSessionSnapshot["messages"]): void {
  for (const message of messages) {
    const raw = (message as { createdAt?: unknown }).createdAt;
    if (typeof raw === "string") {
      const revived = new Date(raw);
      if (!Number.isNaN(revived.getTime())) {
        (message as { createdAt?: Date }).createdAt = revived;
      }
    }
  }
}

/**
 * Apply summary-stream seeds.
 *
 * `clean` means no frame for this cache arrived during the fetch, so the seed set is authoritative
 * and keys missing from it are stale (a session switch). When a frame DID arrive, keep both and let
 * the per-key `seq` guard decide — trimming could delete the newer live entry.
 */
export function mergeSummarySeeds(
  cache: Map<string, AgentStreamSnapshot>,
  seeds: AgentStreamSnapshot[],
  clean: boolean
): void {
  if (clean) {
    // No frame landed during the fetch, so the server's seed set is authoritative: drop keys it no
    // longer has and take its entries verbatim (a restarted stream resets `seq`, so a stale local
    // entry must not out-rank it).
    const keys = new Set(seeds.map((seed) => seed.key));
    for (const key of [...cache.keys()]) {
      if (!keys.has(key)) cache.delete(key);
    }
    for (const seed of seeds) cache.set(seed.key, seed);
    return;
  }
  // A frame arrived while the seed was in flight. Both describe the same stream; keep the newer.
  // On an equal seq the live entry wins (it was applied after the seed was serialized).
  for (const seed of seeds) {
    const current = cache.get(seed.key);
    if (!current || seed.seq > current.seq) cache.set(seed.key, seed);
  }
}

/** Apply command-output seeds, keeping the longer (newer) stream per side. */
export function mergeToolSeeds(
  cache: ToolBufferMap,
  seeds: Record<string, { stdout: string; stderr: string }>,
  clean: boolean
): void {
  if (clean) {
    for (const key of [...cache.keys()]) {
      if (!(key in seeds)) cache.delete(key);
    }
  }
  for (const [key, seed] of Object.entries(seeds)) {
    const current = cache.get(key);
    cache.set(key, {
      stdout: current && current.stdout.length > seed.stdout.length ? current.stdout : seed.stdout,
      stderr: current && current.stderr.length > seed.stderr.length ? current.stderr : seed.stderr,
    });
  }
}
