/**
 * The execution context an extension tool receives.
 *
 * Split out of `types.ts` (which is at the lint file-size ceiling): this block is a self-contained
 * contract consumed by `registerTool`, and it has no dependency on the extension lifecycle types.
 */

import type { ResolvedCoreEnv } from "../../env";

/**
 * Execution options handed to a registered tool.
 *
 * Mirrored from `@tanstack/ai` rather than re-exported: the framework's options are an
 * implementation detail, and this surface adds the runtime fields (`coreEnv`, `agentId`) a tool
 * needs without exposing the engine's own type.
 */
export interface ToolExecutionOptions {
  toolCallId: string;
  /**
   * The RUN's abort signal — aborted only when the run is stopped (user / parent), never by the
   * tool's own `timeoutMs`. Classify a caught error against THIS signal to decide "cancelled".
   */
  abortSignal?: AbortSignal;
  /**
   * The run signal composed with the extension tool's declared `timeoutMs`.
   *
   * Aborts on a run abort OR on deadline expiry (its reason is then `ExecutionError("timeout")`),
   * so pass it to cancellable work (fetch). Present only when the tool declared `timeoutMs`.
   * Deliberately separate from {@link abortSignal}: classifying with this signal would read a
   * timeout as a cancel (`isAbortError` short-circuits on `signal.aborted`).
   */
  deadlineSignal?: AbortSignal;
  /**
   * The deadline the tool declared (`timeoutMs`), when it has one.
   *
   * Present only on the execution context the framework builds; a tool that declared no deadline
   * sees `undefined`. Useful for reporting the budget without re-reading its own definition.
   */
  timeoutMs?: number;
  /**
   * Id of the agent running this tool call.
   *
   * Supplied by the run context (`ToolRunContext.agentId`) — the authoritative value, since
   * this same tool set is served to a subagent's runs too. A tool that keys per-agent
   * resources (caches, sandboxes) must use THIS id, not the registration-time one. Hosts
   * that register tools without a run context fall back to the registering agent's id.
   */
  agentId?: string;
  /**
   * The owning runtime's workspace env (with defaults resolved).
   *
   * Present whenever the call came from a run (`defineServerTool` resolves it from the
   * `ToolRunContext`). A tool that executes ANOTHER tool — code-mode's `external_*` bindings are
   * the shipped case — must forward this to that call. Without it the nested tool falls back to
   * the process-ambient env, which is the wrong workspace in a multi-runtime process and throws
   * outright when no ambient env is registered.
   */
  coreEnv?: ResolvedCoreEnv;
}

export type ToolCallResult = Record<string, unknown>;
