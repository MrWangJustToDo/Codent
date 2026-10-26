/**
 * What an extension may reach while a session is running.
 *
 * These types are the *contract* between an extension and the host runtime. The implementation of
 * {@link ExtensionRuntimeAccess} lives on the agent (it owns the session, the model connection, the
 * usage tracker and the run), so the extension API stays free of host classes and the host stays free
 * of extension policy.
 *
 * Kept in its own module (re-exported by `types.ts`) because `types.ts` is already at the file-size
 * limit; the extension surface did not shrink, it grew a second subject.
 */

import type { SchemaInput, ModelMessage } from "@tanstack/ai";

/** One message in an extension completion request. */
export interface ExtensionLlmMessage {
  role: "user" | "assistant";
  content: string;
}

/**
 * One-shot completion request.
 *
 * `messages` is the general form; `prompt` is a shorthand for a single user message. Either may be
 * omitted only when the other is present.
 */
export interface ExtensionLlmRequest {
  /** System prompt for the request. */
  system?: string;
  /** Conversation to send, in order. Takes precedence over `prompt`. */
  messages?: readonly ExtensionLlmMessage[];
  /** Shorthand for `messages: [{ role: "user", content: prompt }]`. */
  prompt?: string;
  /**
   * Model to use. Resolved against the session's own catalog (one connection, one credential set);
   * an unknown name rejects rather than silently substituting. Defaults to the session's model.
   */
  model?: string;
  /** Output-token cap for this call; the runtime applies its own default when omitted. */
  maxOutputTokens?: number;
  /** Cancellation; defaults to {@link ExtensionContext.signal} when omitted. */
  signal?: AbortSignal;
  /**
   * Presence selects the structured form: the resolved value satisfies this schema. Absent → text.
   * (The public `ExtensionLlm` overloads are the typed surface; this is the runtime shape both
   * overloads share.)
   */
  schema?: SchemaInput;
}

/** Result of a completion: text, or the schema-validated value. */
export type ExtensionLlmResult<T = unknown> = { text: string } | { data: T };

/**
 * The extension-facing model port.
 *
 * Both forms run outside the agent loop (no tools, no transcript entry) and attribute their token
 * usage to the session automatically. A failure rejects; the caller decides whether to degrade.
 */
export interface ExtensionLlm {
  /** Structured completion: the resolved value satisfies `schema`. */
  complete<T = unknown>(request: ExtensionLlmRequest & { schema: SchemaInput }): Promise<{ data: T }>;
  /** Text completion. */
  complete(request: ExtensionLlmRequest): Promise<{ text: string }>;
}

/** Context-window fill, as the footer reports it. */
export interface ExtensionContextUsage {
  /** Tokens the window currently holds (the single `getContextFillTokens()` reading). */
  fillTokens: number;
  /** Budget the fill is measured against (the compaction threshold, not the raw window). */
  limitTokens: number;
}

/**
 * Host-side accessors backing the extension context.
 *
 * Every method reads **at call time** — a handler must never see a fact from a previous run or a
 * replaced session. The host supplies one instance per agent.
 */
export interface ExtensionRuntimeAccess {
  /** Active disk session id, or null when none is bound. */
  sessionId(): string | null;
  /** Whether a run is in flight. */
  isIdle(): boolean;
  /** Session mode as the runtime reports it (`normal` / `auto` / plan phase). */
  mode(): string;
  /** Model the session is currently using, when known. */
  model(): string | undefined;
  /** The active run's abort signal, or undefined when idle. */
  signal(): AbortSignal | undefined;
  /** Defensive copy of the model-visible conversation for the current run. */
  messages(): ModelMessage[];
  /** Context-window fill, or undefined when the model window is unknown. */
  contextUsage(): ExtensionContextUsage | undefined;
  /** The effective system prompt for the current run. */
  systemPrompt(): string;
  /**
   * Run a one-shot completion for `extensionId`. The host owns the connection, the model catalog,
   * the usage attribution and the per-run budget — the extension only sees the result or a typed
   * rejection.
   */
  complete(extensionId: string, request: ExtensionLlmRequest): Promise<ExtensionLlmResult>;
}
