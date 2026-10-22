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
import type { ExtensionFactory } from "../agent/extension/types.js";
import type { McpServerConfig } from "../agent/mcp";
import type { SessionMeta } from "../agent/persistence/types.js";
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
 * Per-session switches for core's built-in extensions.
 *
 * Only `false` is meaningful here: `true` (or omission) keeps the built-in's default
 * configuration, while the richer per-extension objects remain a `ManagedAgentConfig`
 * detail. A host that needs that level of tuning can still create a runtime with
 * defaults, but the session contract must cover the common "turn this off" case.
 */
export interface AgentSessionBuiltins {
  lsp?: boolean;
  skills?: boolean;
  memory?: boolean;
  mcp?: boolean;
  codeMode?: boolean;
}

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
  /**
   * MCP servers supplied directly by the caller for THIS session, keyed by server name.
   *
   * When present (and non-empty) it REPLACES `.agents/mcp.json` rather than merging: the two
   * sources can name the same server with entirely different `command` / `url`, and silently
   * picking one is the hardest failure to explain. It also matches the existing "explicit
   * config isolates the on-disk one" precedent (`--model` / `--base-url` / `--api-key` skip
   * `.agents/config/models.json`). Omitted ⇒ behavior is unchanged (the file is the source).
   *
   * Note the type: `McpServerConfig` is ONE server's union; the map is the plural form.
   */
  mcpServers?: Record<string, McpServerConfig>;
  extensionDirs?: string[];
  /**
   * In-process extension factories for this session. Local hosts load these during
   * bootstrap; a remote-session host cannot serialize functions and rejects them
   * explicitly rather than silently dropping them.
   */
  extensions?: ExtensionFactory[];
  /** Disable individual built-in extensions for this session (omit/`true` = default). */
  builtins?: AgentSessionBuiltins;
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
  /**
   * Create a root agent and return its AgentSession.
   *
   * Ownership: the caller owns the returned live agent and must call `destroy()`.
   * `CodentAgent.dispose()` only destroys sessions created through its
   * `createSession()` convenience wrapper; calling this method directly bypasses
   * that ownership set.
   */
  create(options: AgentSessionCreateOptions): Promise<AgentSessionCreateResult>;
  /** Bind an AgentSession to an existing agent id (root or subagent). */
  connect(agentId: string): AgentSession | null;
  /** List live agents currently owned by this host (roots and children). */
  list(): Promise<AgentSessionListEntry[]>;
  /** Destroy an agent (cascades to children) and drop its session handle. */
  destroy(agentId: string): Promise<void>;
  /**
   * Enumerate the workspace's PERSISTED sessions (disk catalog), ordered `updatedAt` desc.
   *
   * Distinct from {@link list}, which reports the live agents this host owns: a session created
   * by an earlier process is resumable but has no live agent, so a session picker built on
   * `list()` shows nothing after a restart. This answers "what is stored", `list` answers
   * "what is running".
   *
   * Optional because a host bound to a plane with no local store cannot serve it (the
   * remote-session host forwards to an agent server and holds no disk catalog), and because
   * making it required would break every existing implementer at compile time. Same convention
   * as {@link getModelProvider} / {@link getEnv}: absent means "this host cannot", and a
   * consumer must detect the absence instead of calling it.
   */
  listPersistedSessions?(): Promise<SessionMeta[]>;
  /**
   * Remove a persisted session. Returns whether the session's data was removed.
   *
   * Lifecycle, not a bare store call: a session that is still live must be torn down first
   * (otherwise an append stream keeps writing to the removed log), and a session that is
   * ALREADY live-only — one minted in memory by `create` and not yet written to disk — counts
   * as removed. Optional for the same reason as {@link listPersistedSessions}.
   */
  deleteSession?(sessionId: DiskSessionId): Promise<boolean>;
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
