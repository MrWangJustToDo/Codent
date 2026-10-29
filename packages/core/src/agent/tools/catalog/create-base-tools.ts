import { createDeleteFileTool } from "../builtin/fs/delete-file-tool.js";
import { createEditFileTool } from "../builtin/fs/edit-file-tool.js";
import { createGlobTool } from "../builtin/fs/glob-tool.js";
import { createGrepTool } from "../builtin/fs/grep-tool.js";
import { createListFileTool } from "../builtin/fs/list-file-tool.js";
import { createReadFileTool } from "../builtin/fs/read-file-tool.js";
import { createTreeTool } from "../builtin/fs/tree-tool.js";
import { createWriteFileTool } from "../builtin/fs/write-file-tool.js";
import { createSessionReadTool } from "../builtin/session/read-tool.js";
import { createSessionSearchTool } from "../builtin/session/search-tool.js";
import { createGetCommandOutputTool } from "../builtin/shell/get-command-output-tool.js";
import { createKillCommandTool } from "../builtin/shell/kill-command-tool.js";
import { createRunCommandTool } from "../builtin/shell/run-command-tool.js";

import { BUILTIN_TOOL_NAMES } from "./tool-names.js";
import { type ToolsRecord } from "./tool-set.js";

import type { UsageTracker } from "../../../runtime-types/hosts.js";
import type { AgentToolContext } from "../runtime/tool-context.js";

/** Agent-instance bindings a base tool may need. */
interface BaseToolDeps {
  usage?: UsageTracker;
  /** Session/job/abort-aware tools. */
  context?: AgentToolContext;
}

/**
 * The base tool set, keyed by the canonical name.
 *
 * The KEY is the single source of the wire name: before this, the record key and the tool's own
 * `defineServerTool({ name })` were two independent literals, so a rename could leave the registry
 * looking up `read_file` while the record exposed `readFile` — the tool then ran without its
 * `present`/`toModelOutput` and nothing failed. `validate:builtin-tool-names` asserts the registry
 * matches the tools core builds; this table means the record cannot disagree with it at all.
 */
const BASE_TOOL_FACTORIES = {
  [BUILTIN_TOOL_NAMES.deleteFile]: () => createDeleteFileTool(),
  [BUILTIN_TOOL_NAMES.editFile]: () => createEditFileTool(),
  [BUILTIN_TOOL_NAMES.listFile]: () => createListFileTool(),
  [BUILTIN_TOOL_NAMES.readFile]: (deps: BaseToolDeps) => createReadFileTool({ usage: deps.usage }),
  [BUILTIN_TOOL_NAMES.writeFile]: () => createWriteFileTool(),
  [BUILTIN_TOOL_NAMES.glob]: () => createGlobTool(),
  [BUILTIN_TOOL_NAMES.grep]: () => createGrepTool(),
  [BUILTIN_TOOL_NAMES.tree]: () => createTreeTool(),
  [BUILTIN_TOOL_NAMES.runCommand]: (deps: BaseToolDeps) => createRunCommandTool({ context: deps.context }),
  [BUILTIN_TOOL_NAMES.getCommandOutput]: (deps: BaseToolDeps) => createGetCommandOutputTool({ context: deps.context }),
  [BUILTIN_TOOL_NAMES.killCommand]: (deps: BaseToolDeps) => createKillCommandTool({ context: deps.context }),
  [BUILTIN_TOOL_NAMES.sessionSearch]: (deps: BaseToolDeps) => createSessionSearchTool({ context: deps.context }),
  [BUILTIN_TOOL_NAMES.sessionRead]: () => createSessionReadTool(),
} as const;

type BaseToolFactories = typeof BASE_TOOL_FACTORIES;

export type Tools = ToolsRecord & {
  [K in keyof BaseToolFactories]: ReturnType<BaseToolFactories[K]>;
};

export const createTools = async (deps: BaseToolDeps = {}): Promise<Tools> => {
  const res = {} as Tools;

  // Built by key rather than as one literal, so the record and the registry cannot diverge. A
  // factory that needs nothing simply ignores the bag.
  for (const name of Object.keys(BASE_TOOL_FACTORIES) as (keyof BaseToolFactories)[]) {
    const factory = BASE_TOOL_FACTORIES[name] as (deps: BaseToolDeps) => unknown;
    (res as Record<string, unknown>)[name] = factory(deps);
  }

  return res;
};
