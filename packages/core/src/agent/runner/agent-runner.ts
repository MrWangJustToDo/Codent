import { chat, maxIterations } from "@tanstack/ai";

import { getEnv } from "../../env";
import { maxTokensOption } from "../../models/max-tokens-option.js";
import { toTanStackReasoningLevel } from "../../models/types.js";
import { DEFAULT_AGENT_MAX_ITERATIONS } from "../../runtime-types/agent-limits.js";
import { assertAsyncIterable } from "../stream/assert-async-iterable.js";

import { createToolRunContext, type ToolRunContext } from "./run-context.js";

import type { ResolvedCoreEnv } from "../../env";
import type { ModelStyle } from "../../models/config/model-config.js";
import type { ReasoningEffort } from "../../models/types.js";
import type {
  AnyTextAdapter,
  ChatMiddleware,
  LazyToolsConfig,
  ModelMessage,
  ServerTool,
  StreamChunk,
  UIMessage,
  SystemPrompt,
} from "@tanstack/ai";

// ============================================================================
// Types
// ============================================================================

export interface AgentRunnerConfig {
  adapter: AnyTextAdapter;
  /** Model id (informational — already bound on the adapter from {@link createTextAdapter}). */
  model: string;
  maxIterations?: number;
  systemPrompts?: Array<SystemPrompt>;
  tools?: ServerTool[];
  middleware?: ChatMiddleware<ToolRunContext>[];
  temperature?: number;
  maxOutputTokens?: number;
  /**
   * Reasoning effort level to send on every request through TanStack's unified
   * `chat({ reasoning })` option. Our historical `"none"` maps to `"off"`.
   * Undefined → model default.
   */
  reasoningEffort?: ReasoningEffort;
  /** API style — selects the provider-specific token-cap field. */
  modelStyle?: ModelStyle;
  /**
   * Workspace env for this run's tool context. The owning runtime's env when bound;
   * omitted (→ ambient `getEnv()`) for the unwired/legacy path.
   */
  coreEnv?: ResolvedCoreEnv;
  /**
   * Optional lazy-tool discovery config. Only used when some tool is `lazy: true`;
   * tunes how much of each lazy tool's description appears in the discovery catalog.
   * Defaults to `{ includeDescription: 'none' }` (library side).
   */
  lazyToolsConfig?: LazyToolsConfig;
}

export interface AgentRunnerRunInput {
  messages?: Array<UIMessage | ModelMessage>;
  /**
   * Run-scoped output cap, read at call time. A `max_tokens` recovery raises this for its
   * retry stream without mutating the runner's long-lived config (see
   * `RunCoordinator.maxOutputTokensOverride`).
   */
  maxOutputTokens?: number;
  /**
   * Preferred: the same AbortController identity owned by {@link ManagedAgent.run}.
   * `ManagedAgent.abort()` must abort this controller to cancel TanStack `chat()`.
   * Managed run paths (chat pump, subagent, recovery) MUST pass this — the
   * controller comes from `RunCoordinator` (`prepareForRun`), the single
   * creation point for run abort controllers.
   */
  abortController?: AbortController;
  /**
   * Fallback only: when `abortController` is omitted, create a fresh controller and
   * link this signal. Requires {@link AgentRunnerRunInput.detached} — a runner-created
   * controller is the historical "double AbortController" bug shape (cancel fired one
   * controller while `chat()` listened to another) and must never be reachable from
   * the managed run path.
   */
  abortSignal?: AbortSignal;
  /**
   * Explicit opt-in for ad-hoc `AgentRunner` callers without a `RunCoordinator`
   * (dev scripts, probes). Creates a detached controller linked to `abortSignal`.
   * MUST NOT be set by managed run paths — they pass `abortController` instead.
   */
  detached?: boolean;
  threadId?: string;
  runId?: string;
  agentId: string;
}

// ============================================================================
// AgentRunner
// ============================================================================

/**
 * Lightweight TanStack `chat()` wrapper. Holds immutable configuration only —
 * no status, session, memory, or usage state between runs.
 */
export class AgentRunner {
  private readonly config: AgentRunnerConfig;

  constructor(config: AgentRunnerConfig) {
    this.config = config;
  }

  /**
   * Resolve the AbortController passed to TanStack `chat()`.
   *
   * Managed run paths MUST pass the coordinator-owned `abortController`. A
   * runner-created controller (the historical "double AbortController" bug
   * shape) requires the explicit `detached: true` opt-in.
   */
  static resolveAbortController(
    input: Pick<AgentRunnerRunInput, "abortController" | "abortSignal" | "detached">
  ): AbortController {
    if (input.abortController) {
      return input.abortController;
    }

    if (!input.detached) {
      throw new Error(
        "AgentRunner.run requires an owner AbortController on managed run paths " +
          "(RunCoordinator is the single creation point). Pass `detached: true` " +
          "only for ad-hoc, non-managed usage."
      );
    }

    const abortController = new AbortController();
    if (input.abortSignal) {
      if (input.abortSignal.aborted) {
        abortController.abort(input.abortSignal.reason);
      } else {
        input.abortSignal.addEventListener("abort", () => abortController.abort(input.abortSignal!.reason), {
          once: true,
        });
      }
    }
    return abortController;
  }

  /** Execute one agent run and yield AG-UI stream chunks. */
  run(input: AgentRunnerRunInput): AsyncIterable<StreamChunk> {
    const abortController = AgentRunner.resolveAbortController(input);

    const toolContext = createToolRunContext(input.agentId, this.config.coreEnv ?? getEnv());

    const stream = chat({
      adapter: this.config.adapter,
      messages: input.messages,
      systemPrompts: this.config.systemPrompts,
      tools: this.config.tools,
      middleware: this.config.middleware,
      context: toolContext,
      abortController,
      threadId: input.threadId,
      runId: input.runId,
      agentLoopStrategy: maxIterations(this.config.maxIterations ?? DEFAULT_AGENT_MAX_ITERATIONS),
      lazyToolsConfig: this.config.lazyToolsConfig,
      // Silence [tanstack-ai:errors] console dumps — they break Ink TUI layout.
      // Failures still surface via RUN_ERROR / agent:stream-error / ManagedAgent.error.
      debug: false,
      // Preserve the pre-0.69 cache behavior while our prompt-cache middleware owns the
      // provider-specific markers. 0.69 turned TanStack's automatic cache on by default.
      promptCache: "none",
      ...(this.config.reasoningEffort ? { reasoning: toTanStackReasoningLevel(this.config.reasoningEffort) } : {}),
      modelOptions: {
        ...(this.config.temperature != null ? { temperature: this.config.temperature } : {}),
        ...maxTokensOption(this.config.modelStyle, input.maxOutputTokens ?? this.config.maxOutputTokens),
      },
    });

    assertAsyncIterable(stream, `chat(model=${this.config.model})`);
    return stream;
  }
}
