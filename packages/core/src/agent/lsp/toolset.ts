import { getSyntaxErrors } from "../tree-sitter/symbol-extractor.js";

import { lspTextToModelOutput } from "./shared/tool-output.js";
import { createCodeActionsTool } from "./tools/code-actions.js";
import { createCodeOverviewTool } from "./tools/code-overview.js";
import { createCodeRewriteTool } from "./tools/code-rewrite.js";
import { createCodeSearchTool } from "./tools/code-search.js";
import { createCompletionsTool } from "./tools/completions.js";
import { createDefinitionTool } from "./tools/definition.js";
import { createDiagnosticsTool } from "./tools/diagnostics.js";
import { createHoverTool } from "./tools/hover.js";
import { createReferencesTool } from "./tools/references.js";
import { createRenameTool } from "./tools/rename.js";
import { createSymbolsTool } from "./tools/symbols.js";

import type { FileSync } from "./file-sync.js";
import type { LspManager } from "./lsp-manager.js";
import type { ExtensionContext, ExtensionToolDefinition } from "../extension/types.js";
import type { TreeSitterManager, TreeSitterEnv } from "../tree-sitter/parser-manager.js";
import type { WorkspaceIndex } from "../tree-sitter/workspace-index.js";

export interface LspToolsetDeps {
  ctx: ExtensionContext;
  getManager: () => LspManager;
  treeSitter: TreeSitterManager;
  treeSitterEnv: TreeSitterEnv;
  workspaceIndex: WorkspaceIndex;
  fileSync: FileSync;
  shouldRegister: (name: string) => boolean;
}

export function registerLspTools({
  ctx,
  getManager,
  treeSitter,
  treeSitterEnv,
  workspaceIndex,
  fileSync,
  shouldRegister,
}: LspToolsetDeps): void {
  const managerProxy = proxyManager(getManager);

  // ---- Tool factories ----
  /** Tree-sitter fallback for lsp_diagnostics when no LSP server is running. */
  const tsDiagnosticsFallback = async (filePath: string): Promise<string | null> => {
    if (!treeSitter.available()) return null;
    const absPath = getManager().resolvePath(filePath);
    try {
      const content = await treeSitterEnv.readFile(absPath);
      const tree = await treeSitter.parse(absPath, content);
      if (!tree) return null;
      const errors = getSyntaxErrors(tree);
      if (errors.length === 0) return null;
      const relPath = getManager().pathRelative(filePath);
      const lines = errors.slice(0, 10).map((e) => {
        const line = e.line + 1;
        const col = e.character + 1;
        return `${relPath}:${line}:${col} error: ${e.message}`;
      });
      if (errors.length > 10) lines.push(`... and ${errors.length - 10} more syntax error(s)`);
      return `${lines.length} syntax error(s) (tree-sitter fallback, no LSP server):\n${lines.join("\n")}`;
    } catch {
      return null;
    }
  };

  /** Tree-sitter fallback for lsp_hover/lsp_definition: show declaration signature. */
  const tsHoverFallback = async (filePath: string, line: number, character: number): Promise<string | null> => {
    if (!treeSitter.available()) return null;
    const absPath = getManager().resolvePath(filePath);
    try {
      const content = await treeSitterEnv.readFile(absPath);
      const tree = await treeSitter.parse(absPath, content);
      if (!tree) return null;
      const node = tree.rootNode.namedDescendantForPosition({ row: line - 1, column: character - 1 });
      if (!node) return null;
      const text = node.text;
      const firstLine = text.split("\n")[0].trim();
      if (!firstLine) return null;
      return `${node.type} (tree-sitter fallback)\n${firstLine}`;
    } catch {
      return null;
    }
  };

  if (shouldRegister("lsp_diagnostics")) {
    ctx.registerTool(
      withLspTextOutput(createDiagnosticsTool({ manager: managerProxy, fallback: tsDiagnosticsFallback }))
    );
  }
  if (shouldRegister("lsp_hover")) {
    ctx.registerTool(
      withLazy(withLspTextOutput(createHoverTool({ manager: managerProxy, fallback: tsHoverFallback })))
    );
  }
  if (shouldRegister("lsp_definition")) {
    ctx.registerTool(
      withLazy(
        withLspTextOutput(
          createDefinitionTool({
            manager: managerProxy,
            treeSitter,
            workspaceIndex,
            readFile: (p) => treeSitterEnv.readFile(p),
          })
        )
      )
    );
  }
  if (shouldRegister("lsp_references")) {
    ctx.registerTool(withLazy(withLspTextOutput(createReferencesTool({ manager: managerProxy }))));
  }
  if (shouldRegister("lsp_symbols")) {
    ctx.registerTool(withLazy(withLspTextOutput(createSymbolsTool({ manager: managerProxy, workspaceIndex }))));
  }
  if (shouldRegister("lsp_rename")) {
    ctx.registerTool(withLspTextOutput(createRenameTool({ manager: managerProxy })));
  }
  if (shouldRegister("lsp_code_actions")) {
    ctx.registerTool(withLspTextOutput(createCodeActionsTool({ manager: managerProxy })));
  }
  if (shouldRegister("lsp_completions")) {
    ctx.registerTool(
      withLazy(
        withLspTextOutput(
          createCompletionsTool({
            manager: managerProxy,
            versionTracker: fileSync,
            readFile: (p) => treeSitterEnv.readFile(p),
          })
        )
      )
    );
  }

  // ---- Tree-sitter tools (degrade when grammar locator is absent) ----
  if (shouldRegister("ast_search")) {
    ctx.registerTool(
      withLspTextOutput(
        createCodeSearchTool({ rootDir: () => getManager().resolvePath("."), treeSitter, env: treeSitterEnv })
      )
    );
  }
  if (shouldRegister("code_rewrite")) {
    ctx.registerTool(
      withLspTextOutput(
        createCodeRewriteTool({
          rootDir: () => getManager().resolvePath("."),
          treeSitter,
          env: treeSitterEnv,
          onFileModified: (filePath) => {
            fileSync.handleFileWrite(filePath).catch(() => {});
          },
        })
      )
    );
  }
  if (shouldRegister("code_overview")) {
    ctx.registerTool(
      withLspTextOutput(
        createCodeOverviewTool({
          rootDir: () => getManager().resolvePath("."),
          treeSitter,
          env: treeSitterEnv,
          workspaceIndex,
        })
      )
    );
  }
}

/** Lazy proxy that forwards property access to the currently-active manager. */
function proxyManager(getManager: () => LspManager): LspManager {
  return new Proxy({} as LspManager, {
    get(_target, prop) {
      return (getManager() as unknown as Record<string, unknown>)[prop as string];
    },
  });
}

function withLspTextOutput(def: ExtensionToolDefinition): ExtensionToolDefinition {
  return { ...def, toModelOutput: lspTextToModelOutput };
}

/** Mark a tool as lazy so it is discovered on demand. */
function withLazy(def: ExtensionToolDefinition): ExtensionToolDefinition {
  return { ...def, lazy: true };
}
