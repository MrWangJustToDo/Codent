/**
 * @codent/acp — agent-side Agent Client Protocol host for Codent.
 *
 * Exposes an `AgentSessionHost` over ACP (stdio) so editors (Zed/JetBrains) and
 * ACP→IM bridges can drive the agent without any Codent-specific host code.
 */

export { createAcpAgent, runAcpAgentStdio, type AcpAgentOptions, type AcpAgentDefaults } from "./agent.js";
export { bootstrapLocalAcp, bootstrapAcpAgent, type LocalAcpBootstrap, type AcpModelOverride } from "./bootstrap.js";
export { AcpProjector, type AcpProjectorOptions } from "./projector.js";
export { promptBlocksToContent, textBlock, type PromptCaps, type PromptMapping } from "./content.js";
export { toolKindFor, toolTitleFor, toolLocationsFor, toolDiffFor, toolStatusFor, toolResultText } from "./tools.js";
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
