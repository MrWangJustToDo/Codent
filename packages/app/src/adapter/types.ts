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
// Agent Adapter Interface
// ============================================================================

export interface AgentAdapter {
  initialize(config: AppConfig): Promise<InitResult>;
  destroy(): Promise<void>;
  exit(): void;
  readClipboardImage?(): Promise<ClipboardImageResult | null>;
}
