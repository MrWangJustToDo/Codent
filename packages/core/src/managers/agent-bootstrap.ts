/**
 * Root-agent bootstrap: documentation, skills, MCP/memory resources and the extension host.
 *
 * This used to be one long branch in `agent-factory` with two independent extension counters. The
 * counters disagreed with each other: some loaders incremented "active" without reading the
 * instance state, others read the state but never incremented "failed". The report below is the
 * single accounting point, so `attempted === active + failed` is an invariant rather than a hope.
 */

import { CODE_MODE_LAZY_TOOL_NAMES, CODE_MODE_TOOL_NAMES, createCodeModeExtension } from "../agent/code-mode";
import { ExtensionLoader, ExtensionRunner, getDefaultExtensionDirs } from "../agent/extension";
import { createJobsExtension } from "../agent/jobs/extension.js";
import { createLspExtension } from "../agent/lsp";
import { createMcpExtension, mcpConfigFromServers, type McpExtensionConfig } from "../agent/mcp";
import { McpManager } from "../agent/mcp/manager.js";
import { createMemoryExtension } from "../agent/memory/extension.js";
import { MemoryManager } from "../agent/memory/memory-manager.js";
import { loadAgentDoc } from "../agent/prompt/agent-doc-loader.js";
import { BUILTIN_SKILLS } from "../agent/skills/builtin";
import { createSkillsExtension } from "../agent/skills/extension.js";
import { SkillRegistry, type SkillDirectory } from "../agent/skills/skill-registry.js";
import { createTaskTool } from "../agent/subagent/task-tool.js";
import { errorMessage } from "../utils/errors.js";

import type { ResolvedCoreEnv } from "../env";
import type { AgentManager } from "./agent-manager.js";
import type { ManagedAgent, ManagedAgentConfig } from "./managed-agent.js";
import type { AgentEventPayloadMap, SessionDiagnosticArea } from "../runtime-types/agent-event-payloads.js";
import type { AgentEventType } from "../runtime-types/agent-events.js";
import type { AnyServerTool } from "@tanstack/ai";

/** Phases a bootstrap-time extension failure can be attributed to. */
type AgentExtensionErrorPhase = "load" | "config" | "disk";

export interface BootstrapExtensionFailure {
  /** Extension id when known, otherwise the load site label. */
  id: string;
  error: string;
}

export interface BootstrapExtensionReport {
  attempted: number;
  active: number;
  failed: number;
  failures: BootstrapExtensionFailure[];
}

export interface BootstrapReport {
  extensions: BootstrapExtensionReport;
  doc?: { source: string; length: number; importNotices: string[] };
  skills?: { count: number };
  memory?: { enabled: boolean };
}

export function createBootstrapReport(): BootstrapReport {
  return { extensions: { attempted: 0, active: 0, failed: 0, failures: [] } };
}

/** Account for a loader result. Fail-open activation errors count as failures. */
export function recordExtensionResult(
  report: BootstrapReport,
  label: string,
  instance: { id?: string; state: string; error?: { message?: string } }
): boolean {
  const extensions = report.extensions;
  extensions.attempted += 1;
  if (instance.state === "active") {
    extensions.active += 1;
    return true;
  }
  extensions.failed += 1;
  extensions.failures.push({
    id: instance.id ?? label,
    error: instance.error?.message ?? "unknown",
  });
  return false;
}

/** Account for a load that threw before producing an instance (disk/config/builtin factory). */
export function recordExtensionError(report: BootstrapReport, label: string, error: unknown): void {
  const extensions = report.extensions;
  extensions.attempted += 1;
  extensions.failed += 1;
  extensions.failures.push({ id: label, error: errorMessage(error) });
}

export interface AgentBootstrapOptions {
  managed: ManagedAgent;
  config: ManagedAgentConfig;
  env: ResolvedCoreEnv;
  rootPath: string;
  manager: AgentManager;
  getDefaultSkillDirs: (env?: ResolvedCoreEnv) => Promise<SkillDirectory[]>;
}

export class AgentBootstrap {
  constructor(private readonly deps: AgentBootstrapOptions) {}

  /**
   * Bootstrap runs before the agent is registered, so every fact it records must be an event.
   *
   * Three carriers cover all of it: a degraded-but-not-fatal step (`session:diagnostic`),
   * a failure the extension runner cannot see yet (module load / factory throw →
   * `agent:extension-error`), and the aggregated report (`session:bootstrap-summary`).
   */
  private emitEvent<T extends AgentEventType>(type: T, payload: AgentEventPayloadMap[T]): void {
    this.deps.managed.emitEvent(type, payload);
  }

  /**
   * A bootstrap step that degraded but did not fail.
   *
   * Level stays at the diagnostic default (`warn`): the policy owns the scale, and every caller here
   * is reporting something the user would otherwise never learn (a doc that did not load, a memory
   * store that stayed empty).
   */
  private warnBootstrap(area: SessionDiagnosticArea, message: string): void {
    this.emitEvent("session:diagnostic", { area, message, level: "warn" });
  }

  /**
   * A failure the extension runner cannot report yet (module import, factory throw, activate before
   * the instance exists).
   *
   * `extensionId` is optional on purpose: a file that failed to import has no id yet, and inventing
   * one ("disk"/"config") put a sentinel where the formatter prints an extension name. The phase
   * already says where it happened.
   */
  private extensionError(phase: AgentExtensionErrorPhase, error: string, extensionId?: string): void {
    this.emitEvent("agent:extension-error", {
      phase,
      error,
      ...(extensionId ? { extensionId } : {}),
    });
  }

  async bootstrapRoot(): Promise<BootstrapReport> {
    const report = createBootstrapReport();
    await this.loadDocumentation(report);
    const skillRegistry = await this.loadSkills(report);
    this.loadMcp();
    await this.loadMemory(report);
    await this.loadExtensions(report, skillRegistry);
    this.logSummary(report);
    return report;
  }

  private async loadDocumentation(report: BootstrapReport): Promise<void> {
    const { managed, config, env, rootPath } = this.deps;
    const docResult = await loadAgentDoc({
      rootPath,
      filenames: config.agentDocFilenames,
      loadOverride: config.agentDocLoadOverride !== false,
      env,
    });

    let length = 0;
    if (docResult.content) {
      const instructions = docResult.overrideContent
        ? `${docResult.content}\n\n## Local Override\n\n${docResult.overrideContent}`
        : docResult.content;
      length = instructions.length;
      managed.setAgentDocContent(instructions, docResult.source);
    } else if (docResult.readErrors?.length) {
      // The file exists but could not be read — a refusing client, a sandbox, a broken mount. Say it
      // out loud: without this the session simply has no project instructions and nothing explains
      // why, which is indistinguishable from "the project has no AGENTS.md".
      for (const { path: failedPath, error } of docResult.readErrors) {
        this.warnBootstrap("doc", `Instruction file could not be read: ${failedPath} (${errorMessage(error)})`);
      }
    }

    // One-time gate for the session-retrieval section (root agents only, like the agent doc).
    await managed.primeSessionHistoryGate();
    // A broken `@` reference would otherwise be invisible: the file loads fine, just without the
    // imported content. Surface it.
    for (const notice of docResult.importNotices) {
      this.warnBootstrap("doc", `Instruction import: ${notice}`);
    }
    report.doc = {
      source: docResult.source ?? "",
      length,
      importNotices: [...docResult.importNotices],
    };
  }

  private async loadSkills(report: BootstrapReport): Promise<SkillRegistry> {
    const { managed, config, env, rootPath } = this.deps;
    const skillsConfig = typeof config.skills === "object" && config.skills !== null ? config.skills : undefined;

    const skillRegistry = new SkillRegistry({
      rootPath,
      env,
      logger: { warn: (message) => this.warnBootstrap("skill", message) },
    });
    managed.setSkillRegistry(skillRegistry);

    const dirsToLoad: SkillDirectory[] = config.skillDirs
      ? config.skillDirs.map((path) => ({ path, source: "project" as const }))
      : await this.deps.getDefaultSkillDirs(env);
    await skillRegistry.loadFromDirectories(dirsToLoad);

    // Built-ins are registered LAST so every directory skill keeps priority — the bundled defaults
    // must never shadow a skill the user wrote. (Opposite of extension discovery, where later dirs win.)
    if (skillsConfig?.builtinsDisabled !== true) {
      skillRegistry.registerAll(BUILTIN_SKILLS);
    }

    managed.tools.task = createTaskTool({ parentAgentId: managed.id, manager: this.deps.manager });
    report.skills = { count: skillRegistry.size };
    return skillRegistry;
  }

  private loadMcp(): void {
    // Created (but not connected) here — connection + tool registration happens in the built-in MCP
    // extension, so MCP participates in the unified extension lifecycle.
    const mcpManager = new McpManager(this.deps.env);
    this.deps.managed.setMcpManager(mcpManager);
  }

  private async loadMemory(report: BootstrapReport): Promise<void> {
    const { managed, config, env, rootPath } = this.deps;
    if (config.memory === false) {
      report.memory = { enabled: false };
      return;
    }
    const memoryManager = new MemoryManager({ rootPath, env });
    try {
      await memoryManager.initialize();
    } catch (error) {
      // `.agents/memory` is not guaranteed writable (read-only mount, restricted remote fs).
      // Every other bootstrap resource degrades; memory used to abort the whole agent, which
      // made an unwritable cache directory fatal to a conversation that never needed it.
      this.warnBootstrap("memory", `Memory initialization failed; continuing without memory: ${errorMessage(error)}`);
      report.memory = { enabled: false };
      return;
    }
    managed.setMemoryManager(memoryManager);
    report.memory = { enabled: true };
  }

  private async loadExtensions(report: BootstrapReport, skillRegistry: SkillRegistry): Promise<void> {
    const { managed, config, env, rootPath, manager } = this.deps;
    const publishTools = (): void => {
      managed.publishToolPresentationCatalog();
    };
    const extensionRunner = new ExtensionRunner({
      onRegisterTool: (def, ownerId, rank) => managed.registerTool(def, ownerId, rank, { publishCatalog: false }),
      // The batch callback below publishes the catalog once, so per-name removal must not.
      onUnregisterTool: (name, ownerId) => managed.unregisterExtensionTool(name, ownerId, { publishCatalog: false }),
      // Live run/session facts and one-shot model access for extensions (`ctx.signal`,
      // `ctx.getMessages()`, `ctx.llm`). A function because every fact is per run.
      getRuntime: () => managed.getExtensionRuntime(),
      onRegisterToolOutputDecorator: (name, decorator, ownerId) =>
        managed.registerToolOutputDecorator(name, decorator, ownerId),
      onRemoveToolOutputDecoratorOwner: (ownerId) => managed.removeToolOutputDecoratorOwner(ownerId),
      onToolRegistrationBatchComplete: publishTools,
      onToolRegistrationComplete: publishTools,
      cwd: rootPath,
      agentId: managed.id,
      getCoreEnv: () => env,
      eventBus: manager.of(managed.id, undefined),
    });
    managed.extensions.setExtensionRunner(extensionRunner);

    const extensionLoader = new ExtensionLoader(env);
    managed.extensions.setExtensionLoader(extensionLoader);

    // Snapshot the built-in bindings before user extensions load. Code Mode's external_* bindings
    // are static for the lifetime of an isolate; a later extension that shadows `read_file` or
    // `run_command` must not silently become the implementation used inside the sandbox (and must
    // not resurrect a previously-disabled override).
    const codeModeTools = CODE_MODE_TOOL_NAMES.map((name) => managed.tools[name]).filter(
      (tool): tool is AnyServerTool => Boolean(tool && "execute" in tool)
    );
    const codeModeLazyNames = [...CODE_MODE_LAZY_TOOL_NAMES];

    // Disk extensions are process-local code (`import()` in THIS process) discovered through this
    // env's fs (paths on the WORKSPACE machine). With a remote workspace those are two different
    // machines, so every discovered file is ENOENT — or, if the client happens to have the same
    // path, an unrelated local file runs while the workspace is elsewhere. Skip discovery rather
    // than report a pile of phantom load failures. In-process extensions still load below.
    if (env.remote === true) {
      this.warnBootstrap(
        "extension",
        "Skipping disk extension discovery: a remote workspace's extension files cannot be imported in the " +
          "client process. Load extensions in-process (config.extensions) instead."
      );
    } else {
      const extensionDirs = await getDefaultExtensionDirs(config.extensionDirs, env);
      // "Why is my extension not loaded" needs the list we actually searched. It used to be a
      // direct debug log and was dropped by the convergence; `details.dirs` keeps it greppable.
      this.emitEvent("session:diagnostic", {
        area: "extension",
        level: "debug",
        message: "Extension search directories",
        details: { dirs: extensionDirs.join(", ") },
      });

      const fromDisk = await extensionLoader.loadFromDirectories(extensionDirs);
      for (const err of fromDisk.errors) {
        recordExtensionError(report, "disk", err);
        // No instance exists for a module that failed to import, so the runner cannot report it.
        this.extensionError("disk", err.message);
      }
      for (const api of fromDisk.loaded) {
        // The runner emits `agent:extension-error` when `activate` throws; bootstrap only accounts.
        // The event is visible now because the log is bound before bootstrap (bindConstructionLog).
        recordExtensionResult(report, api.id, await extensionRunner.loadExtension(api));
      }
    }

    if (config.extensions && config.extensions.length > 0) {
      for (const factory of config.extensions) {
        try {
          const api = await factory.create();
          recordExtensionResult(report, api.id, await extensionRunner.loadExtension(api));
        } catch (err) {
          recordExtensionError(report, "config", err);
          this.extensionError("config", errorMessage(err));
        }
      }
    }

    // Built-in LSP extension (enabled unless explicitly disabled).
    if (config.lsp !== false) {
      try {
        const lspOptions = typeof config.lsp === "object" && config.lsp !== null ? config.lsp : undefined;
        recordExtensionResult(
          report,
          "codent-lsp",
          await extensionRunner.loadExtension(createLspExtension(lspOptions))
        );
      } catch (err) {
        recordExtensionError(report, "codent-lsp", err);
        this.extensionError("config", errorMessage(err), "codent-lsp");
      }
    }

    // Built-in Skills extension (enabled unless explicitly disabled).
    if (config.skills !== false && skillRegistry) {
      try {
        const skillsConfig = typeof config.skills === "object" && config.skills !== null ? config.skills : undefined;
        recordExtensionResult(
          report,
          "codent-skills",
          await extensionRunner.loadExtension(createSkillsExtension({ skillRegistry, config: skillsConfig }))
        );
      } catch (err) {
        recordExtensionError(report, "codent-skills", err);
        this.extensionError("config", errorMessage(err), "codent-skills");
      }
    }

    // Built-in Memory extension (enabled unless explicitly disabled).
    if (config.memory !== false) {
      try {
        const memoryManager = managed.getMemoryManager();
        if (memoryManager) {
          const memoryConfig = typeof config.memory === "object" && config.memory !== null ? config.memory : undefined;
          recordExtensionResult(
            report,
            "codent-memory",
            await extensionRunner.loadExtension(
              createMemoryExtension({
                memoryManager,
                // The owning agent's service: it owns the per-turn query, surfaced set and pending
                // commit, so a session switch resets them through the normal lifecycle hook.
                selection: managed.memory,
                ...(memoryConfig ? { config: memoryConfig } : {}),
              })
            )
          );
        }
      } catch (err) {
        recordExtensionError(report, "codent-memory", err);
        this.extensionError("config", errorMessage(err), "codent-memory");
      }
    }

    // Built-in Jobs extension. Pure presentation (no tools, no turn-context text).
    try {
      recordExtensionResult(report, "codent-jobs", await extensionRunner.loadExtension(createJobsExtension()));
    } catch (err) {
      recordExtensionError(report, "codent-jobs", err);
      this.extensionError("config", errorMessage(err), "codent-jobs");
    }

    // Built-in MCP extension (enabled unless explicitly disabled).
    if (config.mcp !== false) {
      try {
        const mcpManager = managed.getMcpManager();
        if (mcpManager) {
          const mcpConfig: McpExtensionConfig | undefined =
            typeof config.mcp === "object" && config.mcp !== null ? config.mcp : undefined;
          recordExtensionResult(
            report,
            "codent-mcp",
            await extensionRunner.loadExtension(
              createMcpExtension({
                mcpManager,
                configPath: mcpConfig?.configPath ?? config.mcpConfigPath,
                // Session-supplied servers win over the file (see `mcpConfigFromServers`).
                servers: mcpConfigFromServers(config.mcpServers),
              })
            )
          );
        }
      } catch (err) {
        recordExtensionError(report, "codent-mcp", err);
        this.extensionError("config", errorMessage(err), "codent-mcp");
      }
    }

    // Built-in Code Mode extension (enabled unless explicitly disabled).
    if (config.codeMode !== false) {
      try {
        const codeModeConfig =
          typeof config.codeMode === "object" && config.codeMode !== null ? config.codeMode : undefined;
        recordExtensionResult(
          report,
          "codent-code-mode",
          await extensionRunner.loadExtension(
            createCodeModeExtension({
              tools: codeModeTools,
              lazyToolNames: codeModeLazyNames,
              timeout: codeModeConfig?.timeout,
              memoryLimit: codeModeConfig?.memoryLimit,
              lazyToolsConfig: codeModeConfig?.lazyToolsConfig,
              allowApprovalTools: codeModeConfig?.allowApprovalTools,
            })
          )
        );
      } catch (err) {
        recordExtensionError(report, "codent-code-mode", err);
        this.extensionError("config", errorMessage(err), "codent-code-mode");
      }
    }
  }

  /** The one aggregated bootstrap row: how many extensions were attempted, live and failed. */
  private logSummary(report: BootstrapReport): void {
    const { attempted, active, failed } = report.extensions;
    this.emitEvent("session:bootstrap-summary", { attempted, active, failed });
  }
}
