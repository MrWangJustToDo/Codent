/**
 * Canonical built-in tool identifiers.
 *
 * This is the single list of the names a host may need to reference — the names
 * `createTools` and the built-in extensions register. Hosts (`@codent/app`,
 * `@codent/acp`, …) import these instead of writing the name
 * as a literal, so renaming or adding a built-in tool is a core-only edit.
 *
 * The registry is metadata, not a second tool definition: the actual tool is
 * declared (`defineServerTool({ name, … })`) at its definition site, and the
 * `validate:builtin-tool-names` script asserts this list matches the tools core
 * builds, so it cannot drift.
 *
 * Use the camelCase key for readability at the call site
 * (`case BUILTIN_TOOL_NAMES.readFile:`); the value is the wire name.
 */
export const BUILTIN_TOOL_NAMES = {
  // Filesystem / workspace inspection.
  readFile: "read_file",
  writeFile: "write_file",
  editFile: "edit_file",
  deleteFile: "delete_file",
  listFile: "list_file",
  tree: "tree",
  glob: "glob",
  grep: "grep",

  // Shell / background jobs.
  runCommand: "run_command",
  getCommandOutput: "get_command_output",
  killCommand: "kill_command",

  // Web.
  websearch: "websearch",
  webfetch: "webfetch",

  // Past-session retrieval.
  sessionSearch: "session_search",
  sessionRead: "session_read",

  // Interaction.
  askUser: "ask_user",
  todo: "todo",

  // Subagent delegation + summary marker.
  task: "task",
  beginSummary: "begin_summary",

  // Plan mode.
  createPlan: "create_plan",
  updatePlan: "update_plan",
  completePlan: "complete_plan",

  // Skills.
  listSkills: "list_skills",
  loadSkill: "load_skill",

  // Memory.
  memoryRead: "memory_read",
  memoryWrite: "memory_write",
  memoryList: "memory_list",

  // Language server / structural queries.
  lspDiagnostics: "lsp_diagnostics",
  lspHover: "lsp_hover",
  lspDefinition: "lsp_definition",
  lspReferences: "lsp_references",
  lspSymbols: "lsp_symbols",
  lspCompletions: "lsp_completions",
  lspRename: "lsp_rename",
  lspCodeActions: "lsp_code_actions",
  astSearch: "ast_search",
  codeRewrite: "code_rewrite",
  codeOverview: "code_overview",

  // Code mode (sandboxed TypeScript).
  executeTypescript: "execute_typescript",
  discoverTools: "discover_tools",
} as const;

/**
 * Tools the CLIENT answers — the UI supplies the result instead of a server `execute`.
 *
 * A classification over the registry, kept beside it because two planes need the same answer and a
 * second copy is how a new client tool ends up understood by one and ignored by the other: the tool
 * set's composition (`tools/runtime/create-tool-sets.ts`) and the pump predicate that must not treat a
 * client tool as a server tool waiting to execute (`stream/tool-phase-utils.ts`).
 */
export const CLIENT_TOOL_NAMES: ReadonlySet<string> = new Set([BUILTIN_TOOL_NAMES.askUser]);

/** The wire name of a built-in tool. */
export type BuiltinToolName = (typeof BUILTIN_TOOL_NAMES)[keyof typeof BUILTIN_TOOL_NAMES];
