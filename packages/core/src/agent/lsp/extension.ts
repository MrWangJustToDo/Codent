/**
 * Built-in LSP extension — brings Language Server Protocol intelligence to the agent.
 *
 * Provides:
 * - 8 LSP tools: lsp_diagnostics, lsp_hover, lsp_definition, lsp_references,
 *   lsp_symbols, lsp_rename, lsp_completions, lsp_code_actions
 * - 3 commands: /lsp, /lsp-restart, /lsp-config
 * - Auto file-sync (didOpen/didChange) after read/write/edit
 * - Auto-diagnostics injection into write/edit tool results
 * - 3 tree-sitter tools: code_overview, ast_search, code_rewrite (Phase 7)
 *
 * Runtime-agnostic: the JSON-RPC transport comes from `CoreEnv.createLspConnection`
 * (Node-only). When absent, LSP tools degrade gracefully.
 */

import { DISCOVERY_TOOL_NAME } from "@tanstack/ai";

import { defaultPath } from "../../env";
import { truncateText } from "../../utils/text-truncation.js";
import { BUILTIN_TOOL_NAMES } from "../tools/catalog/tool-names.js";
import { TreeSitterManager, type TreeSitterEnv } from "../tree-sitter/parser-manager.js";
import { WorkspaceIndex } from "../tree-sitter/workspace-index.js";

import { registerLspCommands } from "./commands.js";
import { registerFileSyncInterceptors } from "./file-sync-interceptors.js";
import { FileSync } from "./file-sync.js";
import { getLanguageIdFromPath } from "./language-map.js";
import { LspManager, type LspFailureKind } from "./lsp-manager.js";
import { loadProjectConfig, type ProjectLspConfig } from "./project-config.js";
import { registerLspTools } from "./toolset.js";

import type { ExtensionAPI, ExtensionContext, ExtensionUI } from "../extension/types.js";

/**
 * Fine-grained configuration for the built-in LSP extension.
 *
 * By default the extension registers all tools except the low-usage set in
 * {@link DEFAULT_DISABLED_LSP_TOOLS} (opt-in). `enableAll` re-enables every tool.
 */
export interface LspExtensionConfig {
  /**
   * Tool names to skip registering (e.g. `"lsp_rename"`, `"ast_search"`).
   * Defaults to {@link DEFAULT_DISABLED_LSP_TOOLS}. Setting this replaces the
   * default (no automatic merge).
   */
  disabledTools?: string[];
  /** Re-enable all tools (overrides `disabledTools`). */
  enableAll?: boolean;
}

/**
 * LSP / tree-sitter tools that are skipped by default to save per-turn context.
 * These are the lowest-usage tools — re-enable with `enableAll: true` or by
 * listing them in `disabledTools` (i.e. not disabling them).
 */
export const DEFAULT_DISABLED_LSP_TOOLS: readonly string[] = [
  BUILTIN_TOOL_NAMES.lspRename,
  BUILTIN_TOOL_NAMES.lspCodeActions,
  BUILTIN_TOOL_NAMES.astSearch,
  BUILTIN_TOOL_NAMES.codeRewrite,
  BUILTIN_TOOL_NAMES.codeOverview,
];

const NOT_FOUND_ON_PATH = /not found on PATH/i;

/**
 * One line for a notice, collapsed to a single line; the full reason goes to the log.
 *
 * Truncation itself is `truncateText` (the shared helper) — a hand-rolled `slice` here is what
 * `validate:no-inline-char-truncation` exists to catch.
 */
function shortReason(error: string | undefined, max = 120): string {
  const text = (error ?? "unknown error").replace(/\s+/g, " ").trim();
  return truncateText(text, max);
}

/** What to show for a server that did not become ready. */
export interface ServerFailureDisplay {
  /** `silent` = log only: the state is not terminal, so nothing belongs in the UI. */
  level: "info" | "error" | "silent";
  text: string;
}

/**
 * Decide how a non-ready server is surfaced, from the manager's failure KIND.
 *
 * Pure and exported so the rule is assertable without standing up a server. Three of the four kinds are
 * not failures of the server — a missing binary is a documented degrade (tree-sitter takes over), a
 * withdrawn startup is a race with session shutdown, and an attempt with a retry still scheduled is work
 * in progress — so reporting them as errors is what makes a startup that then succeeds read as
 * "failed, then ready". `restart_pending` is log-only for the same reason the "starting" stages are
 * silent: the UI is for terminal states.
 *
 * The message fallback for the missing binary stays: a spawn that reports ENOENT is the same degrade
 * even when it arrives wrapped by the eager-auto-start path.
 */
export function classifyServerFailure(error: string | undefined, kind: LspFailureKind): ServerFailureDisplay {
  if (kind === "restart_pending") return { level: "silent", text: "" };
  if (kind === "command_missing" || (error !== undefined && NOT_FOUND_ON_PATH.test(error))) {
    return { level: "info", text: "unavailable (command not found)" };
  }
  if (kind === "start_abandoned") return { level: "info", text: "start withdrawn (the session was closing)" };
  return { level: "error", text: `failed: ${shortReason(error)}` };
}

function notifyServerFailure(
  ui: ExtensionUI,
  logger: ExtensionContext["logger"],
  languageId: string,
  error: string | undefined,
  kind: LspFailureKind
): void {
  const display = classifyServerFailure(error, kind);
  const detail = error ? ` — ${error}` : "";
  if (display.level === "silent") {
    logger.warn(`LSP: ${languageId} restart attempt failed, another is scheduled${detail}`);
    return;
  }
  logger[display.level === "error" ? "warn" : "info"](`LSP: ${languageId} ${display.text}${detail}`);
  ui.notify(`LSP: ${languageId} ${display.text}`, display.level);
}

/**
 * Emit an LSP lifecycle notification for one server. Only terminal states are
 * surfaced (success / failure); the in-between "starting / restarting" stages
 * are intentionally silent so the transient input feedback is not serialized
 * into an error→loading→success flicker. A server binary missing on PATH is a
 * predictable degrade (falls back to tree-sitter), so it is reported as `info`
 * rather than `error`.
 */
function notifyServerLifecycle(
  ui: ExtensionUI,
  logger: ExtensionContext["logger"],
  languageId: string,
  status: "ready" | "failed" | "crashed",
  error?: string,
  kind: LspFailureKind = "start_failed"
): void {
  switch (status) {
    case "ready":
      logger.info(`LSP: ${languageId} ready`);
      ui.notify(`LSP: ${languageId} ready`, "success");
      break;
    case "crashed":
      logger.warn(`LSP: ${languageId} crashed`);
      ui.notify(`LSP: ${languageId} crashed`, "error");
      break;
    case "failed":
      notifyServerFailure(ui, logger, languageId, error, kind);
      break;
  }
}

/** Create the built-in LSP extension. */
export function createLspExtension(options?: LspExtensionConfig): ExtensionAPI {
  let shutdownCurrent: (() => Promise<void>) | undefined;
  let shutdownTreeSitter: (() => void) | undefined;
  return {
    id: "codent-lsp",
    name: "LSP Integration",
    version: "1.0.0",
    description:
      "Language Server Protocol tools: diagnostics, hover, definition, references, symbols, rename, completions, code actions + auto file-sync",
    async activate(ctx) {
      await activateLsp(
        ctx,
        options,
        (manager) => {
          // The manager is swapped on session:start; this closure always points at the
          // one the extension currently owns, so deactivate never shuts down a stale one.
          shutdownCurrent = () => manager.shutdownAll().catch(() => {});
        },
        (treeSitter) => {
          shutdownTreeSitter = () => treeSitter.shutdown();
        }
      );
    },
    async deactivate() {
      const shutdown = shutdownCurrent;
      const shutdownTs = shutdownTreeSitter;
      shutdownCurrent = undefined;
      shutdownTreeSitter = undefined;
      await shutdown?.();
      shutdownTs?.();
    },
  };
}

async function activateLsp(
  ctx: ExtensionContext,
  options?: LspExtensionConfig,
  onManager?: (manager: LspManager) => void,
  onTreeSitter?: (treeSitter: TreeSitterManager) => void
): Promise<void> {
  const env = ctx.coreEnv;
  const corePath = env.path ?? defaultPath;
  const createConnection = env.createLspConnection;

  // Resolve the set of tools to skip registering (saves per-turn context).
  const enableAll = options?.enableAll === true;
  const disabledTools = enableAll
    ? new Set<string>()
    : new Set<string>(options?.disabledTools ?? DEFAULT_DISABLED_LSP_TOOLS);

  // Feature-detect: if the host has no process/stdio runtime, LSP tools degrade.
  if (!createConnection) {
    ctx.logger.warn("LSP: host has no createLspConnection — LSP tools will be unavailable");
  }

  // ---- Auto-diagnostics passthrough decorator (Phase 6 hardening) ----
  // `maybeInjectDiagnostics` appends `_lspDiagnostics` to write/edit tool results.
  // Those tools' own `toModelOutput` rebuild the model-facing text from a few
  // fields, which would drop the summary on the next turn. Decorate the base
  // handlers so the summary survives the `onConfig` / tool-compact rewrite.
  const AUTO_DIAG_TOOLS = [BUILTIN_TOOL_NAMES.writeFile, BUILTIN_TOOL_NAMES.editFile] as const;
  for (const toolName of AUTO_DIAG_TOOLS) {
    ctx.registerToolOutputDecorator(toolName, async (ctx, next) => {
      const base = await next(ctx);
      const output = ctx.output as Record<string, unknown> | undefined;
      const diag = output?._lspDiagnostics;
      if (typeof diag !== "string" || diag.length === 0) return base;

      const suffix = `\n\n${diag}`;
      if (typeof base === "string") return base + suffix;
      if (Array.isArray(base)) {
        return [...base, { type: "text" as const, content: suffix }];
      }
      return base;
    });
  }

  // ---- Runtime access from CoreEnv ----
  const pathHelpers = {
    join: (...parts: string[]) => corePath.join(...parts),
    resolve: (...parts: string[]) => corePath.resolve(...parts),
    relative: (from: string, to: string) => {
      // Best-effort relative (CoreEnv has no relative; emulate via resolve prefix)
      const toAbs = corePath.resolve(to);
      const fromAbs = corePath.resolve(from);
      if (toAbs.startsWith(fromAbs)) {
        return toAbs.slice(fromAbs.length).replace(/^[/\\]/, "") || ".";
      }
      return toAbs;
    },
  };

  const fsHelpers = {
    existsSync: async (p: string) => {
      try {
        await env.fs.stat(p);
        return true;
      } catch {
        return false;
      }
    },
    exists: async (p: string) => {
      try {
        await env.fs.stat(p);
        return true;
      } catch {
        return false;
      }
    },
    readFile: (p: string) => env.fs.readFile(p, "utf-8") as Promise<string>,
    readdir: async (p: string) => {
      const entries = await env.fs.readdir(p);
      return entries.map((e) => ({
        name: e.name,
        isDirectory: e.type === "directory",
        isFile: e.type === "file",
      }));
    },
  };

  const runtimeEnv = await env.getEnv().catch(() => ({}) as Record<string, string | undefined>);
  const getEnvVar = (key: string) => runtimeEnv[key];

  // ---- Tree-sitter layer (runtime-agnostic via injected env) ----
  const treeSitterEnv: TreeSitterEnv = {
    readFile: (p) => env.fs.readFile(p, "utf-8") as Promise<string>,
    writeFile: (p, content) => env.fs.writeFile(p, content),
    readdir: async (p) => {
      const entries = await env.fs.readdir(p);
      return entries.map((e) => ({
        name: e.name,
        isDirectory: e.type === "directory",
        isFile: e.type === "file",
      }));
    },
    stat: async (p) => {
      const s = await env.fs.stat(p);
      return { size: s.size };
    },
    resolve: (...parts: string[]) => corePath.resolve(...parts),
    locateGrammar: env.locateTreeSitterGrammar,
  };
  const treeSitter = new TreeSitterManager(treeSitterEnv, getLanguageIdFromPath);
  onTreeSitter?.(treeSitter);
  const workspaceIndex = new WorkspaceIndex(ctx.cwd, treeSitter, treeSitterEnv);
  if (treeSitter.available()) {
    treeSitter.init().catch((err) => {
      ctx.logger.warn(`LSP: tree-sitter WASM init failed: ${err}`);
    });
  } else {
    ctx.logger.warn("LSP: no tree-sitter grammar locator — tree-sitter tools will be unavailable");
  }

  // ---- LspManager ----
  const rootDir = ctx.cwd;
  const manager = new LspManager(
    rootDir,
    (config) => {
      if (!createConnection) throw new Error("Current environment does not support LSP (no createLspConnection)");
      return createConnection(config);
    },
    pathHelpers,
    fsHelpers,
    undefined,
    {
      // Only terminal states are surfaced (success / failure); the transient
      // starting / restarting stages stay silent so the input feedback is not
      // serialized into an error→loading→success flicker.
      onServerReady: (languageId) => {
        notifyServerLifecycle(ctx.ui, ctx.logger, languageId, "ready");
        // A write that landed while a server was starting had its sync deferred — send it now so its
        // diagnostics reach the next tool call. All of them: the server that just became ready may serve
        // several language ids, and the deferred write may belong to one of the others.
        void fileSync.flushAllPendingSync().catch(() => {});
      },
      onServerError: (languageId, error, kind) =>
        notifyServerLifecycle(ctx.ui, ctx.logger, languageId, "failed", error, kind),
      onServerCrash: (languageId) => notifyServerLifecycle(ctx.ui, ctx.logger, languageId, "crashed"),
    },
    getEnvVar,
    env.commandExists
  );
  onManager?.(manager);

  const fileSync = new FileSync(manager, fsHelpers);

  // ---- Project config (.lsp.json) ----
  let projectConfig: ProjectLspConfig | null = await loadProjectConfig(ctx, manager);
  if (projectConfig?.autoStart?.length) {
    manager.startEagerly(projectConfig.autoStart);
  }

  // Tools resolve the manager lazily so session:start can swap it.
  let activeManager: LspManager = manager;
  const getManager = () => activeManager;
  const shouldRegister = (name: string): boolean => !disabledTools.has(name);

  registerLspTools({ ctx, getManager, treeSitter, treeSitterEnv, workspaceIndex, fileSync, shouldRegister });
  registerLspCommands({ ctx, getManager });
  registerFileSyncInterceptors({
    ctx,
    getManager,
    fileSync,
    getProjectConfig: () => projectConfig,
  });

  // ---- Session lifecycle ----
  ctx.registerInterceptor("session:start", async (event) => {
    const payload = (event as { payload?: { cwd?: string } }).payload;
    if (!payload?.cwd) return;
    const newRoot = corePath.resolve(payload.cwd);
    // The bootstrap `session:start` uses the same cwd that activate() just set up. Rebuilding
    // there starts every eager language server twice (and loses the first diagnostics window).
    if (corePath.resolve(getManager().resolvePath(".")) === newRoot) return;

    // Shut down the old manager before swapping.
    await getManager()
      .shutdownAll()
      .catch(() => {});

    const newManager = new LspManager(
      newRoot,
      (config) => {
        if (!createConnection) throw new Error("Current environment does not support LSP");
        return createConnection(config);
      },
      pathHelpers,
      fsHelpers,
      undefined,
      {
        onServerReady: (l) => {
          notifyServerLifecycle(ctx.ui, ctx.logger, l, "ready");
          // Deferred syncs belong to whichever manager is active now — and to every language id the
          // server that just came up serves.
          void fileSync.flushAllPendingSync().catch(() => {});
        },
        onServerError: (l, error, kind) => notifyServerLifecycle(ctx.ui, ctx.logger, l, "failed", error, kind),
        onServerCrash: (l) => notifyServerLifecycle(ctx.ui, ctx.logger, l, "crashed"),
      },
      getEnvVar,
      env.commandExists
    );
    activeManager = newManager;
    onManager?.(newManager);
    fileSync.setManager(newManager);
    const cfg = await loadProjectConfig(ctx, newManager);
    projectConfig = cfg;
    if (cfg?.autoStart?.length) newManager.startEagerly(cfg.autoStart);
  });

  ctx.registerInterceptor("session:shutdown", async () => {
    await getManager()
      .shutdownAll()
      .catch(() => {});
    treeSitter.shutdown();
  });

  // ---- Turn-context provider (Phase 8): light LSP guidance ----
  // Advertise code-intelligence tools only when usable in this host. Diagnostics /
  // hover / definition degrade to syntax-level tree-sitter fallbacks when no LSP
  // runtime exists; completions has no fallback, so it requires `createLspConnection`.
  // Disabled tools (disabledTools) are never advertised. When nothing is usable we
  // register no provider, so the model is not misled into calling dead tools.
  const lspRuntimeAvailable = Boolean(createConnection);
  const tsFallbackAvailable = treeSitter.available();
  // Eager tools are advertised as directly callable; lazy ones need discovery.
  const advertisedEager: string[] = [];
  const advertisedLazy: string[] = [];
  const pushAdvertised = (name: string, available: boolean) => {
    if (!shouldRegister(name) || !available) return;
    if (name === BUILTIN_TOOL_NAMES.lspDiagnostics) advertisedEager.push(name);
    else advertisedLazy.push(name);
  };
  pushAdvertised(BUILTIN_TOOL_NAMES.lspDiagnostics, lspRuntimeAvailable || tsFallbackAvailable);
  pushAdvertised("lsp_hover", lspRuntimeAvailable || tsFallbackAvailable);
  pushAdvertised("lsp_definition", lspRuntimeAvailable || tsFallbackAvailable);
  pushAdvertised("lsp_completions", lspRuntimeAvailable);

  if (advertisedEager.length > 0 || advertisedLazy.length > 0) {
    const scope = lspRuntimeAvailable ? "LSP" : "Code (tree-sitter fallback)";
    const errorKind = lspRuntimeAvailable ? "compile errors" : "syntax errors";
    const parts: string[] = [];
    if (advertisedEager.length > 0) parts.push(`${advertisedEager.join(", ")} is always available`);
    if (advertisedLazy.length > 0)
      parts.push(
        `${advertisedLazy.join(", ")} are lazy tools — discover them via ${DISCOVERY_TOOL_NAME} before calling`
      );
    const guidance = `${scope} tools: ${parts.join("; ")}. After editing code, call lsp_diagnostics to check for ${errorKind}.`;
    ctx.registerContextProvider({
      content: () => guidance,
      disabledContent: () =>
        "LSP integration is disabled — language tooling (diagnostics, hover, definition, references, rename, completions) and auto file-sync are unavailable.",
    });
  }

  ctx.logger.info("LSP extension activated");
}
