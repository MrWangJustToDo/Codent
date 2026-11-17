/**
 * The host's configuration surface: what an embedding host (or `bootstrap.ts`) hands
 * `createAcpAgent`, and what it gets back for one session.
 *
 * These types used to live in `agent.ts`, which made `bootstrap` and `session-runtime` import the
 * app module to name the options they feed it. They are a contract, not app state, so they own a
 * module of their own and the app imports them like everyone else.
 */

import type { AcpClientEnv } from "../client-env/environment.js";
import type { AgentContext, ClientCapabilities } from "@agentclientprotocol/sdk";
import type {
  AgentToolConfig,
  AgentSessionHost,
  ModelCatalogRead,
  ModelInfo,
  ModelStyle,
  SessionMeta,
} from "@codent/core";

// Re-exported so a host builds `AcpAgentOptions` from one import site rather than reaching into the
// module that happens to consume the catalog.
export type { AcpModelCatalogEntry } from "../session/session-config-options.js";

/** What every session this host creates starts from (launch flags / the embedding host's config). */
export interface AcpAgentDefaults {
  model: string;
  modelStyle?: ModelStyle;
  modelBaseURL?: string;
  modelApiKey?: string;
  modelInfo?: ModelInfo;
  /** Omit for core's `DEFAULT_AGENT_MAX_ITERATIONS` (the schema default). */
  maxIterations?: number;
  /** Max concurrent `task` subagents per session (core default 4). */
  maxConcurrentTasks?: number;
  /** Websearch secrets / provider preference for every session (from models.json or an embedder). */
  toolConfig?: AgentToolConfig;
  /** Extra extension dirs for every session (the workspace `.agents/extension` is still scanned). */
  extensionDirs?: string[];
  /** Override the MCP config file (`.agents/mcp.json` by default). */
  mcpConfigPath?: string;
  systemPrompt?: string;
}

export interface AcpAgentOptions {
  host: AgentSessionHost;
  defaults: AcpAgentDefaults;
  rootPath?: string;
  version?: string;
  /**
   * The runtime's model read — the ONE `loadModels(...)` result, carried by the runtime this host serves.
   * The host projects it (selectors, legacy `models`, both write paths) and never derives a list of its
   * own. Absent only for an embedder that supplies no read, which means "no model list".
   */
  models?: ModelCatalogRead;
  /** The entry the default model came from — seeds a new session's recorded entry (a seed, not a selection). */
  modelsDefaultEntryIndex?: number;
  /**
   * Build a per-session runtime whose env is backed by this session's workspace root (and, under
   * `--client-env`, by the ACP client).
   *
   * Absent by default, in which case every session goes through `host` exactly as before. When
   * present, `session/new` / `load` / `resume` ask it for a host **bound to that session's root**
   * and use that host instead, which is what makes ACP's `cwd` the session workspace root.
   */
  createSessionHost?: (context: AcpClientEnvFactoryContext) => Promise<AcpSessionRuntime>;
  /** Enumerate persisted sessions for a `session/list` `cwd` other than the process default. */
  listPersistedSessionsAt?: (rootPath: string) => Promise<SessionMeta[]>;
  /**
   * Delete a persisted session in a workspace root other than the process default.
   *
   * `DeleteSessionRequest` carries no `cwd`, so the root is remembered from create/resume/list.
   * A live session is deleted through its OWN runtime host (see the catalog's `deleteLive`); this
   * is the cold-session half.
   */
  deleteSessionAt?: (rootPath: string, sessionId: string) => Promise<boolean>;
  /** How long a permission/elicitation request waits for the client before being settled. */
  interactionTimeoutMs?: number;
}

/** What {@link AcpAgentOptions.createSessionHost} needs to build one session's runtime. */
export interface AcpClientEnvFactoryContext {
  /**
   * The session's workspace root (`cwd` from the ACP request), already absolute.
   *
   * Each session owns one CoreEnv rooted here; `.agents/**`, relative tool paths and `session/list`
   * all follow it.
   */
  rootPath: string;
  /**
   * The ACP session id as the client knows it (the disk id — see `diskSessionId`), or `undefined`
   * before the session exists.
   *
   * A nullable getter, not a value, because of an ordering fact: `session/load` and
   * `session/resume` are told the id by the client, but `session/new` is not — core mints it
   * inside `host.create` (`ensureSessionData`), which is the very call that needs this env.
   *
   * During that call the env is asked to read workspace files — the instruction file
   * (`AGENTS.md` / `CLAUDE.md`), `.lsp.json`, `.mcp.json` — and none of them can be tagged with a
   * session id yet. They are served from the local fallback and counted; refusing them is not an
   * option, because the instruction loader catches a failed read and reports "no documentation
   * file found", so a refusal silently costs every new session its project instructions.
   */
  sessionId: () => string | undefined;
  /** The client capabilities observed during `initialize`. */
  clientCapabilities: ClientCapabilities | undefined;
  /**
   * The agent-side connection handle, for calling `fs/*` / `terminal/*` back to the client.
   *
   * Passed down rather than imported: the connection belongs to the app, and a session's env must
   * not be able to outlive it.
   */
  client: () => AgentContext;
}

/**
 * A per-session runtime handed back by {@link AcpAgentOptions.createSessionHost}.
 *
 * `dispose` is required and not optional: this runtime owns an env built for one session, and a
 * leaked one keeps a client-backed env (and its fallback handle) alive after the session is gone.
 */
export interface AcpSessionRuntime {
  host: AgentSessionHost;
  dispose: () => Promise<void>;
  /**
   * The client-backed env this runtime serves, when it has one.
   *
   * Presence is what tells the approval policy that writes may leave the process — see
   * `approvals.ts`. Omitted by runtimes that do not borrow the client's filesystem.
   */
  clientEnv?: AcpClientEnv;
}
