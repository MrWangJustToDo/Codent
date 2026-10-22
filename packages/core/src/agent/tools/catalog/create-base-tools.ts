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

import { type ToolsRecord } from "./tool-set.js";

import type { UsageTracker } from "../../../runtime-types/hosts.js";
import type { AgentToolContext } from "../runtime/tool-context.js";

export type Tools = ToolsRecord & {
  delete_file: ReturnType<typeof createDeleteFileTool>;
  edit_file: ReturnType<typeof createEditFileTool>;
  list_file: ReturnType<typeof createListFileTool>;
  read_file: ReturnType<typeof createReadFileTool>;
  write_file: ReturnType<typeof createWriteFileTool>;
  glob: ReturnType<typeof createGlobTool>;
  grep: ReturnType<typeof createGrepTool>;
  tree: ReturnType<typeof createTreeTool>;
  run_command: ReturnType<typeof createRunCommandTool>;
  get_command_output: ReturnType<typeof createGetCommandOutputTool>;
  kill_command: ReturnType<typeof createKillCommandTool>;
  session_search: ReturnType<typeof createSessionSearchTool>;
  session_read: ReturnType<typeof createSessionReadTool>;
};

export const createTools = async ({
  usage,
  context,
}: {
  usage?: UsageTracker;
  /** Agent instance bindings for session/job/abort-aware tools. */
  context?: AgentToolContext;
} = {}): Promise<Tools> => {
  const res: Tools = {
    delete_file: createDeleteFileTool(),
    edit_file: createEditFileTool(),
    list_file: createListFileTool(),
    read_file: createReadFileTool({ usage }),
    write_file: createWriteFileTool(),
    glob: createGlobTool(),
    grep: createGrepTool(),
    tree: createTreeTool(),
    run_command: createRunCommandTool({ context }),
    get_command_output: createGetCommandOutputTool({ context }),
    kill_command: createKillCommandTool({ context }),
    session_search: createSessionSearchTool({ context }),
    session_read: createSessionReadTool(),
  };

  return res;
};
