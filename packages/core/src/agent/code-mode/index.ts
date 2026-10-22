// Code Mode module exports

// Built-in code-mode extension (sandboxed TypeScript execution)
export { createCodeModeExtension, type CodeModeExtensionConfig } from "./extension.js";

// Binding-name normalisation (legal-identifier guarantee for sandbox bindings)
export { normalizeBindingName, renameCodeModeTools } from "./binding-names.js";
export type { BindingNameLog, BindingNameRenameResult } from "./binding-names.js";

// The curated built-in subset exposed inside the sandbox (derived from BUILTIN_TOOL_NAMES)
export { CODE_MODE_LAZY_TOOL_NAMES, CODE_MODE_TOOL_NAMES } from "./curated-tools.js";
export type { CodeModeToolName } from "./curated-tools.js";

// Model-facing shaping of `execute_typescript` results (media lifting)
export { projectCodeModeModelOutput } from "./model-output.js";
