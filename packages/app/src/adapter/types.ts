import type { AgentSession, AgentSessionHost, AgentToolConfig, ModelInfo, ModelStyle } from "@codent/core";
import type { UIMessage } from "@tanstack/ai";
import type { ReactNode } from "react";

// ============================================================================
// App Configuration
// ============================================================================

export interface AppConfig {
  model: string;
  /** API style: OpenAI-compatible or Anthropic Messages */
  style: ModelStyle; /** API base URL (defaults per style when empty) */
  baseURL: string;
  apiKey: string;
  systemPrompt: string;
  initialPrompt: string;
  maxIterations: number;
  /** Max concurrent `task` subagents under this agent (core default 4). */
  maxConcurrentTasks?: number;
  debug: boolean;
  mcpConfigPath: string;
  /**
   * Extra extension directories (comma-separated on CLI as `--extension-dirs`).
   * Merged ahead of `.agents/extension` and `~/.agents/extension`.
   */
  extensionDirs: string[];
  continueSession: boolean;
  resumeSession: string;
  /**
   * Display name of the running host (`codent` for the dev CLI, `codent` for
   * the bundled release host). Purely cosmetic — it feeds the help screen, the
   * OSC-0 terminal title, and nothing else. Undefined falls back to `codent`.
   */
  productName?: string;
  /**
   * Whether this host can talk to the remote planes (`--remote-env` /
   * `--remote-provider` / `--remote-session`). Undefined means yes — every
   * development host has them. The bundled release host sets `false`, and the
   * help screen then omits flags it cannot honour.
   */
  remotePlanes?: boolean;
  /**
   * Whether this host serves the Agent Client Protocol over stdio (`codent acp`) for
   * editors / ACP clients. Undefined means no — only the release host wires the ACP
   * subcommand, so the help screen omits it elsewhere.
   */
  acp?: boolean;
  /**
   * Optional remote CoreEnv (workspace) base URL (`--remote-env` / REMOTE_ENV).
   * When set, hosts register a remote CoreEnv instead of the local Node env.
   */
  remoteEnv?: string; /**
   * Optional remote model provider base URL (`--remote-provider` / REMOTE_PROVIDER).
   * Keys stay on the provider server; API key is not a local secret.
   */
  remoteProvider?: string;
  /**
   * Optional remote Agent Session base URL (`--remote-session` / REMOTE_SESSION).
   * When set, hosts may bind {@link AgentSession} via RemoteSessionClient.
   */
  remoteSession?: string;
  /** Optional model metadata override (hosts may parse MODEL_* env vars) */
  modelInfo?: ModelInfo;
  /**
   * Set by the CLI bootstrap when any explicit model flag (`--model` / `--style` /
   * `--base-url` / `--api-key`) was passed. It makes the session **isolated from the
   * on-disk `.agents/config/models.json`**: the flags are authoritative, `initConfig`
   * does not load the file, and `/models` lists nothing. Also why the first-run config
   * editor is skipped (an explicit model counts as configured).
   */
  modelExplicit?: boolean;
  /**
   * Server-resolved model (e.g. `--remote-session` defers model to the server's
   * `.env`). Display-only: kept out of the agent-chat effect deps so the
   * initialization-time update does not tear down the just-created session.
   */
  serverModel?: string;
  /**
   * How LLM credentials are resolved for this session.
   * `remote` = provider server holds keys; UI should not treat apiKey as a local secret.
   */
  providerMode?: "direct" | "remote";
  /** Explicit tool secrets / prefs (e.g. Brave websearch). Hosts parse env and pass here. */
  toolConfig?: AgentToolConfig;
}

// ============================================================================
// Command Result
// ============================================================================

export type CommandResult = { ok: true; message?: string; node?: ReactNode } | { ok: false; error: string };

// ============================================================================
// Initialization Result
// ============================================================================

export interface InitResult {
  /** Session catalog / factory for this process (or remote HTTP Host). */
  host: AgentSessionHost;
  /** Active AgentSession — UI control surface. */
  session: AgentSession;
  initialMessages?: UIMessage[];
}

// ============================================================================
// Clipboard
// ============================================================================

export interface ClipboardImageResult {
  data: string;
  mediaType: string;
}

// ============================================================================
// External editor
// ============================================================================

/** What a host editor is asked to open. */
export interface EditorTarget {
  /** Absolute path of the file to edit. */
  path: string;
  /** 1-based line to position the cursor on, when the caller knows one. */
  line?: number;
}

// ============================================================================
// Agent Adapter Interface
// ============================================================================

export interface AgentAdapter {
  initialize(config: AppConfig): Promise<InitResult>;
  destroy(): Promise<void>;
  /**
   * Leave the app.
   *
   * `report` is the exit summary the app captured from the live session. A host that tears
   * the UI down before exiting (the alternate-screen hosts) prints it itself; a host that
   * paints it in the last frame (the normal-screen path) can ignore it.
   */
  exit(report?: readonly string[]): void;
  readClipboardImage?(): Promise<ClipboardImageResult | null>;
  /**
   * Open a workspace file in the terminal editor this host owns, suspending the UI until the
   * editor exits.
   *
   * Like `readClipboardImage`, this is a property of the *terminal*, not of the workspace: it is
   * optional because a host without a local process (browser extension, WebContainer playground)
   * has nothing to hand the terminal to. The workspace panel hides the action when it is absent.
   *
   * A host that implements it is responsible for the whole handoff — releasing the terminal,
   * starting the editor, and bringing the UI back — and for reporting failures through
   * `useEditorHandoff().setNotice(...)` rather than by writing to the terminal. Implementations
   * reject (with a user-readable reason) when the target cannot be opened here, e.g. a remote
   * workspace whose files are not on this machine.
   */
  openInEditor?(target: EditorTarget): Promise<void>;
}
