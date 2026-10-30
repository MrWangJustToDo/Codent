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
 * Tools the CLIENT answers — the UI supplies the result instead of a server `execute`. A name
 * table over the built-ins, kept beside them so the pump predicate can recognize a client tool
 * instead of treating it as a server tool waiting to execute (`stream/tool-phase-utils.ts`).
 *
 * Deliberately a static set: the alternative is threading the registry's `present.clientSide`
 * flags into the pump predicate, which only matters for a host that injects its own client tool
 * programmatically (`createManagedAgent({ subagentTools })`). Such a tool has an `execute` the
 * server cannot run, so `hasDeferredToolExecution` reads its unanswered call as pending and the
 * tool phase does not converge. No shipped host does that — the hosted client tool is `ask_user`,
 * which is here — so this is an embedder boundary, not a bug to paper over with a permissive
 * "no output ⇒ done" rule (that would also swallow a genuinely pending server tool).
 */
export const CLIENT_TOOL_NAMES: ReadonlySet<string> = new Set([BUILTIN_TOOL_NAMES.askUser]);

/** The wire name of a built-in tool. */
export type BuiltinToolName = (typeof BUILTIN_TOOL_NAMES)[keyof typeof BUILTIN_TOOL_NAMES];

/** Runtime membership test for {@link BUILTIN_TOOL_NAMES} (display rules must not keep a name table). */
const BUILTIN_TOOL_NAME_SET: ReadonlySet<string> = new Set(Object.values(BUILTIN_TOOL_NAMES));

/** Whether `name` is one of core's built-in tool names. */
export function isBuiltinToolName(name: string): boolean {
  return BUILTIN_TOOL_NAME_SET.has(name);
}
