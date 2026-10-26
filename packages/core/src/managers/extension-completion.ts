/**
 * Extension model access: the host half of `ctx.llm`.
 *
 * The extension API exposes a small, provider-free surface (`ExtensionLlm`); everything that makes a
 * completion *safe* lives here — the session's connection, the catalog check, usage attribution and
 * the per-run budget. Keeping it host-side is what lets an extension say "complete this" without
 * ever seeing a base URL, a key, or a tracker.
 */

import { ExtensionLlmError } from "../agent/extension/extension-llm-error.js";
import { createTextAdapter } from "../models/adapter/adapter-factory.js";
import { runSideTextQuery } from "../models/adapter/side-text-query.js";
import { DEFAULT_BASE_URLS, trimBaseURL } from "../models/config/model-config.js";
import { resolveModelInfoFromModelsDev } from "../models/config/models-config.js";
import { errorMessage } from "../utils/errors.js";

import type { UsageTracker } from "./telemetry/usage-tracker.js";
import type { AgentLog } from "../agent/agent-log/agent-log.js";
import type { ExtensionLlmRequest, ExtensionLlmResult } from "../agent/extension/context-access.js";
import type { TextAdapterConfig } from "../models/adapter/adapter-factory.js";
import type { LoadedModelEntry } from "../models/config/models-config.js";
import type { ModelInfo, ModelStyle } from "../models/types.js";

export { ExtensionLlmError, type ExtensionLlmErrorCode } from "../agent/extension/extension-llm-error.js";

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
  /**
   * Give one slot back after an attempt that was neither billed nor completed (a transport failure
   * before the provider answered). Without it, transient 502s exhaust the run's budget and the real
   * work never runs.
   */
  refundExtensionBudget?(): void;
  /** The effective model id the session is running. */
  getExtensionModel(): string | undefined;
  /** Per-agent output-token cap (a ceiling, not a default), when the host configured one. */
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
    return withTypedAdapterError(async () => (await host.resolveTextAdapter?.()) ?? null);
  }

  const entries = host.getExtensionCatalog();
  if (!entries || entries.length === 0) {
    throw new ExtensionLlmError(
      "unknown-model",
      `Cannot select model "${requestedModel}": this runtime has no model catalog to validate it against.`
    );
  }

  const connection = host.getExtensionConnection();
  const connectionBase = connection.baseURL ?? (connection.style ? DEFAULT_BASE_URLS[connection.style] : undefined);
  // EVERY entry offering the model, then the one on the session's connection. `find` alone made the
  // result depend on catalog order: a model listed by two entries was rejected whenever the first one
  // belonged to another provider, even though the session could run it.
  const candidates = entries.filter((entry) => entry.models.includes(requestedModel));
  if (candidates.length === 0) {
    throw new ExtensionLlmError(
      "unknown-model",
      `Model "${requestedModel}" is not offered by this session's catalog. Available: ${entries
        .flatMap((candidate) => candidate.models)
        .join(", ")}`
    );
  }
  const build = host.createExtensionAdapter ?? defaultCreateAdapter;
  const matches = candidates.filter(
    (candidate) =>
      connection.style !== undefined &&
      candidate.style === connection.style &&
      trimBaseURL(candidate.baseURL) === trimBaseURL(connectionBase ?? "") &&
      // A catalog entry may carry its own key (another account on the same endpoint). Using it would
      // break "one credential set": prefer the session's key, and treat an entry that names a
      // different one as a different connection.
      (!candidate.apiKey || !connection.apiKey || candidate.apiKey === connection.apiKey)
  );
  const entry = matches[0];
  if (!entry) {
    throw new ExtensionLlmError(
      "unknown-model",
      `Model "${requestedModel}" is only offered on a different connection than this session's; an extension may only use the session's own connection.`
    );
  }

  // Capability metadata (structured output, reasoning, pricing) is per model, not per connection: a
  // named model built without it silently loses the structured-output gate and is priced at the
  // session model's rate in one surface and its own in the other.
  const modelInfo = await resolveModelInfoFromModelsDev(requestedModel, entry.style).catch(() => undefined);

  return build({
    style: entry.style,
    model: requestedModel,
    baseURL: entry.baseURL,
    ...((entry.apiKey ?? connection.apiKey) ? { apiKey: entry.apiKey ?? connection.apiKey } : {}),
    ...(modelInfo ? { modelInfo } : {}),
  });
}

/** Build the default adapter for a catalog model (the shared factory, with model metadata). */
function defaultCreateAdapter(input: {
  style: ModelStyle;
  model: string;
  baseURL: string;
  apiKey?: string;
  modelInfo?: ModelInfo;
}): TextAdapterConfig {
  return createTextAdapter({
    style: input.style,
    model: input.model,
    baseURL: input.baseURL,
    ...(input.apiKey ? { apiKey: input.apiKey } : {}),
    ...(input.modelInfo ? { modelInfo: input.modelInfo } : {}),
  });
}

/**
 * Adapter resolution throws plain `Error`s for a missing connection ("no modelStyle configured",
 * "requires an API key"). An extension branches on `code`, so those become the typed no-adapter case.
 */
async function withTypedAdapterError(
  resolve: () => Promise<TextAdapterConfig | null | undefined>
): Promise<TextAdapterConfig> {
  let adapter: TextAdapterConfig | null | undefined;
  try {
    adapter = await resolve();
  } catch (error) {
    throw new ExtensionLlmError(
      "no-adapter",
      `This session has no usable model connection for an extension completion: ${errorMessage(error)}`
    );
  }
  if (!adapter) {
    throw new ExtensionLlmError(
      "no-adapter",
      "This session has no model connection to run an extension completion on."
    );
  }
  return adapter;
}

/** The reason a signal aborted, as a throwable (a bare `AbortSignal.reason` may be anything). */
function abortReason(signal: AbortSignal): Error {
  const reason = signal.reason;
  if (reason instanceof Error) return reason;
  const error = new Error(reason === undefined ? "The extension completion was aborted." : String(reason));
  error.name = "AbortError";
  return error;
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

  // A ceiling, not a default: a caller may ask for less, never for more than the host allows.
  const cap = host.getExtensionMaxOutputTokens?.() ?? DEFAULT_EXTENSION_MAX_OUTPUT_TOKENS;
  const maxOutputTokens = Math.min(request.maxOutputTokens ?? cap, cap);
  const signal = request.signal ?? host.getExtensionSignal();

  // A signal that is already aborted must not start a request at all: the run may have been cancelled
  // between the handler deciding to call and the call landing, and the adapter would otherwise issue
  // (and bill) a request nobody wants.
  if (signal?.aborted) throw abortReason(signal);

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

    // Price the model that ran, not the session's: a named catalog model can differ in rate, and the
    // usage-history row already uses this adapter's pricing — one call must not have two costs.
    if ("usage" in result && result.usage) host.usage.addTotal(result.usage, adapter.pricing ?? undefined);
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
    if (billed) {
      host.usage.addTotal(billed, adapter.pricing ?? undefined);
      host.log?.info("side-query", `extension completion failed after billing (${extensionId})`, {
        model: request.model?.trim() || host.getExtensionModel(),
        usage: billed,
      });
    } else {
      // Nothing was billed, so the slot goes back: a burst of transient failures must not spend the
      // run's allowance.
      host.refundExtensionBudget?.();
    }
    throw error;
  }
}
