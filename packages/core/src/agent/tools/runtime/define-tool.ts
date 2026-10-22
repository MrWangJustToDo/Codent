import { toolDefinition, type InferSchemaType, type SchemaInput, type ServerTool, type ClientTool } from "@tanstack/ai";

import { getAmbientEnv } from "../../../env/ambient.js";
import { withTimeoutAbort } from "../util/abort-timeout.js";

import type { ModelToolContent, ToModelOutputContext, ToModelOutputFn } from "./model-output.js";
import type { ResolvedCoreEnv } from "../../../env";
import type { ToolRunContext } from "../../runner/run-context.js";
import type { ToolPresentation } from "../presentation/types.js";

/** Per-tool metadata attached to the live tool object, independent of the process registries. */
export interface ToolMetadata {
  present?: ToolPresentation;
  toModelOutput?: ToModelOutputFn;
}

const toolMetadata = new WeakMap<object, ToolMetadata>();

/** Read the agent-local metadata attached by {@link defineServerTool} / {@link defineClientTool}. */
export function getToolMetadata(tool: unknown): ToolMetadata | undefined {
  return typeof tool === "object" && tool !== null ? toolMetadata.get(tool) : undefined;
}

// ============================================================================
// Tool execute context (maps TanStack ToolExecutionContext)
// ============================================================================

export interface ToolExecuteCtx {
  toolCallId: string;
  /**
   * The RUN's abort signal — aborted only when the run is stopped (user / parent), never by the
   * tool's own `timeoutMs`. Classify a caught error against THIS signal
   * (`isAbortError(err, ctx.abortSignal)`) to decide "cancelled": it stays live across a deadline
   * expiry, so a timeout is not misread as a user cancel.
   */
  abortSignal?: AbortSignal;
  /**
   * The run signal composed with the tool's declared {@link defineServerTool} `timeoutMs`.
   *
   * Aborts on a run abort OR on deadline expiry (its reason is then `ExecutionError("timeout")`),
   * so pass it to cancellable work (fetch). Present only when the tool declared a deadline.
   * Deliberately separate from {@link abortSignal}: a body that classified with this signal would
   * read a timeout as a cancel because `isAbortError` short-circuits on `signal.aborted`.
   */
  deadlineSignal?: AbortSignal;
  /** Managed agent id from {@link ToolRunContext} when available. */
  agentId?: string;
  /**
   * Workspace env for this run (the owning runtime's CoreEnv). Tools read the environment
   * from here instead of the process-global `getEnv()`. Falls back to the ambient env only
   * when a tool is executed without a run context (direct/ad-hoc calls in tests).
   */
  coreEnv: ResolvedCoreEnv;
  /** The tool's declared deadline, when it has one (see {@link defineServerTool} `timeoutMs`). */
  timeoutMs?: number;
}

export type { ModelToolContent, ToModelOutputContext, ToModelOutputFn };
export { isProjectedModelContent } from "./projected-model-content.js";

// ============================================================================
// Factories
// ============================================================================

/**
 * Define a TanStack server tool with a stable {@link ToolExecuteCtx} shape.
 */
export function defineServerTool<
  TInput extends SchemaInput,
  TOutput extends SchemaInput,
  const TName extends string,
>(config: {
  name: TName;
  description: string;
  inputSchema?: TInput;
  outputSchema?: TOutput;
  needsApproval?: boolean;
  /**
   * Optional execution deadline. When declared, the runtime enforces it around {@link execute}
   * and passes the body a signal that aborts when the deadline elapses (see
   * {@link withTimeoutAbort}).
   *
   * Opt-in: a tool with no `timeoutMs` is unbounded, so long-running tools are unaffected. A
   * deadline is a typed failure (`ExecutionError("timeout")`), never a user cancel; a run abort
   * still settles as cancelled because the run signal is consulted first.
   */
  timeoutMs?: number;
  /**
   * Lazy tools are excluded from the initial request; the model discovers them
   * by name via the synthetic `__lazy__tool__discovery__` tool and gets the full
   * schema on demand. Keeps low-usage tools available without per-turn token cost.
   */
  lazy?: boolean;
  execute: (
    args: InferSchemaType<TInput>,
    ctx: ToolExecuteCtx
  ) => Promise<InferSchemaType<TOutput>> | InferSchemaType<TOutput>;
  /**
   * Format the persisted tool output for the LLM wire.
   *
   * MUST be a pure function of the persisted output: the tool-compact cache is
   * cleared on session restore (`restoreManagedSession`), after which history
   * tool messages are re-derived. Any non-deterministic content (timestamps,
   * random truncation, wall-clock state) would silently change the wire prefix
   * and invalidate prompt cache for restored sessions.
   */
  toModelOutput?: (
    ctx: ToModelOutputContext & { input: InferSchemaType<TInput>; output: InferSchemaType<TOutput> }
  ) => Promise<ModelToolContent> | ModelToolContent;
  /**
   * How this tool is presented: fold category, keep-row / detailed / client-side
   * flags, header summary, input label, and the result-text renderer (`text`).
   *
   * Declared here rather than in a host-side table because core owns the tools and may
   * run in another process (remote CoreEnv / Agent Session / extension host). Core
   * renders it once at tool completion and ships the result with the message, so every
   * function MUST be pure — a function of the persisted output (or parsed input) only,
   * for the same reason as {@link toModelOutput}.
   */
  present?: ToolPresentation;
}): ServerTool<TInput, TOutput, TName> {
  const modelOutput: ToModelOutputFn | undefined = config.toModelOutput
    ? (ctx) =>
        config.toModelOutput!({
          toolCallId: ctx.toolCallId,
          input: ctx.input as InferSchemaType<TInput>,
          output: ctx.output as InferSchemaType<TOutput>,
        })
    : undefined;

  const serverTool = toolDefinition({
    name: config.name,
    description: config.description,
    inputSchema: config.inputSchema,
    outputSchema: config.outputSchema,
    needsApproval: config.needsApproval,
    lazy: config.lazy,
  }).server(async (args, ctx) => {
    const runContext = ctx?.context as ToolRunContext | undefined;
    const execCtx: ToolExecuteCtx = {
      toolCallId: ctx?.toolCallId ?? "",
      abortSignal: ctx?.abortSignal,
      agentId: runContext?.agentId,
      // The run context carries the owning runtime's env; ambient (lazy) only for ad-hoc calls.
      coreEnv: runContext?.coreEnv ?? getAmbientEnv(),
      timeoutMs: config.timeoutMs,
    };

    // No deadline declared: pass the run signal through untouched, byte-identical to before.
    if (config.timeoutMs === undefined) {
      return config.execute(args, execCtx);
    }

    // The deadline-linked signal is exposed as `deadlineSignal`, NOT `abortSignal`, so a body that
    // classifies a caught error with `isAbortError(err, ctx.abortSignal)` still reads a deadline
    // expiry as a failure (the run signal is live). `withTimeoutAbort` races the deadline
    // independently, so a body that ignores `deadlineSignal` is still bounded.
    return withTimeoutAbort((deadlineSignal) => config.execute(args, { ...execCtx, deadlineSignal }), {
      timeoutMs: config.timeoutMs,
      signal: ctx?.abortSignal,
      timeoutMessage: `Tool "${config.name}" timed out after ${config.timeoutMs}ms`,
    });
  }) as ServerTool<TInput, TOutput, TName>;

  // The live tool object carries its own metadata; the owning agent resolves it through
  // AgentToolService, so no process registry is involved.
  toolMetadata.set(serverTool, {
    ...(config.present ? { present: config.present } : {}),
    ...(modelOutput ? { toModelOutput: modelOutput } : {}),
  });
  return serverTool;
}

/**
 * Define a TanStack client tool (no server execute; UI supplies output).
 */
export function defineClientTool<
  TInput extends SchemaInput,
  TOutput extends SchemaInput,
  const TName extends string,
>(config: {
  name: TName;
  description: string;
  inputSchema?: TInput;
  outputSchema?: TOutput;
  needsApproval?: boolean;
  /** See {@link defineServerTool} `lazy` — lazy client tools are discovered on demand. */
  lazy?: boolean;
  /** See {@link defineServerTool} `present` — how the tool is displayed. */
  present?: ToolPresentation;
}): ClientTool<TInput, TOutput, TName> {
  const clientTool = toolDefinition({
    name: config.name,
    description: config.description,
    inputSchema: config.inputSchema,
    outputSchema: config.outputSchema,
    needsApproval: config.needsApproval,
    lazy: config.lazy,
  }).client() as ClientTool<TInput, TOutput, TName>;

  if (config.present) toolMetadata.set(clientTool, { present: config.present });
  return clientTool;
}
