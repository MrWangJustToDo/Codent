import { errorMessage } from "../../utils/errors.js";

import { EXT_TO_LANGUAGE } from "./language-map.js";

import type { LspManager } from "./lsp-manager.js";
import type { ExtensionContext } from "../extension/types.js";

export interface LspCommandDeps {
  ctx: ExtensionContext;
  getManager: () => LspManager;
}

export function registerLspCommands({ ctx, getManager }: LspCommandDeps): void {
  // ---- Commands ----
  ctx.registerCommand({
    name: "lsp",
    description: "Show LSP server status",
    execute: async () => {
      const statuses = getManager().getStatus();
      if (statuses.length === 0) return "No LSP servers configured.";

      const lines = statuses.map((s) => {
        let icon = "⚪";
        if (s.running) icon = "🟢";
        else if (s.available === false) icon = "🔴";
        const diags = s.diagnosticsCount > 0 ? ` (${s.diagnosticsCount} diagnostics)` : "";
        const hint = s.available === false ? ` — ${s.unavailableReason ?? `'${s.command}' not found on PATH`}` : "";
        return `${icon} ${s.languageId}: ${s.command}${diags}${hint}`;
      });

      // Languages with an extension mapping but no configured server.
      const configured = new Set(statuses.map((s) => s.languageId));
      const mappedOnly = [...new Set(Object.values(EXT_TO_LANGUAGE))].filter((lang) => !configured.has(lang)).sort();
      if (mappedOnly.length > 0) {
        lines.push("");
        lines.push("🔵 Mapped languages without a server (add to .lsp.json `servers` to enable):");
        lines.push(`   ${mappedOnly.join(", ")}`);
      }

      lines.push("");
      lines.push("Legend: 🟢 running · ⚪ configured but idle · 🔴 command not found · 🔵 mapped-only (no server)");
      return lines.join("\n");
    },
  });

  ctx.registerCommand({
    name: "lsp-restart",
    description: "Restart an LSP server: /lsp-restart <language> (e.g. java, typescript)",
    // Secondary options: every configured language (idle / running / failed), so
    // the user can pick without typing — mirrors /skill and /memory options.
    getOptions: () =>
      getManager()
        .getStatus()
        .map((s) => ({
          label: s.languageId,
          value: s.languageId,
          description: s.command,
        })),
    execute: async (args) => {
      const languageId = args[0]?.trim().toLowerCase();
      if (!languageId) {
        const statuses = getManager()
          .getStatus()
          .filter((s) => s.running);
        const langs = statuses.map((s) => s.languageId).join(", ");
        return statuses.length
          ? `Running servers: ${langs}\n\nUsage: /lsp-restart <language>`
          : "No LSP servers are running.\n\nUsage: /lsp-restart <language>";
      }
      try {
        await getManager().restartServer(languageId);
        return `${languageId} server restarted successfully.`;
      } catch (err) {
        const msg = errorMessage(err);
        return `Failed to restart ${languageId}: ${msg}`;
      }
    },
  });

  ctx.registerCommand({
    name: "lsp-config",
    description: "Configure an LSP server: /lsp-config <language> <command> [args...]",
    // Secondary options: all languages the extension can map plus any already
    // configured one. Selecting fills `/lsp-config <lang> ` (append-only), so the
    // user then types the server command.
    getOptions: () => {
      const langs = new Set(Object.values(EXT_TO_LANGUAGE));
      for (const s of getManager().getStatus()) langs.add(s.languageId);
      return [...langs].sort().map((lang) => ({ label: lang, value: lang, description: "Configure an LSP server" }));
    },
    execute: async (args) => {
      if (args.length < 2) {
        return "Usage: /lsp-config <language> <command> [args...]\nExample: /lsp-config python pylsp";
      }
      const [languageId, command, ...serverArgs] = args;
      getManager().setServerConfig(languageId, { command, args: serverArgs });
      return `Configured LSP for ${languageId}: ${command} ${serverArgs.join(" ")}`;
    },
  });
}
