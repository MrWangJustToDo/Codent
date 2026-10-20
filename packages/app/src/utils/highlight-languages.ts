/**
 * Languages preloaded into the shared Shiki highlighter.
 *
 * The terminal markdown renderer loads additional languages on demand, but `DiffView` needs a
 * synchronous highlighter: by the time it asks for a grammar the engine must already have it.
 * Keeping this list finite covers common code/diff previews without paying for the full TextMate
 * catalog at startup (which also pulls in derived grammars such as `ts-tags`).
 */
export const COMMON_HIGHLIGHT_LANGUAGES = [
  "astro",
  "bash",
  "c",
  "cpp",
  "csharp",
  "css",
  "diff",
  "dockerfile",
  "go",
  "graphql",
  "html",
  "java",
  "javascript",
  "json",
  "jsx",
  "kotlin",
  "less",
  "lua",
  "makefile",
  "markdown",
  "php",
  "python",
  "ruby",
  "rust",
  "scss",
  "shell",
  "sql",
  "swift",
  "toml",
  "tsx",
  "typescript",
  "vue",
  "xml",
  "yaml",
] as const;
