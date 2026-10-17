/**
 * @codent/acp — agent-side Agent Client Protocol host for Codent.
 *
 * Exposes an `AgentSessionHost` over ACP (stdio) so editors (Zed/JetBrains) and
 * ACP→IM bridges can drive the agent without any Codent-specific host code.
 */

export {
  createAcpAgent,
  runAcpAgentStdio,
  type AcpAgentOptions,
  type AcpAgentDefaults,
  type AcpClientEnvFactoryContext,
  type AcpSessionRuntime,
} from "./agent.js";
export { DEFAULT_SESSION_PAGE_SIZE, decodeCursor, encodeCursor, paginateSessions, toSessionInfo } from "./sessions.js";
export { resolveRoot, toWirePath } from "./paths.js";
export { legacySessionModelState, sessionConfigOptions } from "./session-config-options.js";
export { mapAcpMcpServers } from "./mcp.js";
export { isClientOwnedApproval, type PendingApproval, type ApprovalToolInput } from "./approvals.js";
export {
  createAcpClientEnv,
  isLocalOnlyPath,
  type AcpClientEnv,
  type AcpClientCapabilities,
  type AcpClientEnvOptions,
} from "./client-env.js";
export { bootstrapLocalAcp, bootstrapAcpAgent, type LocalAcpBootstrap, type AcpModelOverride } from "./bootstrap.js";
export { AcpProjector, type AcpProjectorOptions } from "./projector.js";
export { promptBlocksToContent, textBlock, type PromptCaps, type PromptMapping } from "./content.js";
export {
  toolCallInfo,
  toolKindFor,
  toolTitleFor,
  toolLocationsFor,
  toolDiffFor,
  toolStatusFor,
  toolResultText,
} from "./tools.js";
export {
  commandsFromSnapshot,
  parseSlashCommand,
  dispatchSlashCommand,
  type ParsedCommand,
  type SlashResult,
} from "./commands.js";
export {
  permissionOptions,
  mapPermissionOutcome,
  buildElicitationRequest,
  mapElicitationResponse,
  type ApprovalDecision,
  type AskUserInteraction,
  type ElicitedAnswer,
} from "./permissions.js";
