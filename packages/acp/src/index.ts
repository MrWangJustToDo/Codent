/**
 * @codent/acp — agent-side Agent Client Protocol host for Codent.
 *
 * Exposes an `AgentSessionHost` over ACP (stdio) so editors (Zed/JetBrains) and
 * ACP→IM bridges can drive the agent without any Codent-specific host code.
 */

export {
  createAcpAgent,
  type AcpAgentOptions,
  type AcpAgentDefaults,
  type AcpClientEnvFactoryContext,
  type AcpSessionRuntime,
} from "./agent.js";
export { runAcpAgentStdio } from "./stdio.js";
export { DEFAULT_SESSION_PAGE_SIZE, decodeCursor, encodeCursor, paginateSessions, toSessionInfo } from "./sessions.js";
export { resolveRoot, toWirePath } from "./paths.js";
export {
  effortOf,
  legacySessionModelState,
  sessionConfigOptions,
  THOUGHT_LEVEL_DEFAULT,
} from "./session-config-options.js";
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
export {
  MEDIA_ONLY_INSTRUCTION,
  promptBlocksToContent,
  textBlock,
  type PromptCaps,
  type PromptMapping,
} from "./content.js";
export {
  toolCallInfo,
  toolKindFor,
  toolTitleFor,
  toolLocationsFor,
  toolDiffFor,
  toolDiffsFor,
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
  // MCP server questions: the ACP form built from a server's `elicitation/create` and the answer
  // mapped back. Exported so a validator (or a sibling host) can exercise them without a transport.
  buildMcpElicitationRequest,
  mapMcpElicitResult,
  type ApprovalDecision,
  type AskUserInteraction,
  type ElicitedAnswer,
} from "./permissions.js";
export {
  createMcpElicitation,
  type McpElicitation,
  type McpElicitationOptions,
  // Exported because `bind()` takes one, not as an interface to implement: it is a structural view of
  // the host's own session bridge (`acpId` / `pending` / `closed`), whose owner is `agent.ts`.
  type McpElicitationSession,
} from "./mcp-elicitation.js";
export { DEFAULT_INTERACTION_TIMEOUT_MS, approvalPolicyKey } from "./interactions.js";
