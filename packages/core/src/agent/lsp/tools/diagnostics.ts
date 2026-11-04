/**
 * lsp_diagnostics — compilation errors and warnings for a file (or whole workspace).
 */

import { AUTO_DIAG_SERVER_WAIT_MS } from "../shared/timing.js";

import { normalizeLspPath, truncateHead } from "./tool-shared.js";

import type { LspManager } from "../lsp-manager.js";
import type { Diagnostic } from "vscode-languageserver-protocol";

/** Line/byte caps for the diagnostic output shown to the model. */
const MAX_OUTPUT_LINES = 200;
const MAX_OUTPUT_BYTES = 12000;

const DIAGNOSTIC_SEVERITY = {
  Error: 1,
  Warning: 2,
  Information: 3,
  Hint: 4,
} as const;

function severityToString(severity: number | undefined): string {
  switch (severity) {
    case DIAGNOSTIC_SEVERITY.Error:
      return "error";
    case DIAGNOSTIC_SEVERITY.Warning:
      return "warning";
    case DIAGNOSTIC_SEVERITY.Information:
      return "info";
    case DIAGNOSTIC_SEVERITY.Hint:
      return "hint";
    default:
      return "unknown";
  }
}

function formatDiagnostic(diag: Diagnostic, filePath: string): string {
  const line = diag.range.start.line + 1;
  const col = diag.range.start.character + 1;
  const sev = severityToString(diag.severity);
  const source = diag.source ? ` [${diag.source}]` : "";
  const code = diag.code !== undefined ? ` (${diag.code})` : "";
  return `${filePath}:${line}:${col} ${sev}: ${diag.message}${code}${source}`;
}

export interface DiagnosticsToolDeps {
  manager: LspManager;
  /** Optional callback to check diagnostics via a provider (tree-sitter fallback later). */
  fallback?: (filePath: string) => Promise<string | null>;
}

export function createDiagnosticsTool(deps: DiagnosticsToolDeps) {
  return {
    name: "lsp_diagnostics",
    present: { category: "searches" as const },
    description:
      'Get compilation errors and warnings from the LSP server. Pass a file path to check a single file, or "*" for all cached workspace diagnostics. After edits, use this to verify the file compiles.',
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: 'File path to check. Pass "*" for all workspace diagnostics.',
        },
      },
      required: ["path"],
      additionalProperties: false,
    },
    execute: async (input: unknown) => {
      const params = input as { path?: string };
      const filePath = normalizeLspPath(params.path) ?? "";

      // Workspace-wide mode
      if (filePath === "*" || filePath === "") {
        return workspaceDiagnostics(deps.manager);
      }

      const languageId = deps.manager.getLanguageId(filePath);
      if (!languageId) {
        if (deps.fallback) {
          const fallbackText = await deps.fallback(filePath);
          if (fallbackText != null) {
            return { text: fallbackText, count: 0, errors: 0, warnings: 0, source: "fallback" };
          }
        }
        return { text: deps.manager.getUnavailableReason(filePath), count: 0, errors: 0, warnings: 0 };
      }

      const client = await deps.manager.waitForClient(languageId, AUTO_DIAG_SERVER_WAIT_MS);

      if (client) {
        const uri = deps.manager.getFileUri(filePath);
        const diagnostics = deps.manager.getDiagnostics(uri) as Diagnostic[];

        if (diagnostics.length === 0) {
          return { text: "No diagnostics (clean).", count: 0, errors: 0, warnings: 0 };
        }

        const sorted = [...diagnostics].sort((a, b) => (a.severity ?? 99) - (b.severity ?? 99));
        const relPath = rel(deps.manager, deps.manager.resolvePath("."), deps.manager.resolvePath(filePath));
        const lines = sorted.map((d) => formatDiagnostic(d, relPath));
        const output = lines.join("\n");

        const errors = sorted.filter((d) => d.severity === DIAGNOSTIC_SEVERITY.Error).length;
        const warnings = sorted.filter((d) => d.severity === DIAGNOSTIC_SEVERITY.Warning).length;
        const other = sorted.length - errors - warnings;

        const summary = [
          errors > 0 ? `${errors} error(s)` : null,
          warnings > 0 ? `${warnings} warning(s)` : null,
          other > 0 ? `${other} other` : null,
        ]
          .filter(Boolean)
          .join(", ");

        const trunc = truncateHead(output, MAX_OUTPUT_LINES, MAX_OUTPUT_BYTES);
        let resultText = `${summary}\n\n${trunc.content}`;
        if (trunc.truncated) {
          resultText += `\n\n[Output truncated: showing ${trunc.outputLines} of ${trunc.totalLines} diagnostics]`;
        }

        return { text: resultText, count: sorted.length, errors, warnings };
      }

      // Fallback (tree-sitter syntax errors when available)
      if (deps.fallback) {
        const fallbackText = await deps.fallback(filePath);
        if (fallbackText != null) {
          return { text: fallbackText, count: 0, errors: 0, warnings: 0, source: "fallback" };
        }
      }

      return { text: deps.manager.getUnavailableReason(filePath), count: 0, errors: 0, warnings: 0 };
    },
  };
}

/** All diagnostics across running servers. */
function workspaceDiagnostics(manager: LspManager) {
  const statuses = manager.getStatus();
  const running = statuses.filter((s) => s.running);

  if (running.length === 0) {
    return {
      text: "No LSP servers are running. Use lsp_diagnostics with a file path to start a server and check that file.",
      count: 0,
    };
  }

  const rootDir = manager.resolvePath(".");
  const lines: string[] = [];
  let totalCount = 0;
  const files = new Set<string>();

  for (const status of running) {
    const client = manager.getRunningClient(status.languageId);
    if (!client) continue;
    for (const [uri, diags] of client.diagnostics) {
      if (!diags.length) continue;
      const relPath = uri.replace(/^file:\/\//, "");
      const relFile = rel(manager, rootDir, relPath);
      files.add(relFile);
      for (const d of diags as Diagnostic[]) {
        lines.push(formatDiagnostic(d, relFile));
        totalCount++;
      }
    }
  }

  if (totalCount === 0) {
    return { text: "No diagnostics (clean) across all running LSP servers.", count: 0 };
  }

  const trunc = truncateHead(lines.join("\n"), MAX_OUTPUT_LINES, MAX_OUTPUT_BYTES);
  let text = `${totalCount} diagnostic(s) across ${files.size} file(s):\n\n${trunc.content}`;
  if (trunc.truncated) text += `\n\n[Output truncated]`;
  return { text, count: totalCount, files: files.size };
}

/** Compute a relative path (POSIX-style) without node:path. */
function rel(manager: LspManager, from: string, to: string): string {
  const rootDir = manager.resolvePath(".");
  if (to.startsWith(rootDir)) {
    const r = to.slice(rootDir.length).replace(/^[/\\]/, "");
    return r || ".";
  }
  return to;
}
