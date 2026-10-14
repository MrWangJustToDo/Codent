/**
 * AgentSessionHost — catalog + factory for AgentSession handles.
 *
 * Apps use Host instead of importing `agentManager` / `SessionStore`.
 * Local Host wraps AgentManager; HTTP Host will mirror the same surface.
 *
 * Identity, because the two ids read alike and are not: a handle is addressed by `agentId`
 * (process-scoped, re-minted on restart), while `sessionId`/`activeSessionId` is a PERSISTED
 * conversation ({@link DiskSessionId}). See ARCHITECTURE.md §1.7.
 */

import type { AgentSession, DiskSessionId } from "./types.js";
import type { AgentToolConfig } from "../agent/tools/tool-config.js";
import type { CoreEnv } from "../env";
import type { ModelInfo, ModelStyle } from "../models/types.js";
import type { ModelProvider } from "../provider/model-provider.js";
import type { AgentStatus } from "../runtime-types/agent-status.js";
import type { UIMessage } from "@tanstack/ai";

// ============================================================================
// Create options / list entries
// ============================================================================

/**
 * Options for {@link AgentSessionHost.create}.
 * Maps onto ManagedAgentConfig without exposing the manager type to app code.
 */
export interface AgentSessionCreateOptions {
  name: string;
  model: string;
  modelStyle?: ModelStyle;
  modelBaseURL?: string;
  modelApiKey?: string;
  modelInfo?: ModelInfo;
  /** `remote` = a provider server owns the model (never overridden locally). */
  providerMode?: "direct" | "remote";
  systemPrompt?: string;
  maxIterations?: number;
  /** Max concurrent `task` subagents under this agent (default 4). */
  maxConcurrentTasks?: number;
  mcpConfigPath?: string;
  extensionDirs?: string[];
  /** Continue the latest on-disk session after the agent is created (bootstrap only). */
  continueSession?: boolean;
  /**
   * Resume a specific disk session ({@link DiskSessionId}) after create (bootstrap only).
   * Mid-session switches use `session.dispatch({ type: "session.resume", sessionId })` —
   * both paths call {@link ManagedAgent.restoreSession}.
   */
  resumeSessionId?: DiskSessionId;
  /** Explicit tool secrets / prefs (e.g. Brave websearch key). */
  toolConfig?: AgentToolConfig;
}

/** Thin catalog row for live agents owned by a Host. */
export interface AgentSessionListEntry {
  agentId: string;
  name: string;
  parentId?: string;
  status: AgentStatus;
  /**
   * Disk session ({@link DiskSessionId}) currently active for this live agent (root agents only).
   * An agent holds at most one at a time today, but the ownership table (`sessionId → agentId`)
   * is many-to-one, so this is the CURRENT conversation, not the only one it could hold.
   */
  activeSessionId?: DiskSessionId;
  createdAt: number;
  updatedAt: number;
}

export interface AgentSessionCreateResult {
  session: AgentSession;
  /** UIMessages restored when continue/resume was requested. */
  initialMessages?: UIMessage[];
}

/**
 * Session catalog + factory. Prefer this over `agentManager` in hosts and app adapters.
 */
export interface AgentSessionHost {
  /** Create a root agent and return its AgentSession. */
  create(options: AgentSessionCreateOptions): Promise<AgentSessionCreateResult>;
  /** Bind an AgentSession to an existing agent id (root or subagent). */
  connect(agentId: string): AgentSession | null;
  /** List live agents currently owned by this host (roots and children). */
  list(): AgentSessionListEntry[] | Promise<AgentSessionListEntry[]>;
  /** Destroy an agent (cascades to children) and drop its session handle. */
  destroy(agentId: string): Promise<void>;
  /**
   * The runtime's model provider, so app-side model resolution uses this runtime's
   * connection rather than the process-global registry. Omitted by remote-session
   * hosts (the agent server owns the model), which leaves ambient resolution.
   */
  getModelProvider?(): ModelProvider | undefined;
  /**
   * The runtime's workspace env, so a host-bound consumer (the app's default system
   * prompt) uses this runtime's root/platform rather than the ambient env. Omitted
   * by remote-session hosts, which leave ambient resolution.
   */
  getEnv?(): CoreEnv | undefined;
}
