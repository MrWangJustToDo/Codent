import { useConfigEditor } from "../hooks/use-config-editor.js";
import { useConfig } from "../hooks/use-config.js";
import { useDiffRenderer } from "../hooks/use-diff-renderer.js";
import { useTheme } from "../hooks/use-theme.js";
import { useTranscriptDisplay } from "../hooks/use-transcript-display.js";
import { isThemeName, THEME_NAMES } from "../theme/colors.js";

import { registerBuiltinCommand } from "./utils/registry.js";

import type { TranscriptDisplayMode } from "../hooks/use-transcript-display.js";

const DISPLAY_MODES: readonly TranscriptDisplayMode[] = ["compact", "full"];

/**
 * Why the model-config wizard cannot be opened here, or `""` when it can.
 *
 * Remote planes own the connection: `--remote-session` runs the agent loop on the
 * server (which resolves its own `models.json` / `.env`) and `--remote-provider`
 * keeps the keys server-side, so a client-side write would either be ignored or
 * leak credentials into a file the server never reads.
 */
function configEditBlockedReason(): string {
  const config = useConfig.getReadonlyState().config;
  if (config.remoteSession) {
    return "Model config is server-owned in remote-session mode — edit models.json on the server.";
  }
  if (config.remoteProvider) {
    return "Model config is server-owned in remote-provider mode — edit models.json on the server.";
  }
  return "";
}

registerBuiltinCommand("settings", {
  immediate: false,
  // One row per setting: every toggle is binary, so an explicit value row
  // (`theme gemini` / `theme claude`) only repeated what its toggle did — four
  // rows replace the ten. Explicit values stay accepted by `execute` for
  // non-interactive use (`/settings theme claude`), and `config` opens the
  // model-configuration form (`.agents/config/models.json`).
  getOptions: () => {
    const theme = useTheme.getActions().getTheme();
    const display = useTranscriptDisplay.getActions().getMode();
    const diff = useDiffRenderer.getActions().getMode();
    const blocked = configEditBlockedReason();
    return [
      { label: "theme", value: "theme", description: `Switch color theme (current: ${theme})` },
      { label: "display", value: "display", description: `Switch transcript density (current: ${display})` },
      { label: "diff", value: "diff", description: `Switch diff renderer (current: ${diff})` },
      { separator: true, label: "", value: "" },
      {
        label: "config",
        value: "config",
        description: blocked || "Edit provider / models in .agents/config/models.json",
      },
    ];
  },
  execute: (args) => {
    const theme = useTheme.getActions();
    const display = useTranscriptDisplay.getActions();
    const diff = useDiffRenderer.getActions();

    const usageError = () => ({
      ok: false as const,
      error:
        `Usage: /settings theme|display|diff (each toggles) or /settings config — explicit values also accepted: ` +
        `theme ${THEME_NAMES.join("|")} · display ${DISPLAY_MODES.join("|")} · diff lite|full | ` +
        `now: theme ${theme.getTheme()} · display ${display.getMode()} · diff ${diff.getMode()}`,
    });

    const trimmed = args.trim().toLowerCase();
    const [head = "", tail = ""] = trimmed.split(/\s+/);

    if (!head) return usageError();

    if (head === "config") {
      const blocked = configEditBlockedReason();
      if (blocked) return { ok: false, error: blocked };
      // Opens the full-screen editor; Agent swaps it in and the editor's own
      // onCancel/onDone close it again (see useConfigEditor).
      useConfigEditor.getActions().open();
      return { ok: true };
    }

    if (head === "theme") {
      const rest = tail || "toggle";
      if (rest === "toggle") {
        return { ok: true, message: `Theme: ${theme.toggle()}` };
      }
      if (!isThemeName(rest)) {
        return {
          ok: false,
          error: `Unknown theme "${rest}". Use ${THEME_NAMES.join(" or ")}. Current: ${theme.getTheme()}`,
        };
      }
      theme.setTheme(rest);
      return { ok: true, message: `Theme: ${rest}` };
    }

    if (head === "diff") {
      const rest = tail || "toggle";
      if (rest === "toggle") {
        return { ok: true, message: `Diff renderer: ${diff.toggle()}` };
      }
      if (rest === "lite" || rest === "full") {
        diff.setMode(rest);
        return { ok: true, message: `Diff renderer: ${rest}` };
      }
      return usageError();
    }

    // Bare density args stay accepted for typing convenience — `/settings compact`
    // is the same as `/settings display compact`. A bare "full"/"lite" is
    // unambiguous (density vs renderer) so it needs no prefix.
    const rest = head === "display" ? tail || "toggle" : head;
    if (rest === "toggle") {
      return { ok: true, message: `Display mode: ${display.toggle()}` };
    }
    if (rest === "compact" || rest === "full") {
      display.setMode(rest);
      const hint =
        rest === "compact"
          ? " (one-line tools; fold consecutive completed tools into activity summaries)"
          : " (full tool rows and outputs)";
      return { ok: true, message: `Display mode: ${rest}${hint}` };
    }
    if (rest === "lite") {
      diff.setMode(rest);
      return { ok: true, message: `Diff renderer: ${rest}` };
    }

    return usageError();
  },
});
