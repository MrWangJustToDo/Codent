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

import type { AgentLog } from "../agent/agent-log";
import type { ResolvedCoreEnv } from "../env";
import type { AgentManager } from "./agent-manager.js";
import type { ManagedAgent, ManagedAgentConfig } from "./managed-agent.js";
import type { AnyServerTool } from "@tanstack/ai";

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
  log: AgentLog;
  getDefaultSkillDirs: (env?: ResolvedCoreEnv) => Promise<SkillDirectory[]>;
}

export class AgentBootstrap {
  constructor(private readonly deps: AgentBootstrapOptions) {}

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
    const { managed, config, env, rootPath, log } = this.deps;
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
        log.warn("agent", `Instruction file could not be read: ${failedPath} (${errorMessage(error)})`);
      }
    }

    // One-time gate for the session-retrieval section (root agents only, like the agent doc).
    await managed.primeSessionHistoryGate();
    // A broken `@` reference would otherwise be invisible: the file loads fine, just without the
    // imported content. Surface it.
    for (const notice of docResult.importNotices) {
      log.warn("agent", `Instruction import: ${notice}`);
    }
    report.doc = {
      source: docResult.source ?? "",
      length,
      importNotices: [...docResult.importNotices],
    };
  }

  private async loadSkills(report: BootstrapReport): Promise<SkillRegistry> {
    const { managed, config, env, rootPath, log } = this.deps;
    const skillsConfig = typeof config.skills === "object" && config.skills !== null ? config.skills : undefined;

    const skillRegistry = new SkillRegistry({
      rootPath,
      env,
      logger: { warn: (message) => log.warn("system", message) },
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
    await memoryManager.initialize();
    managed.setMemoryManager(memoryManager);
    report.memory = { enabled: true };
  }

  private async loadExtensions(report: BootstrapReport, skillRegistry: SkillRegistry): Promise<void> {
    const { managed, config, env, rootPath, log, manager } = this.deps;
    const extensionRunner = new ExtensionRunner({
      onRegisterTool: (def, ownerId, rank) => managed.registerTool(def, ownerId, rank, { publishCatalog: false }),
      onUnregisterTool: (name, ownerId) => managed.unregisterExtensionTool(name, ownerId),
      // Live run/session facts and one-shot model access for extensions (`ctx.signal`,
      // `ctx.getMessages()`, `ctx.llm`). A function because every fact is per run.
      getRuntime: () => managed.getExtensionRuntime(),
      onRegisterToolOutputDecorator: (name, decorator, ownerId) =>
        managed.registerToolOutputDecorator(name, decorator, ownerId),
      onRemoveToolOutputDecoratorOwner: (ownerId) => managed.removeToolOutputDecoratorOwner(ownerId),
      onToolRegistrationBatchComplete: () => managed.publishToolPresentationCatalog(),
      onToolRegistrationComplete: () => managed.publishToolPresentationCatalog(),
      cwd: rootPath,
      agentId: managed.id,
      getCoreEnv: () => env,
      eventBus: manager.of(managed.id, undefined),
      log,
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

    const extensionDirs = await getDefaultExtensionDirs(config.extensionDirs, env);
    log.debug("system", "Extension search directories", { dirs: extensionDirs });

    const fromDisk = await extensionLoader.loadFromDirectories(extensionDirs);
    for (const err of fromDisk.errors) {
      recordExtensionError(report, "disk", err);
      log.warn("system", err.message);
    }
    for (const api of fromDisk.loaded) {
      const instance = await extensionRunner.loadExtension(api);
      if (!recordExtensionResult(report, api.id, instance)) {
        log.warn(
          "system",
          `Extension failed to activate from disk "${api.id}": ${instance.error?.message ?? "unknown"}`
        );
      }
    }

    if (config.extensions && config.extensions.length > 0) {
      for (const factory of config.extensions) {
        try {
          const api = await factory.create();
          const instance = await extensionRunner.loadExtension(api);
          if (!recordExtensionResult(report, api.id, instance)) {
            log.warn(
              "system",
              `Extension failed to activate from config "${api.id}": ${instance.error?.message ?? "unknown"}`
            );
          }
        } catch (err) {
          recordExtensionError(report, "config", err);
          log.warn("system", `Failed to load extension from config: ${err}`);
        }
      }
    }

    // Built-in LSP extension (enabled unless explicitly disabled).
    if (config.lsp !== false) {
      try {
        const lspOptions = typeof config.lsp === "object" && config.lsp !== null ? config.lsp : undefined;
        const instance = await extensionRunner.loadExtension(createLspExtension(lspOptions));
        if (!recordExtensionResult(report, "codent-lsp", instance)) {
          log.warn(
            "system",
            `Built-in extension failed to activate "codent-lsp": ${instance.error?.message ?? "unknown"}`
          );
        }
      } catch (err) {
        recordExtensionError(report, "codent-lsp", err);
        log.warn("system", `Failed to load built-in LSP extension: ${err}`);
      }
    }

    // Built-in Skills extension (enabled unless explicitly disabled).
    if (config.skills !== false && skillRegistry) {
      try {
        const skillsConfig = typeof config.skills === "object" && config.skills !== null ? config.skills : undefined;
        const instance = await extensionRunner.loadExtension(
          createSkillsExtension({ skillRegistry, config: skillsConfig })
        );
        if (!recordExtensionResult(report, "codent-skills", instance)) {
          log.warn(
            "system",
            `Built-in extension failed to activate "codent-skills": ${instance.error?.message ?? "unknown"}`
          );
        }
      } catch (err) {
        recordExtensionError(report, "codent-skills", err);
        log.warn("system", `Failed to load built-in Skills extension: ${err}`);
      }
    }

    // Built-in Memory extension (enabled unless explicitly disabled).
    if (config.memory !== false) {
      try {
        const memoryManager = managed.getMemoryManager();
        if (memoryManager) {
          const memoryConfig = typeof config.memory === "object" && config.memory !== null ? config.memory : undefined;
          const instance = await extensionRunner.loadExtension(
            createMemoryExtension({ memoryManager, config: memoryConfig })
          );
          if (!recordExtensionResult(report, "codent-memory", instance)) {
            log.warn(
              "system",
              `Built-in extension failed to activate "codent-memory": ${instance.error?.message ?? "unknown"}`
            );
          }
        }
      } catch (err) {
        recordExtensionError(report, "codent-memory", err);
        log.warn("system", `Failed to load built-in Memory extension: ${err}`);
      }
    }

    // Built-in Jobs extension. Pure presentation (no tools, no turn-context text).
    try {
      const instance = await extensionRunner.loadExtension(createJobsExtension());
      if (!recordExtensionResult(report, "codent-jobs", instance)) {
        log.warn(
          "system",
          `Built-in extension failed to activate "codent-jobs": ${instance.error?.message ?? "unknown"}`
        );
      }
    } catch (err) {
      recordExtensionError(report, "codent-jobs", err);
      log.warn("system", `Failed to load built-in Jobs extension: ${err}`);
    }

    // Built-in MCP extension (enabled unless explicitly disabled).
    if (config.mcp !== false) {
      try {
        const mcpManager = managed.getMcpManager();
        if (mcpManager) {
          const mcpConfig: McpExtensionConfig | undefined =
            typeof config.mcp === "object" && config.mcp !== null ? config.mcp : undefined;
          const instance = await extensionRunner.loadExtension(
            createMcpExtension({
              mcpManager,
              configPath: mcpConfig?.configPath ?? config.mcpConfigPath,
              // Session-supplied servers win over the file (see `mcpConfigFromServers`).
              servers: mcpConfigFromServers(config.mcpServers),
            })
          );
          if (!recordExtensionResult(report, "codent-mcp", instance)) {
            log.warn(
              "system",
              `Built-in extension failed to activate "codent-mcp": ${instance.error?.message ?? "unknown"}`
            );
          }
        }
      } catch (err) {
        recordExtensionError(report, "codent-mcp", err);
        log.warn("system", `Failed to load built-in MCP extension: ${err}`);
      }
    }

    // Built-in Code Mode extension (enabled unless explicitly disabled).
    if (config.codeMode !== false) {
      try {
        const codeModeConfig =
          typeof config.codeMode === "object" && config.codeMode !== null ? config.codeMode : undefined;
        const instance = await extensionRunner.loadExtension(
          createCodeModeExtension({
            tools: codeModeTools,
            lazyToolNames: codeModeLazyNames,
            timeout: codeModeConfig?.timeout,
            memoryLimit: codeModeConfig?.memoryLimit,
            lazyToolsConfig: codeModeConfig?.lazyToolsConfig,
            allowApprovalTools: codeModeConfig?.allowApprovalTools,
          })
        );
        if (!recordExtensionResult(report, "codent-code-mode", instance)) {
          log.warn(
            "system",
            `Built-in extension failed to activate "codent-code-mode": ${instance.error?.message ?? "unknown"}`
          );
        }
      } catch (err) {
        recordExtensionError(report, "codent-code-mode", err);
        log.warn("system", `Failed to load built-in Code Mode extension: ${err}`);
      }
    }
  }

  private logSummary(report: BootstrapReport): void {
    const { active, failed } = report.extensions;
    this.deps.log.info(
      "system",
      `Bootstrap complete: ${active} extensions active` + (failed > 0 ? `, ${failed} failed` : "")
    );
  }
}
