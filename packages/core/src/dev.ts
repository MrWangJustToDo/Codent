/**
 * Internal re-exports for core validation scripts (`pnpm validate:*`).
 * Not part of the public `@codent/core` package API.
 */

export * from "./dev/dev-agent.js";
export * from "./dev/dev-managers.js";
export * from "./dev/dev-models.js";

// Command safety (internal validation exports — not part of public API)
export { analyzeCommand, createAnalysisContext } from "./agent/tools/command-safety/command-analyzer.js";
export { isTimeoutError } from "./runtime-types/abort.js";
export { classifyShell, isShellParsable, resolveShellKind } from "./agent/tools/command-safety/command-parser.js";
export { tokenizeCommandString } from "./agent/tools/command-safety/command-tokenizer.js";
export { walkTree, formatAsTree } from "./agent/tools/tree-tool.js";
// Tool factories for behavioural validators. These live here (not in the published entry) so a
// validator can exercise the real tool code with a stubbed CoreEnv — the alternative is testing
// a replica, which is how a semantic regression (a deleted fallback rule) went unseen while the
// regex-based shell-ism check stayed green.
export { createGlobTool } from "./agent/tools/glob-tool.js";
export { createGrepTool } from "./agent/tools/grep-tool.js";
export { createReadFileTool } from "./agent/tools/read-file-tool.js";
export { createTreeTool } from "./agent/tools/tree-tool.js";
export { execArgsCapture, canExecArgs } from "./agent/tools/util/exec-args.js";
export { fileUriToPath, formatLocation, formatLocationLink, pathToFileUri } from "./agent/lsp/shared/format.js";
export {
  evaluateCommandApproval,
  SUBAGENT_DENY_MESSAGE,
} from "./agent/tools/command-safety/command-approval-policy.js";
export { commandPrefix, normalizedCommand } from "./agent/tools/command-safety/command-arity.js";
export { defaultPath } from "./env";

// Root-level modules
export { Emitter } from "./utils/emitter.js";
export {
  AGENT_SESSION_CHANNELS,
  DEFAULT_AGENT_SESSION_CHANNELS,
  createLocalAgentSession,
  createLocalAgentSessionHost,
  sessionForSubagent,
} from "./agent-session";
export { branchSession, startNewDiskSession } from "./agent-session/session-lifecycle-commands.js";
export { generateId, resetGeneratedIdsForTesting } from "./utils/generate-id.js";
export { toPosixPath, toPosixPathKey } from "./utils/posix-path.js";
export { clearCoreEnv, getEnv, registerCoreEnv } from "./env";
export type { CoreEnv } from "./env";

// Agent-log crash/exit guards (internal validation exports)
export {
  installAgentLogProcessGuards,
  registerActiveAgentLog,
  unregisterActiveAgentLog,
  registerExtensionExitFlush,
  flushExtensionExitFlushesSync,
  flushActiveAgentLogsSync,
} from "./agent/agent-log/lifecycle-guards.js";
// ============================================================================
// Built-in LSP extension (internal validation exports — not part of public API)
// ============================================================================
// The grammar manifest is the single source of truth for which `.wasm` files the
// Node host must ship. `packages/codent` copies exactly these into its tarball
// (see `scripts/copy-tree-sitter-grammars.mjs`), so a language added to
// `LANGUAGE_TO_GRAMMAR` reaches the published package without a second edit.
export { LANGUAGE_TO_GRAMMAR } from "./agent/lsp/tree-sitter/parser-manager.js";
// ============================================================================
// Built-in Memory extension (internal validation exports — not part of public API)
// ============================================================================
// ============================================================================
// Built-in Skills extension (internal validation exports — not part of public API)
// ============================================================================
// ============================================================================
// Built-in Code Mode extension (internal validation exports — not part of public API)
// ============================================================================
export { createCodeModeExtension, type CodeModeExtensionConfig } from "./agent/code-mode/extension.js";
// Binding-name normalisation: a validator must exercise the real helper against the
// real upstream `createCodeMode`, not a replica of the rename rule.
export { normalizeBindingName, renameCodeModeTools } from "./agent/code-mode/binding-names.js";
