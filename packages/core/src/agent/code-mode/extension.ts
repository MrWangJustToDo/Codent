/**
 * Built-in Code Mode extension — sandboxed TypeScript execution via
 * TanStack `ai-code-mode`.
 *
 * Provides:
 * - `execute_typescript` tool: run model-written TypeScript in a secure isolate,
 *   with a curated subset of agent tools exposed as `external_*` functions.
 * - `discover_tools` companion tool (only when some external tools are marked
 *   `lazy`), letting the model discover lazy tools on demand.
 * - Per-turn system-prompt guidance documenting the sandbox API + external_*
 *   bindings (progressive disclosure: lazy tools appear in a catalog, not as
 *   full type stubs).
 *
 * Binding names: every tool name is normalised to a legal JS identifier before it
 * reaches `createCodeMode` (see `binding-names.ts`). Upstream derives the binding
 * name verbatim, so a hyphenated name would otherwise emit an unusable stub — the
 * same bug fixed upstream in pi v0.99.2.
 *
 * Runtime-agnostic: the isolate backend is NOT imported here. The extension
 * feature-detects the optional CoreEnv capability `createIsolateDriver`. If the
 * host provides one (Node via `@tanstack/ai-isolate-node`, browser/WebContainer
 * hosts omit it), code mode is wired up; otherwise the extension degrades
 * gracefully (warns and registers nothing) with zero native deps in core.
 */
import { createCodeMode } from "@tanstack/ai-code-mode";

import { errorMessage } from "../../utils/errors.js";

import { normalizeBindingName, renameCodeModeTools } from "./binding-names.js";

import type { ExtensionAPI, ExtensionContext, ExtensionToolDefinition, ToolCallResult } from "../extension/types.js";
import type { AnyServerTool, LazyToolsConfig, SchemaInput } from "@tanstack/ai";
import type { CodeModeTool } from "@tanstack/ai-code-mode";

// ============================================================================
// Config
// ============================================================================

/** Fine-grained configuration for the built-in code-mode extension. */
export interface CodeModeExtensionConfig {
  /**
   * Curated subset of agent tools to expose as `external_*` functions inside
   * the sandbox. Only server tools with an `execute` implementation are valid.
   * Defaults to an empty array (extension degrades if none provided).
   */
  tools?: Array<AnyServerTool>;
  /**
   * Names among `tools` to mark `lazy: true`. Lazy tools are kept out of the
   * system prompt's full type-stub documentation and listed in a Discoverable
   * APIs catalog instead (surfaced on demand via `discover_tools`). This keeps
   * the system prompt small — only a curated eager subset gets full stubs.
   */
  lazyToolNames?: string[];
  /** Execution timeout in milliseconds (default: 30000). */
  timeout?: number;
  /** Memory limit for the isolate in MB (default: 128). */
  memoryLimit?: number;
  /** Optional lazy-tool discovery config (defaults to `{ includeDescription: 'none' }`). */
  lazyToolsConfig?: LazyToolsConfig;
  /** Hard-disable the extension regardless of driver availability. */
  disabled?: boolean;
}

// ============================================================================
// Upstream console suppression
// ============================================================================

/**
 * `@tanstack/ai-code-mode` logs every failed run with a bare `console.error`
 * (`create-code-mode-tool.js`: `if (!result.success) console.error('[code-mode] …', payload)`),
 * and its payload is a multi-line object dump. That write lands on the process stream
 * outside the renderer, so under the TUI it splices raw text into Ink's frame and
 * scrambles the display.
 *
 * The same information is already returned to the model inside the tool result and is
 * also emitted as the `code_mode:execution_finished` custom event, so the console write is
 * pure duplication. Capture it during the call and re-route it through the extension
 * logger (which converges into the agent log) instead of the terminal.
 *
 * The upstream `finish()` runs inside the awaited `execute`, so restoring in `finally`
 * cannot leave the global console patched — unlike a patch scoped to extension activation,
 * which would double-log the success path for every host process.
 */
function formatLogArgs(args: unknown[]): string {
  return args
    .map((arg) => {
      if (typeof arg === "string") return arg;
      try {
        return JSON.stringify(arg);
      } catch {
        return String(arg);
      }
    })
    .join(" ");
}

async function withoutCodeModeConsole<T>(log: ExtensionContext["logger"], run: () => Promise<T>): Promise<T> {
  const originalError = console.error;
  const originalInfo = console.info;
  console.error = (...args: unknown[]) => log.error(formatLogArgs(args));
  console.info = (...args: unknown[]) => log.info(formatLogArgs(args));
  try {
    return await run();
  } finally {
    console.error = originalError;
    console.info = originalInfo;
  }
}

// ============================================================================
// Extension factory
// ============================================================================

/**
 * Bridge a TanStack server tool into an {@link ExtensionToolDefinition} so it
 * can be registered through `ctx.registerTool` (which re-wraps via
 * `defineServerTool`). Preserves name/description/schemas/execute.
 */
function toExtensionTool(tool: AnyServerTool, log: ExtensionContext["logger"]): ExtensionToolDefinition {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: (tool.inputSchema ?? {}) as SchemaInput,
    outputSchema: tool.outputSchema as SchemaInput | undefined,
    execute: async (input, options) => {
      const signal = options.abortSignal;
      signal?.throwIfAborted();
      const run = tool.execute?.(input, {
        toolCallId: options.toolCallId,
        abortSignal: signal,
      });
      if (!run) return {} as ToolCallResult;
      if (!signal) return ((await withoutCodeModeConsole(log, () => run)) ?? {}) as ToolCallResult;

      // The upstream isolate tool (ai-code-mode) ignores the abort signal, so an
      // Esc would otherwise wait out the isolate timeout. Race it: reject the
      // tool call promptly on abort and let the isolate be disposed normally.
      let onAbort: (() => void) | undefined;
      try {
        const aborted = new Promise<never>((_, reject) => {
          onAbort = () => reject(signal.reason ?? new Error("Aborted"));
          signal.addEventListener("abort", onAbort, { once: true });
        });
        const result = await Promise.race([withoutCodeModeConsole(log, () => run), aborted]);
        return (result ?? {}) as ToolCallResult;
      } finally {
        if (onAbort) signal.removeEventListener("abort", onAbort);
      }
    },
  };
}

/**
 * Create the built-in code-mode extension. Load it via the extension runner in
 * agent-factory alongside LSP / Skills / Memory / MCP.
 */
export function createCodeModeExtension(options: CodeModeExtensionConfig = {}): ExtensionAPI {
  return {
    id: "codent-code-mode",
    name: "Code Mode",
    version: "1.0.0",
    description: "Sandboxed TypeScript execution (TanStack ai-code-mode)",

    async activate(ctx) {
      if (options.disabled) return;

      // Feature-detect the isolate backend (optional CoreEnv capability).
      let driver;
      try {
        driver = await ctx.coreEnv.createIsolateDriver?.();
      } catch (err) {
        ctx.logger.warn(`Code Mode disabled: createIsolateDriver failed — ${errorMessage(err)}`);
        return;
      }

      if (!driver) {
        ctx.logger.warn(
          "Code Mode disabled: no isolate driver provided by this host (CoreEnv.createIsolateDriver). execute_typescript not registered."
        );
        return;
      }

      const tools = options.tools ?? [];
      if (tools.length === 0) {
        ctx.logger.warn("Code Mode disabled: no external tools provided. execute_typescript not registered.");
        return;
      }

      // Mark the requested tools lazy so only the curated eager subset gets full
      // type stubs in the system prompt. Normalise binding names first (before the
      // lazy check keys off `t.name`), so the lazy set is expressed in the same
      // identifier space the sandbox actually exposes.
      const lazyNames = new Set((options.lazyToolNames ?? []).map(normalizeBindingName));
      const { tools: renamedTools, renames } = renameCodeModeTools(tools, ctx.logger);
      if (renames.size > 0) {
        ctx.logger.info(
          `Code Mode: normalised ${renames.size} binding name(s) to legal identifiers — ${[...renames]
            .map(([from, to]) => `${from} → ${to}`)
            .join(", ")}`
        );
      }
      const codeModeTools = renamedTools.map((t) =>
        lazyNames.has(t.name) ? { ...t, lazy: true } : t
      ) as Array<CodeModeTool>;

      const { tool, discoveryTool, systemPrompt } = createCodeMode({
        driver,
        tools: codeModeTools,
        timeout: options.timeout,
        memoryLimit: options.memoryLimit,
        lazyToolsConfig: options.lazyToolsConfig,
      });

      ctx.registerTool(toExtensionTool(tool, ctx.logger));
      if (discoveryTool) {
        ctx.registerTool(toExtensionTool(discoveryTool, ctx.logger));
      }

      // Inject code-mode guidance each turn as its own context section. Disabled
      // content keeps the model informed that the tools are gone.
      ctx.registerContextProvider({
        content: () => systemPrompt,
        disabledContent: () =>
          "Code Mode extension is disabled — sandboxed TypeScript execution (execute_typescript) is unavailable.",
      });
    },
  };
}
