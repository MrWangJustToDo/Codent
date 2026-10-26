/**
 * Internal re-exports for core validation scripts (`pnpm validate:*`).
 * Not part of the public `@codent/core` package API.
 */

export * from "./dev/dev-agent.js";
export * from "./dev/dev-managers.js";
export * from "./dev/dev-models.js";

// Command safety (internal validation exports — not part of public API)
export { analyzeCommand, createAnalysisContext } from "./agent/tools/builtin/shell/safety/command-analyzer.js";
export { isAbortError, isTimeoutError } from "./runtime-types/abort.js";
export { classifyShell, isShellParsable, resolveShellKind } from "./agent/tools/builtin/shell/safety/command-parser.js";
export { tokenizeCommandString } from "./agent/tools/builtin/shell/safety/command-tokenizer.js";
export { walkTree, formatAsTree } from "./agent/tools/builtin/fs/tree-tool.js";
// Tool factories for behavioural validators. These live here (not in the published entry) so a
// validator can exercise the real tool code with a stubbed CoreEnv — the alternative is testing
// a replica, which is how a semantic regression (a deleted fallback rule) went unseen while the
// regex-based shell-ism check stayed green.
export { createGlobTool } from "./agent/tools/builtin/fs/glob-tool.js";
export { createGrepTool } from "./agent/tools/builtin/fs/grep-tool.js";
export { createReadFileTool } from "./agent/tools/builtin/fs/read-file-tool.js";
export { createTreeTool } from "./agent/tools/builtin/fs/tree-tool.js";
// The remaining projection-declaring factories: `validate:model-output-idempotency` drives every
// registered projection, and it can only cover the ones this surface can create.
export { createGetCommandOutputTool } from "./agent/tools/builtin/shell/get-command-output-tool.js";
export { createKillCommandTool } from "./agent/tools/builtin/shell/kill-command-tool.js";
export { createWriteFileTool } from "./agent/tools/builtin/fs/write-file-tool.js";
export { createEditFileTool } from "./agent/tools/builtin/fs/edit-file-tool.js";
export { createDeleteFileTool } from "./agent/tools/builtin/fs/delete-file-tool.js";
export { createBeginSummaryTool } from "./agent/subagent/begin-summary-tool.js";
export {
  createSubagentTools,
  SUBAGENT_TOOL_NAMES,
  SUBAGENT_READ_ONLY_TOOL_NAMES,
} from "./agent/subagent/subagent-tools.js";
export { isProjectedModelContent } from "./agent/tools/runtime/projected-model-content.js";
// The per-file mutation queue leaks if it never drains: `validate:file-mutation-queue` reads its
// size to assert it does, which needs the module (not a replica of it).
export { fileMutationQueueSize, withFileMutationQueue } from "./agent/tools/builtin/fs/edit/mutation-queue.js";
// The declaration table the presentation registry falls back to: the boundary validator reads it as
// the declared categories (the definition sites are pinned to it by `validate:tool-presentation`).
export { BUILTIN_PRESENTATION } from "./agent/tools/presentation/builtin.js";
export { formatToolOutput } from "./agent/tools/presentation/format/output-format.js";
export { classifyServerFailure } from "./agent/lsp/extension.js";
export { execArgsCapture, canExecArgs } from "./agent/tools/builtin/shell/exec-args.js";
export { fileUriToPath, formatLocation, formatLocationLink, pathToFileUri } from "./agent/lsp/shared/format.js";
export {
  evaluateCommandApproval,
  SUBAGENT_DENY_MESSAGE,
} from "./agent/tools/builtin/shell/safety/command-approval-policy.js";
export { commandPrefix, normalizedCommand } from "./agent/tools/builtin/shell/safety/command-arity.js";
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
export { LANGUAGE_TO_GRAMMAR } from "./agent/tree-sitter/parser-manager.js";
// ============================================================================
// Extension runtime access (internal validation exports — not part of public API)
// ============================================================================
// `ExtensionRunner` / `createLifecycleMiddleware` / `createAgentEventBus` are already re-exported by
// the dev modules above; only the extension-runtime additions live here.
export { createObserverSurface } from "./agent/extension/observer-surface.js";
export { completeExtensionQuery, copyModelMessages, ExtensionLlmError } from "./managers/extension-completion.js";

// ============================================================================
// Built-in Memory extension (internal validation exports — not part of public API)
// ============================================================================
// ============================================================================
// Built-in Jobs extension (internal validation exports — not part of public API)
// ============================================================================
// Already reachable through the published entry (`formatDuration`); re-exported here so every
// validator import stays on `dist/dev.mjs`.
export { formatDuration } from "./agent/tools/presentation/format/format.js";
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
// The curated binding subset the agent actually wires up: the validator asserts the prompt is
// built from the real list, not a copy that can drift from `agent-bootstrap`.
export { CODE_MODE_LAZY_TOOL_NAMES, CODE_MODE_TOOL_NAMES } from "./agent/code-mode/curated-tools.js";
