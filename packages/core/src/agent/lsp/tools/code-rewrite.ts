/**
 * code_rewrite — Transform code matching a structural pattern into a replacement.
 *
 * Matches code by AST structure (like ast_search), then applies a replacement
 * template that can reference captured metavariables. Supports dry-run preview.
 */

import { errorMessage } from "../../../utils/errors.js";
import { truncateText } from "../../../utils/text-truncation.js";
import { compilePattern } from "../../tree-sitter/pattern-compiler.js";
import { computeRewrites, applyRewrites } from "../../tree-sitter/rewrite-engine.js";
import { searchFiles } from "../../tree-sitter/search-engine.js";

import { truncateHead } from "./tool-shared.js";

import type { TreeSitterManager, TreeSitterEnv } from "../../tree-sitter/parser-manager.js";

export interface CodeRewriteToolDeps {
  rootDir: string | (() => string);
  treeSitter: TreeSitterManager;
  env: TreeSitterEnv;
  /** Called after files are modified (so LSP file-sync can update). */
  onFileModified?: (filePath: string) => void;
}

export function createCodeRewriteTool(deps: CodeRewriteToolDeps) {
  const getRootDir: () => string = () => (typeof deps.rootDir === "function" ? deps.rootDir() : deps.rootDir);

  return {
    name: "code_rewrite",
    present: { category: "edits" as const },
    // Applying a rewrite mutates the workspace, so this tool is approval-gated as a whole — the same
    // contract `write_file` / `edit_file` / `delete_file` keep. The flag is static (the approval
    // decision is made before `execute` can look at `dry_run`), which means a preview asks too; that
    // is the deliberate trade: the alternative is a bulk, multi-file write the model performs with
    // no prompt at all. Plan mode already treats this tool as an editing tool and withholds it.
    needsApproval: true,
    description:
      "Transform code matching a structural pattern into a replacement. Use $NAME to capture and reuse single nodes, $$$NAME for sequences. Defaults to dry-run mode (preview only). Set dry_run=false to apply changes. For symbol renames, prefer lsp_rename instead (semantically correct).",
    inputSchema: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Structural pattern to match (with $NAME / $$$NAME metavariables)." },
        replacement: { type: "string", description: "Replacement template using the same metavariables." },
        language: { type: "string", description: "Target language (typescript, python, rust, java, etc.)." },
        path: { type: "string", description: "File or directory scope (default: workspace root)." },
        dry_run: { type: "boolean", description: "Preview changes without applying (default: true)." },
      },
      required: ["pattern", "replacement", "language"],
      additionalProperties: false,
    },
    execute: async (input: unknown) => {
      const params = input as {
        pattern?: string;
        replacement?: string;
        language?: string;
        path?: string;
        dry_run?: boolean;
      };
      const rootDir = getRootDir();
      const isDryRun = params.dry_run !== false;

      let compiled: Awaited<ReturnType<typeof compilePattern>> | undefined;
      try {
        compiled = await compilePattern(params.pattern ?? "", params.language ?? "", deps.treeSitter);
      } catch (err) {
        const msg = errorMessage(err);
        return { text: `Error: ${msg}`, matchCount: 0, filesModified: 0, dryRun: isDryRun };
      }

      if (!deps.treeSitter.available()) {
        return {
          text: "Tree-sitter is not available in this environment (no grammar locator).",
          matchCount: 0,
          filesModified: 0,
          dryRun: isDryRun,
        };
      }
      if (!compiled) {
        return { text: "Failed to compile pattern.", matchCount: 0, filesModified: 0, dryRun: isDryRun };
      }

      // Validate that replacement references only known metavars
      const knownVars = new Set(compiled.metavars);
      const refRe = /\$\$\$([A-Z_][A-Z0-9_]*)|(?<!\$)\$([A-Z_][A-Z0-9_]*)/g;
      let refMatch;
      while ((refMatch = refRe.exec(params.replacement ?? "")) !== null) {
        const name = refMatch[1] ?? refMatch[2];
        if (!knownVars.has(name)) {
          return {
            text: `Error: Replacement references $${name} but pattern doesn't capture it. Pattern captures: ${compiled.metavars.join(", ") || "(none)"}`,
            matchCount: 0,
            filesModified: 0,
            dryRun: isDryRun,
          };
        }
      }

      const matches = await searchFiles(compiled, rootDir, deps.treeSitter, deps.env, {
        path: params.path,
        maxResults: 500,
      });

      if (matches.length === 0) {
        return { text: "No matches found. No changes to make.", matchCount: 0, filesModified: 0, dryRun: isDryRun };
      }

      const rel = (file: string) =>
        file.startsWith(rootDir) ? file.slice(rootDir.length).replace(/^[/\\]/, "") || file : file;

      if (isDryRun) {
        const changes = computeRewrites(matches, params.replacement ?? "");
        const lines: string[] = [];
        lines.push(`Dry run: ${changes.length} change${changes.length !== 1 ? "s" : ""} would be made:\n`);

        for (const c of changes) {
          lines.push(`${rel(c.file)}:${c.line}:${c.column}`);
          const beforeLines = c.before.split("\n");
          const afterLines = c.after.split("\n");
          for (const l of beforeLines) lines.push(`  - ${l}`);
          for (const l of afterLines) lines.push(`  + ${l}`);
          lines.push("");
        }

        lines.push("Run with dry_run=false to apply these changes.");

        const text = lines.join("\n");
        const trunc = truncateHead(text);
        let output = trunc.content;
        if (trunc.truncated) output += `\n\n[Truncated: showing ${trunc.outputLines} of ${trunc.totalLines} lines]`;

        const uniqueFiles = new Set(changes.map((c) => c.file));
        return { text: output, matchCount: matches.length, filesModified: uniqueFiles.size, dryRun: true };
      }

      // Apply mode
      const result = await applyRewrites(matches, params.replacement ?? "", deps.env);

      if (deps.onFileModified && result.filesModified > 0) {
        const modifiedFiles = new Set(result.changes.map((c) => c.file));
        for (const file of modifiedFiles) {
          deps.onFileModified(file);
        }
      }

      const lines: string[] = [];
      lines.push(
        `Applied ${result.changes.length} change${result.changes.length !== 1 ? "s" : ""} across ${result.filesModified} file${result.filesModified !== 1 ? "s" : ""}:\n`
      );

      for (const c of result.changes) {
        const beforeShort = truncateText(c.before, 80);
        const afterShort = truncateText(c.after, 80);
        lines.push(`${rel(c.file)}:${c.line} — ${beforeShort} → ${afterShort}`);
      }

      const text = lines.join("\n");
      const trunc = truncateHead(text);
      let output = trunc.content;
      if (trunc.truncated) output += `\n\n[Truncated: showing ${trunc.outputLines} of ${trunc.totalLines} lines]`;

      return { text: output, matchCount: matches.length, filesModified: result.filesModified, dryRun: false };
    },
  };
}
