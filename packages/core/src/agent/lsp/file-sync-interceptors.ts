import { BUILTIN_TOOL_NAMES } from "../tools/catalog/tool-names.js";

import { applyDiagnosticsToToolAfterPayload } from "./shared/apply-tool-diagnostics.js";
import { MAX_AUTO_DIAGNOSTIC_LINES } from "./shared/constants.js";
import { extractToolPath } from "./shared/parse-tool-args.js";
import { AUTO_DIAG_SETTLE_POLL_MS, AUTO_DIAG_SETTLE_TIMEOUT_MS } from "./shared/timing.js";

import type { FileSync } from "./file-sync.js";
import type { LspManager } from "./lsp-manager.js";
import type { ProjectLspConfig } from "./project-config.js";
import type { ExtensionContext, ToolAfterEvent } from "../extension/types.js";

export interface FileSyncInterceptorDeps {
  ctx: ExtensionContext;
  getManager: () => LspManager;
  fileSync: FileSync;
  getProjectConfig: () => ProjectLspConfig | null;
  /** Re-index a file after a successful write/edit (tree-sitter symbol fallback). */
  onFileChanged?: (path: string) => void;
}

export function registerFileSyncInterceptors({
  ctx,
  getManager,
  fileSync,
  getProjectConfig,
  onFileChanged,
}: FileSyncInterceptorDeps): void {
  // ---- File-sync + auto-diagnostics interceptors ----
  const handleAfter = async (toolName: string, filePath: string): Promise<void> => {
    try {
      if (toolName === BUILTIN_TOOL_NAMES.readFile) {
        await fileSync.handleFileRead(filePath);
      } else if (toolName === BUILTIN_TOOL_NAMES.writeFile || toolName === BUILTIN_TOOL_NAMES.editFile) {
        await fileSync.handleFileWrite(filePath);
        // The symbol index is only useful if it follows edits: without this, `ast_search` /
        // `code_overview` (and the LSP-fallback definition lookup) kept answering from the state
        // of the workspace at first use for the rest of the session.
        onFileChanged?.(filePath);
      }
    } catch {
      // File-sync errors are non-fatal
    }
  };

  ctx.registerInterceptor<ToolAfterEvent>("tool:after:read_file", async (event) => {
    const path = extractToolPath(event.payload.args);
    if (path) await handleAfter("read_file", path);
  });

  /**
   * Snapshot the publish counter for a file before the change is synced to the
   * server, so the diagnostics wait can tell "a publish caused by this write"
   * apart from a stale one. Null when there is nothing to wait for.
   */
  function captureDiagnosticsBaseline(path: string | undefined): { uri: string; revision: number } | null {
    if (!path) return null;
    try {
      const mgr = getManager();
      const uri = mgr.getFileUri(path);
      return { uri, revision: mgr.getDiagnosticsRevision(uri) };
    } catch {
      return null;
    }
  }

  ctx.registerInterceptor<ToolAfterEvent>("tool:after:write_file", async (event) => {
    const path = extractToolPath(event.payload.args);
    const baseline = captureDiagnosticsBaseline(path);
    if (path) await handleAfter("write_file", path);
    await maybeInjectDiagnostics(path, event, baseline);
  });

  ctx.registerInterceptor<ToolAfterEvent>("tool:after:edit_file", async (event) => {
    const path = extractToolPath(event.payload.args);
    const baseline = captureDiagnosticsBaseline(path);
    if (path) await handleAfter("edit_file", path);
    await maybeInjectDiagnostics(path, event, baseline);
  });

  /** Auto-inject LSP error diagnostics into write/edit results via modifiedResult. */
  async function maybeInjectDiagnostics(
    path: string | undefined,
    event: ToolAfterEvent,
    baseline: { uri: string; revision: number } | null
  ): Promise<void> {
    if (!path || !baseline) return;

    const mgr = getManager();

    const languageId = mgr.getLanguageId(path);
    if (!languageId) return;

    const inject = getProjectConfig()?.autoInjectDiagnostics;
    if (inject === false) return;
    if (Array.isArray(inject) && !inject.includes(languageId)) return;

    // Cold start: never stall the tool result waiting for the server to boot.
    // file-sync already kicked the start off in the background, so diagnostics
    // arrive on the next write once the server is warm. Nothing is emitted here:
    // LSP notifications only report terminal states.
    if (!mgr.getRunningClient(languageId)) return;

    // Wait for the server to (re)publish diagnostics for this document rather
    // than waiting for errors to appear: a clean file publishes an empty list,
    // so a successful edit returns as soon as analysis finishes instead of
    // always burning the timeout. The timeout stays the upper bound for slow
    // servers, and for servers that never publish.
    const { uri, revision } = baseline;
    const deadline = Date.now() + AUTO_DIAG_SETTLE_TIMEOUT_MS;
    while (mgr.getDiagnosticsRevision(uri) <= revision && Date.now() < deadline) {
      if (!mgr.getRunningClient(languageId)) return; // crashed mid-wait
      await new Promise((r) => setTimeout(r, AUTO_DIAG_SETTLE_POLL_MS));
    }

    const errors = (mgr.getDiagnostics(uri) as { severity?: number }[]).filter((d) => d.severity === 1);
    if (errors.length === 0) return;

    const relPath = mgr.pathRelative(path);
    const lines = errors.slice(0, MAX_AUTO_DIAGNOSTIC_LINES).map((d) => {
      const dAny = d as {
        range?: { start?: { line?: number; character?: number } };
        message?: string;
        source?: string;
      };
      const line = (dAny.range?.start?.line ?? 0) + 1;
      const col = (dAny.range?.start?.character ?? 0) + 1;
      const source = dAny.source ? ` [${dAny.source}]` : "";
      return `${relPath}:${line}:${col} error: ${dAny.message ?? ""}${source}`;
    });
    if (errors.length > MAX_AUTO_DIAGNOSTIC_LINES) {
      lines.push(`... and ${errors.length - MAX_AUTO_DIAGNOSTIC_LINES} more error(s)`);
    }

    const summary = `\n\n⚠ LSP: ${errors.length} error(s) in ${relPath}:\n${lines.join("\n")}`;
    applyDiagnosticsToToolAfterPayload(event.payload, summary);
    // Diagnostics are transient host notifications, not a retained render slot —
    // LSP messages all go through `notify` (the input feedback line).
    ctx.ui.notify(`LSP: ${errors.length} error(s) in ${relPath}`, "error");
  }
}
