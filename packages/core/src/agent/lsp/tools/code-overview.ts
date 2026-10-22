/**
 * code_overview — Summarize project structure, key files, and symbols.
 *
 * Uses tree-sitter for symbol extraction. Shows:
 * - Directory tree (respecting max depth ~3)
 * - Top-level symbols per key file
 * - Dependency manifests
 */

import { extractSymbols } from "../../tree-sitter/symbol-extractor.js";
import { SKIP_DIRS } from "../shared/constants.js";

import { truncateHead } from "./tool-shared.js";

import type { TreeSitterManager, TreeSitterEnv } from "../../tree-sitter/parser-manager.js";
import type { WorkspaceIndex } from "../../tree-sitter/workspace-index.js";

const MANIFESTS = [
  "package.json",
  "Cargo.toml",
  "go.mod",
  "go.sum",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  "requirements.txt",
  "pyproject.toml",
  "setup.py",
  "setup.cfg",
  "Gemfile",
  "Makefile",
  "CMakeLists.txt",
];

const ENTRY_PATTERNS = [
  "index.ts",
  "index.js",
  "main.ts",
  "main.js",
  "app.ts",
  "app.js",
  "main.py",
  "app.py",
  "__init__.py",
  "main.rs",
  "lib.rs",
  "main.go",
  "Main.java",
  "Application.java",
];

const MAX_TREE_DEPTH = 3;
const MAX_TREE_ENTRIES = 200;

export interface CodeOverviewToolDeps {
  rootDir: string | (() => string);
  treeSitter: TreeSitterManager;
  env: TreeSitterEnv;
  workspaceIndex?: WorkspaceIndex;
}

export function createCodeOverviewTool(deps: CodeOverviewToolDeps) {
  const getRootDir: () => string = () => (typeof deps.rootDir === "function" ? deps.rootDir() : deps.rootDir);

  return {
    name: "code_overview",
    present: { category: "reads" as const },
    description:
      "Summarize project structure: directory tree, top-level symbols per key file, dependency manifests. Uses tree-sitter for symbol extraction — no LSP required.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Root directory to analyze (defaults to project root)." },
        depth: { type: "number", description: "Maximum directory depth (default: 3)." },
      },
      additionalProperties: false,
    },
    execute: async (input: unknown) => {
      const params = input as { path?: string; depth?: number };
      const rootDir = getRootDir();
      const targetDir = deps.env.resolve(rootDir, params.path ?? ".");
      const maxDepth = params.depth ?? MAX_TREE_DEPTH;

      const sections: string[] = [];
      let totalFiles = 0;
      let totalSymbols = 0;

      // 1. Directory tree
      const treeLines: string[] = [];
      await buildTree(deps.env, targetDir, "", 0, maxDepth, treeLines);
      totalFiles = treeLines.filter((l) => !l.endsWith("/")).length;
      sections.push(`## Directory Structure\n\n\`\`\`\n${treeLines.join("\n")}\n\`\`\``);

      // 2. Dependency manifests
      const manifests: string[] = [];
      for (const m of MANIFESTS) {
        const path = deps.env.resolve(targetDir, m);
        try {
          await deps.env.stat(path);
          manifests.push(m);
        } catch {
          // not present
        }
      }
      if (manifests.length > 0) {
        sections.push(`## Dependency Manifests\n\n${manifests.map((m) => `- ${m}`).join("\n")}`);
      }

      // 3. Key files with symbols
      const keyFiles = await findKeyFiles(deps.env, targetDir);
      if (keyFiles.length > 0) {
        const symbolSections: string[] = [];
        for (const file of keyFiles.slice(0, 10)) {
          try {
            const content = await deps.env.readFile(file);
            const languageId = deps.treeSitter.getLanguageId(file);
            if (!languageId) continue;

            const tree = await deps.treeSitter.parse(file, content);
            if (!tree) continue;

            const symbols = extractSymbols(tree, languageId);
            if (symbols.length === 0) continue;

            const relPath = file.startsWith(targetDir)
              ? file.slice(targetDir.length).replace(/^[/\\]/, "") || file
              : file;
            const symbolLines = symbols.slice(0, 20).map((s) => {
              const kindNames: Record<number, string> = {
                5: "class",
                6: "method",
                10: "enum",
                11: "interface",
                12: "function",
                13: "variable",
                14: "constant",
                22: "struct",
              };
              const kind = kindNames[s.kind] ?? "symbol";
              return `  ${kind} ${s.name} (line ${s.line})`;
            });
            if (symbols.length > 20) {
              symbolLines.push(`  ... and ${symbols.length - 20} more`);
            }
            totalSymbols += symbols.length;
            symbolSections.push(`### ${relPath}\n${symbolLines.join("\n")}`);
          } catch {
            // skip unreadable files
          }
        }
        if (symbolSections.length > 0) {
          sections.push(`## Key Files\n\n${symbolSections.join("\n\n")}`);
        }
      }

      // 4. Workspace index stats
      if (deps.workspaceIndex && deps.workspaceIndex.fileCount > 0) {
        sections.push(
          `## Index Stats\n\n- ${deps.workspaceIndex.fileCount} indexed files\n- ${deps.workspaceIndex.size} symbols`
        );
      }

      const output = sections.join("\n\n");
      const trunc = truncateHead(output);
      let text = trunc.content;
      if (trunc.truncated) {
        text += `\n\n[Truncated: showing ${trunc.outputLines} of ${trunc.totalLines} lines]`;
      }

      return { text, files: totalFiles, symbols: totalSymbols };
    },
  };
}

/** Build a directory tree representation. */
async function buildTree(
  env: TreeSitterEnv,
  dir: string,
  prefix: string,
  depth: number,
  maxDepth: number,
  lines: string[]
): Promise<void> {
  if (depth > maxDepth || lines.length > MAX_TREE_ENTRIES) return;

  try {
    const entries = await env.readdir(dir);
    const sorted = entries
      .filter(
        (e: { name: string; isDirectory: boolean; isFile: boolean }) => !e.name.startsWith(".") || e.name === ".github"
      )
      .sort(
        (
          a: { name: string; isDirectory: boolean; isFile: boolean },
          b: { name: string; isDirectory: boolean; isFile: boolean }
        ) => {
          if (a.isDirectory && !b.isDirectory) return -1;
          if (!a.isDirectory && b.isDirectory) return 1;
          return a.name.localeCompare(b.name);
        }
      );

    for (let i = 0; i < sorted.length; i++) {
      if (lines.length > MAX_TREE_ENTRIES) {
        lines.push(`${prefix}... (truncated)`);
        return;
      }

      const entry = sorted[i];
      const isLast = i === sorted.length - 1;
      const connector = isLast ? "└── " : "├── ";
      const childPrefix = isLast ? "    " : "│   ";

      if (entry.isDirectory) {
        if (SKIP_DIRS.has(entry.name)) {
          lines.push(`${prefix}${connector}${entry.name}/ (skipped)`);
          continue;
        }
        lines.push(`${prefix}${connector}${entry.name}/`);
        await buildTree(env, env.resolve(dir, entry.name), prefix + childPrefix, depth + 1, maxDepth, lines);
      } else {
        lines.push(`${prefix}${connector}${entry.name}`);
      }
    }
  } catch {
    // permission denied
  }
}

/** Find key/entry-point files in the project. */
async function findKeyFiles(env: TreeSitterEnv, dir: string): Promise<string[]> {
  const found: string[] = [];
  const searchDirs = [dir, env.resolve(dir, "src"), env.resolve(dir, "lib"), env.resolve(dir, "app")];

  for (const searchDir of searchDirs) {
    for (const pattern of ENTRY_PATTERNS) {
      const fullPath = env.resolve(searchDir, pattern);
      try {
        await env.stat(fullPath);
        found.push(fullPath);
      } catch {
        // not present
      }
    }
  }

  return [...new Set(found)];
}
