/**
 * Extension model access: the host half of `ctx.llm`.
 *
 * The extension API exposes a small, provider-free surface (`ExtensionLlm`); everything that makes a
 * completion *safe* lives here — the session's connection, the catalog check, usage attribution and
 * the per-run budget. Keeping it host-side is what lets an extension say "complete this" without
 * ever seeing a base URL, a key, or a tracker.
 */

import { createTextAdapter } from "../models/adapter/adapter-factory.js";
import { runSideTextQuery } from "../models/adapter/side-text-query.js";
import { DEFAULT_BASE_URLS } from "../models/config/model-config.js";

import type { UsageTracker } from "./telemetry/usage-tracker.js";
import type { AgentLog } from "../agent/agent-log/agent-log.js";
import type { ExtensionLlmRequest, ExtensionLlmResult } from "../agent/extension/context-access.js";
import type { TextAdapterConfig } from "../models/adapter/adapter-factory.js";
import type { LoadedModelEntry } from "../models/config/models-config.js";
import type { ModelStyle } from "../models/types.js";

/** Why an extension completion failed. Extensions branch on `code`, not on message text. */
export type ExtensionLlmErrorCode = "no-adapter" | "unknown-model" | "budget-exceeded" | "bad-request";

/** Typed rejection of an extension completion. */
export class ExtensionLlmError extends Error {
  readonly code: ExtensionLlmErrorCode;

  constructor(code: ExtensionLlmErrorCode, message: string) {
    super(message);
    this.name = "ExtensionLlmError";
    this.code = code;
  }
}

/** Default output-token cap when the caller does not set one. */
export const DEFAULT_EXTENSION_MAX_OUTPUT_TOKENS = 4096;
/** Default completions allowed per run (reset when the run's abort controller changes). */
export const DEFAULT_EXTENSION_CALLS_PER_RUN = 20;

/** What the completion path needs from the agent. Structural so this module stays free of the class. */
export interface ExtensionCompletionHost {
  readonly usage: UsageTracker;
  readonly log: AgentLog | null;
  resolveTextAdapter?: () => Promise<TextAdapterConfig | null>;
  /** The session's current connection, used to decide whether a catalog model is reachable. */
  getExtensionConnection(): { style?: ModelStyle; baseURL?: string; apiKey?: string };
  /** The model catalog this runtime was created with, when a host read one. */
  getExtensionCatalog(): readonly LoadedModelEntry[] | undefined;
  /** The active run's signal (undefined when idle). */
  getExtensionSignal(): AbortSignal | undefined;
  /** Count one call against the current run's budget; throws {@link ExtensionLlmError} when spent. */
  consumeExtensionBudget(extensionId: string): void;
  /** The effective model id the session is running. */
  getExtensionModel(): string | undefined;
  /** Per-agent output-token cap, when the host configured one. */
  getExtensionMaxOutputTokens?(): number | undefined;
  /**
   * Build an adapter for a catalog model. Defaults to the shared factory; injectable so a host can
   * wrap the connection (and so the validator can exercise selection without a network).
   */
  createExtensionAdapter?(input: {
    style: ModelStyle;
    model: string;
    baseURL: string;
    apiKey?: string;
  }): TextAdapterConfig;
}

/**
 * Resolve the adapter for a request.
 *
 * The default is the session's own adapter (one code path, already cached by the agent). A named
 * model is only accepted when the runtime's catalog offers it **on the session's connection**: an
 * extension may pick a cheaper model, but it can never point at another provider or key — that is the
 * difference between "choose a model" and "smuggle a credential".
 */
async function resolveAdapter(
  host: ExtensionCompletionHost,
  requestedModel: string | undefined
): Promise<TextAdapterConfig> {
  const sessionModel = host.getExtensionModel();

  if (!requestedModel || requestedModel === sessionModel) {
    const adapter = await host.resolveTextAdapter?.();
    if (!adapter) {
      throw new ExtensionLlmError(
        "no-adapter",
        "This session has no model connection to run an extension completion on."
      );
    }
    return adapter;
  }

  const entries = host.getExtensionCatalog();
  if (!entries || entries.length === 0) {
    throw new ExtensionLlmError(
      "unknown-model",
      `Cannot select model "${requestedModel}": this runtime has no model catalog to validate it against.`
    );
  }
  const connection = host.getExtensionConnection();
  const entry = entries.find((candidate) => candidate.models.includes(requestedModel));
  if (!entry) {
    throw new ExtensionLlmError(
      "unknown-model",
      `Model "${requestedModel}" is not offered by this session's catalog. Available: ${entries
        .flatMap((candidate) => candidate.models)
        .join(", ")}`
    );
  }
  // Same connection = same style and same base URL. A catalog entry from another provider would come
  // with its own base URL (and usually its own key); using it would turn "pick a cheap model" into
  // "reach a provider the host never configured".
  const connectionBase = connection.baseURL ?? (connection.style ? DEFAULT_BASE_URLS[connection.style] : undefined);
  const sameConnection =
    connection.style !== undefined &&
    entry.style === connection.style &&
    trimTrailingSlash(entry.baseURL) === trimTrailingSlash(connectionBase ?? "");
  if (!sameConnection) {
    throw new ExtensionLlmError(
      "unknown-model",
      `Model "${requestedModel}" belongs to a different connection than this session's; an extension may only use the session's own connection.`
    );
  }

  const build =
    host.createExtensionAdapter ??
    ((input: { style: ModelStyle; model: string; baseURL: string; apiKey?: string }) =>
      createTextAdapter({ style: input.style, model: input.model, baseURL: input.baseURL, apiKey: input.apiKey }));

  return build({
    style: entry.style,
    model: requestedModel,
    baseURL: entry.baseURL,
    ...((entry.apiKey ?? connection.apiKey) ? { apiKey: entry.apiKey ?? connection.apiKey } : {}),
  });
}

/** Base URLs are configuration text: `https://x/v1` and `https://x/v1/` are the same endpoint. */
function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function normalizeMessages(request: ExtensionLlmRequest): Array<{ role: "user" | "assistant"; content: string }> {
  if (request.messages && request.messages.length > 0) {
    return request.messages.map((message) => {
      if (message.role !== "user" && message.role !== "assistant") {
        throw new ExtensionLlmError("bad-request", `Unsupported message role "${String(message.role)}".`);
      }
      return { role: message.role, content: String(message.content ?? "") };
    });
  }
  const prompt = request.prompt ?? "";
  if (!prompt.trim()) {
    throw new ExtensionLlmError("bad-request", "A completion requires `messages` or a non-empty `prompt`.");
  }
  return [{ role: "user", content: prompt }];
}

/**
 * Run one extension completion and attribute it.
 *
 * Usage is recorded here, not by the caller: the tracker is in hand, so there is no signature through
 * which a caller could forget it. A failure that already reported usage is still recorded before the
 * error propagates.
 */
export async function completeExtensionQuery(
  host: ExtensionCompletionHost,
  extensionId: string,
  request: ExtensionLlmRequest
): Promise<ExtensionLlmResult> {
  const messages = normalizeMessages(request);
  const adapter = await resolveAdapter(host, request.model?.trim() || undefined);
  host.consumeExtensionBudget(extensionId);

  const maxOutputTokens =
    request.maxOutputTokens ?? host.getExtensionMaxOutputTokens?.() ?? DEFAULT_EXTENSION_MAX_OUTPUT_TOKENS;
  const signal = request.signal ?? host.getExtensionSignal();

  try {
    const result = await runSideTextQuery(adapter, {
      ...(request.system ? { systemPrompt: request.system } : {}),
      // Keep the single-prompt shape for the common case (it is what the port's callers and the
      // text-mode contract rendering are written against); a multi-message conversation goes through
      // `messages`.
      ...(request.messages && request.messages.length > 0 ? { messages } : { userPrompt: messages[0]!.content }),
      ...(request.schema ? { schema: request.schema } : {}),
      maxOutputTokens,
      ...(signal ? { abortSignal: signal } : {}),
      ...(host.log ? { log: host.log } : {}),
    });

    if ("usage" in result && result.usage) host.usage.addTotal(result.usage);
    host.log?.info("side-query", `extension completion (${extensionId})`, {
      model: request.model?.trim() || host.getExtensionModel(),
      maxOutputTokens,
      ...("usage" in result && result.usage ? { usage: result.usage } : {}),
    });

    return "data" in result ? { data: result.data } : { text: result.text };
  } catch (error) {
    // A structured call can fail AFTER the provider billed it (validation, missing completion event).
    // The port attaches that usage to the thrown error so it can still be attributed; without this, a
    // failing extension call would be the one LLM call a session never pays for.
    const billed = (error as { usage?: Parameters<UsageTracker["addTotal"]>[0] }).usage;
    if (billed) host.usage.addTotal(billed);
    throw error;
  }
}

/**
 * Copy a model-visible message list so an extension cannot mutate the run's wire.
 *
 * Content parts are shared with the UI channel by design (the durability rule forbids rewriting
 * them), so a shallow array copy is not enough: a part object mutated by an extension would be
 * persisted on the next save.
 */
export function copyModelMessages<T extends { content: unknown }>(messages: readonly T[]): T[] {
  return messages.map((message) => {
    const content = message.content;
    if (Array.isArray(content)) {
      return { ...message, content: content.map((part) => (part && typeof part === "object" ? { ...part } : part)) };
    }
    return { ...message };
  });
}
