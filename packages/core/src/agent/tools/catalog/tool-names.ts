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

  // Computer use (native screen + input; registered only when `env.computer` exists).
  computerScreenshot: "computer_screenshot",
  computerAction: "computer",
} as const;

/**
 * Tools the CLIENT answers — the UI supplies the result instead of a server `execute`.
 *
 * This set is BOTH the default classifier and the admission gate: only a name in it can be a
 * host-answered call. Inside the gate the live tool's `present.clientSide` decides, resolved per
 * agent by `ToolFacet.isClientTool`; the pump predicates take that classifier as an argument and
 * fall back to this set. The gate is what keeps the predicate cheap on every tool part, and the
 * identity answer is what tells the seeded `ask_user` from an extension's SERVER tool shadowing the
 * same name — which would otherwise be read as "the host owes an answer" (the pump parks on a
 * question nobody asked, and `addToolResult` accepts a host result for a call the server executed).
 * A host-injected client tool under a name outside this set is therefore not supported; it would be
 * treated as a server tool.
 *
 * No shipped host injects its own client tool programmatically (`createManagedAgent({
 * subagentTools })`); the hosted client tool is `ask_user`, which is here.
 */
export const CLIENT_TOOL_NAMES: ReadonlySet<string> = new Set([BUILTIN_TOOL_NAMES.askUser]);

/** Classifies a tool call by who answers it: the host (`true`) or the server (`false`). */
export type ClientToolClassifier = (toolName: string) => boolean;

/** The default classifier: the built-in client-tool names, name-based. */
export const isClientToolName: ClientToolClassifier = (toolName) => CLIENT_TOOL_NAMES.has(toolName);

/**
 * Bind a host's client-tool classifier.
 *
 * The ONE spelling of "the host's identity answer, else the static table": the pump, the status
 * controller, the settle passes, approval-resume and session restore all ask the same question, and
 * a second spelling is how their answers drift apart. Calls through the host because a prototype
 * method (`ManagedAgent.isClientTool`) reads `this`.
 */
export function clientToolClassifier(host?: { isClientTool?: (toolName: string) => boolean }): ClientToolClassifier {
  if (!host?.isClientTool) return isClientToolName;
  return (toolName) => host.isClientTool!(toolName);
}

/** The wire name of a built-in tool. */
export type BuiltinToolName = (typeof BUILTIN_TOOL_NAMES)[keyof typeof BUILTIN_TOOL_NAMES];

/** Runtime membership test for {@link BUILTIN_TOOL_NAMES} (display rules must not keep a name table). */
const BUILTIN_TOOL_NAME_SET: ReadonlySet<string> = new Set(Object.values(BUILTIN_TOOL_NAMES));

/** Whether `name` is one of core's built-in tool names. */
export function isBuiltinToolName(name: string): name is BuiltinToolName {
  return BUILTIN_TOOL_NAME_SET.has(name);
}
