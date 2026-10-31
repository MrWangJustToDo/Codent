/**
 * Tool subsystem barrel.
 *
 * Explicit re-exports, deliberately NOT `export *`: with wildcards every new export in any tool
 * module silently became barrel API, and two modules exporting one name would drop/ambiguate it.
 * Adding a tool means adding its line here — a reviewable one-line change instead of an implicit
 * surface expansion.
 */

export { createTools, type Tools } from "./catalog/create-base-tools.js";
export { BUILTIN_TOOL_NAMES, CLIENT_TOOL_NAMES } from "./catalog/tool-names.js";

// Filesystem / workspace inspection.
export { createDeleteFileTool } from "./builtin/fs/delete-file-tool.js";
export { createEditFileTool } from "./builtin/fs/edit-file-tool.js";
export { createGlobTool } from "./builtin/fs/glob-tool.js";
export { createGrepTool } from "./builtin/fs/grep-tool.js";
export { createListFileTool } from "./builtin/fs/list-file-tool.js";
export { createReadFileTool, readFileOutputSchema, type ReadFileOutput } from "./builtin/fs/read-file-tool.js";
export { createTreeTool, formatAsTree, walkTree, type WalkTreeOptions } from "./builtin/fs/tree-tool.js";
export { createWriteFileTool } from "./builtin/fs/write-file-tool.js";

// Interaction.
export { createAskUserTool, askUserOutputSchema, type AskUserOutput } from "./builtin/interaction/ask-user-tool.js";

// Past-session retrieval.
export { createSessionReadTool, sessionReadOutputSchema, type SessionReadOutput } from "./builtin/session/read-tool.js";
export {
  createSessionSearchTool,
  sessionSearchOutputSchema,
  type SessionSearchOutput,
} from "./builtin/session/search-tool.js";

// Shell / background jobs.
export { createGetCommandOutputTool } from "./builtin/shell/get-command-output-tool.js";
export { createKillCommandTool } from "./builtin/shell/kill-command-tool.js";
export {
  buildTimedOutCommandResult,
  commandTimeoutNotice,
  createRunCommandTool,
  resolveDefaultCommandTimeout,
} from "./builtin/shell/run-command-tool.js";

// Web.
export { createWebfetchTool, webfetchOutputSchema, type WebfetchOutput } from "./builtin/web/fetch/tool.js";
export { createWebsearchTool, websearchOutputSchema, type WebsearchOutput } from "./builtin/web/search/tool.js";

export { defineClientTool, defineServerTool, type ToolExecuteCtx, type ToolMetadata } from "./runtime/define-tool.js";
export type {
  ModelToolContent,
  ToModelOutputContext,
  ToModelOutputDecorator,
  ToModelOutputFn,
} from "./runtime/contract.js";
export { resolveToolsRecord, toolsToArray, type ToolsRecord, type ToolsToArrayOptions } from "./catalog/tool-set.js";
export { SUBAGENT_EXCLUDED_TOOL_NAMES, getReadOnlyTanStackToolNames } from "./runtime/tool-sets.js";
