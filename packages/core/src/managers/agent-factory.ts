import { AgentLog } from "../agent/agent-log";
import { createCompactionConfig } from "../agent/compaction/types.js";
import { SessionStore } from "../agent/persistence/session-store.js";
import { TodoManager } from "../agent/todo";
import { getEnv, type ResolvedCoreEnv } from "../env";
import { AGENT_PROFILE_IDS } from "../runtime-types/agent-profile.js";

import { AgentBootstrap, type BootstrapReport } from "./agent-bootstrap.js";
import { ManagedAgent, type ManagedAgentConfig } from "./managed-agent.js";
import { resolveTextAdapterForManaged } from "./run-agent.js";
import { buildToolset } from "./toolset-factory.js";

import type { AgentManager } from "./agent-manager.js";
import type { SessionBootstrapContext } from "./session-bootstrap-events.js";
import type { SkillDirectory } from "../agent/skills/skill-registry.js";
import type { AgentRuntime } from "../runtime/agent-runtime.js";

export interface BuildManagedAgentResult {
  managed: ManagedAgent;
  bootstrap?: SessionBootstrapContext;
}

export interface BuildManagedAgentOptions {
  config: ManagedAgentConfig;
  parentId?: string;
  manager: AgentManager;
  getDefaultSkillDirs: (env?: ResolvedCoreEnv) => Promise<SkillDirectory[]>;
  /** Runtime this agent belongs to (env + provider); undefined = ambient. */
  runtime?: AgentRuntime;
  /**
   * Id core assigned when it — not a host — chose one (a spawned `task` subagent). Absent for a root
   * agent, which gets a minted id.
   */
  id?: string;
}

/**
 * Construct and wire a {@link ManagedAgent} (tools, skills, MCP, memory, extensions, session).
 * Registry and parent linking remain the caller's responsibility.
 */
export async function buildManagedAgent({
  config,
  parentId,
  manager,
  getDefaultSkillDirs,
  runtime,
  id,
}: BuildManagedAgentOptions): Promise<BuildManagedAgentResult> {
  const {
    modelInfo: explicitModelInfo,
    name,
    skillDirs,
    compaction,
    mcpConfigPath,
    mcpServers,
    initialSessionId,
    ...restConfig
  } = config;

  const resolvedModelInfo = explicitModelInfo ?? null;
  // The runtime's env when bound; ambient otherwise (legacy single-instance hosts).
  const coreEnv = runtime?.env ?? getEnv();
  const fsRootPath = coreEnv.rootPath;
  const profileId = config.profileId ?? (parentId ? "explore" : "root");
  const toolsetProfile = config.toolsetProfile ?? profileId;
  if (!(AGENT_PROFILE_IDS as readonly string[]).includes(profileId)) {
    throw new Error(`Unknown agent profile: "${profileId}"`);
  }
  if (!(AGENT_PROFILE_IDS as readonly string[]).includes(toolsetProfile)) {
    throw new Error(`Unknown toolset profile: "${toolsetProfile}"`);
  }
  if (profileId === "general" || toolsetProfile === "general") {
    // Defined for the shared kernel, but its host opt-in and child approval routing are deferred.
    throw new Error("The general agent profile is not enabled");
  }
  if (profileId !== toolsetProfile) {
    throw new Error(`Agent profile "${profileId}" requires the "${profileId}" toolset, got "${toolsetProfile}"`);
  }
  if (!parentId && toolsetProfile !== "root") {
    throw new Error(`Root agents require the root toolset, got "${toolsetProfile}"`);
  }
  if (parentId && toolsetProfile === "root") {
    throw new Error("Child agents cannot use the root toolset");
  }
  const log = new AgentLog({ scope: { profile: profileId } });
  const todoManager = parentId ? null : new TodoManager();

  const managed = new ManagedAgent(
    // `modelInfo` is destructured out above, so it must be put back explicitly: the
    // resolved metadata is not reconstruction-able from `restConfig`, and a subagent
    // inherits its parent's stored config rather than re-resolving the model. Dropping
    // it left every subagent's usage tracker without pricing (`$0` at record time).
    { ...restConfig, toolsetProfile, profileId, ...(explicitModelInfo ? { modelInfo: explicitModelInfo } : {}), name },
    {
      id,
      log,
      tools: {},
      todoManager,
      parentId,
      ...(runtime ? { runtime } : {}),
    }
  );

  const toolsRecord = { ...(await buildToolset({ profile: toolsetProfile, managed })) };
  managed.tools = toolsRecord;
  managed.runtime = runtime;
  managed.resolveTextAdapter = () => resolveTextAdapterForManaged(managed);
  // Scoped unified event bus for this agent. Routes session-channel projections
  // AND telemetry `dispatchEvent` (up-flows to the root observer / Event→Log bridge).
  managed.setEventBus(manager.of(managed.id, parentId));

  if (resolvedModelInfo) {
    managed.setModelInfo(resolvedModelInfo);
    if (resolvedModelInfo.pricing) {
      managed.usage.setPricing(resolvedModelInfo.pricing);
    }
    managed.usage.setCapabilities(resolvedModelInfo.capabilities);
  }

  managed.setLog(log);

  let bootstrapReport: BootstrapReport | undefined;

  if (!parentId) {
    const compactionInput = { ...compaction };
    if (!compactionInput?.tokenThreshold && resolvedModelInfo?.contextWindow) {
      // NOTE: MAX_THRESHOLD caps the compaction trigger threshold, NOT the model's context window.
      // The model itself (e.g. DeepSeek V4 Flash) may support up to 1M tokens, but the UI
      // displays tokenLimit (== compaction tokenThreshold) — so users see e.g. "80%/400k"
      // instead of "32%/1M". The 400k cap is a deliberate middle ground: large-window
      // models (400k–1M) still compact well before deep-context attention degradation,
      // while windows <= 400k use their full size (times compactAtPercent). Increase or
      // remove this cap if you want the UI to show the real model context window.
      const MAX_THRESHOLD = 400_000;
      compactionInput.tokenThreshold = Math.min(resolvedModelInfo.contextWindow, MAX_THRESHOLD);
    }
    managed.setCompactionConfig(createCompactionConfig(compactionInput));
  }

  if (!parentId) {
    bootstrapReport = await new AgentBootstrap({
      managed,
      config,
      env: coreEnv,
      rootPath: fsRootPath,
      manager,
      log,
      getDefaultSkillDirs,
    }).bootstrapRoot();
  }

  if (!parentId) {
    const sessionStore = new SessionStore(coreEnv);
    managed.setSessionStore(sessionStore, {
      modelStyle: config.modelStyle ?? resolvedModelInfo?.style ?? "openai",
      model: restConfig.model,
    });
    // Adopt a pre-resolved restore target's id BEFORE the log sink attaches
    // (`createManagedAgent`), so bootstrap entries land in the reused session's
    // log dir instead of a transient id. The full restore runs later in the host.
    if (initialSessionId) {
      const restored = await sessionStore.load(initialSessionId);
      if (restored) managed.setSessionData(restored);
    }
  }

  managed.name = name;

  let bootstrap: SessionBootstrapContext | undefined;
  if (!parentId) {
    bootstrap = { cwd: fsRootPath, report: bootstrapReport! };
  }

  return { managed, bootstrap };
}
