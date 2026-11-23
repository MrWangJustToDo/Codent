/**
 * @codent/acp — agent-side Agent Client Protocol host for Codent.
 *
 * Exposes an `AgentSessionHost` over ACP (stdio) so editors (Zed/JetBrains) and
 * ACP→IM bridges can drive the agent without any Codent-specific host code.
 *
 * This file is the package's only public surface (`package.json#exports`); the module layout under
 * `src/` is internal. The rest of the package is exported because a validator (or a sibling host)
 * exercises the mapping helpers without a transport.
 */

export { createAcpAgent } from "./agent/app.js";
export {
  type AcpAgentOptions,
  type AcpAgentDefaults,
  type AcpClientEnvFactoryContext,
  type AcpSessionRuntime,
} from "./agent/options.js";
export { runAcpAgentStdio } from "./transport/stdio.js";
export {
  DEFAULT_SESSION_PAGE_SIZE,
  decodeCursor,
  encodeCursor,
  paginateSessions,
  toSessionInfo,
} from "./session/sessions.js";
export { resolveRoot, toWirePath } from "./wire/paths.js";
export {
  effortOf,
  legacySessionModelState,
  sessionConfigOptions,
  THOUGHT_LEVEL_DEFAULT,
} from "./session/session-config-options.js";
export { mapAcpMcpServers } from "./session/mcp.js";
export { isClientOwnedApproval, type PendingApproval, type ApprovalToolInput } from "./interaction/approvals.js";
export {
  createAcpClientEnv,
  isLocalOnlyPath,
  type AcpClientEnv,
  type AcpClientCapabilities,
  type AcpClientEnvOptions,
} from "./client-env/environment.js";
export { bootstrapLocalAcp, bootstrapAcpAgent, type LocalAcpBootstrap, type AcpModelOverride } from "./bootstrap.js";
export { AcpProjector, type AcpProjectorOptions } from "./projection/projector.js";
export {
  MEDIA_ONLY_INSTRUCTION,
  promptBlocksToContent,
  textBlock,
  type PromptCaps,
  type PromptMapping,
} from "./wire/content.js";
export {
  toolCallInfo,
  toolKindFor,
  toolTitleFor,
  toolLocationsFor,
  toolDiffFor,
  toolDiffsFor,
  toolStatusFor,
  toolResultText,
} from "./projection/tools.js";
export {
  commandsFromSnapshot,
  parseSlashCommand,
  dispatchSlashCommand,
  type ParsedCommand,
  type SlashResult,
} from "./session/commands.js";
export { formatUsageReport } from "./session/usage-report.js";
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
} from "./interaction/permissions.js";
export {
  createMcpElicitation,
  type McpElicitation,
  type McpElicitationOptions,
  // Exported because `bind()` takes one, not as an interface to implement: it is a structural view of
  // the host's own session bridge (`acpId` / `pending` / `closed`), whose owner is `agent/session-bridge.ts`.
  type McpElicitationSession,
} from "./interaction/mcp-elicitation.js";
export { DEFAULT_INTERACTION_TIMEOUT_MS, approvalPolicyKey } from "./interaction/interactions.js";
