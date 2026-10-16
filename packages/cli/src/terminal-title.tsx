import { useAgent, useConfig } from "@codent/app";
import { getEnv, type AgentStatus } from "@codent/core";
import { useEffect } from "react";

// ============================================================================
// Terminal Title (OSC-0)
// ============================================================================
// Sets the terminal window title to `<workspace> · <app>` plus a status icon and
// suffix, and restores it when the session goes away. Shared by the development
// host and the self-contained release host.

const OSC_TITLE = "\x1b]0;";
const OSC_END = "\x07";

const DEFAULT_APP_NAME = "Codent";

const STATUS_ICON: Record<AgentStatus, string> = {
  idle: "●",
  running: "◉",
  completed: "✓",
  error: "✖",
  aborted: "○",
  waiting: "◐",
  awaiting_user: "◐",
  compacting: "⟳",
  thinking: "◐",
  responding: "◉",
};

const STATUS_SUFFIX: Record<AgentStatus, string> = {
  idle: "",
  running: "",
  completed: "",
  error: "",
  aborted: "",
  waiting: "",
  awaiting_user: "",
  compacting: "compacting",
  thinking: "thinking",
  responding: "",
};

function workspaceLabel(): string {
  const root = getEnv().rootPath;
  if (!root) return "";
  return root.split(/[\\/]/).filter(Boolean).pop() || "";
}

function writeTitle(title: string): void {
  process.stdout.write(`${OSC_TITLE}${title}${OSC_END}`);
}

function setTitle(appName: string, status: AgentStatus): void {
  const icon = STATUS_ICON[status];
  const suffix = STATUS_SUFFIX[status];
  const prefix = icon ? `${icon} ` : "";
  const title = suffix
    ? `${prefix}${workspaceLabel()} · ${appName} ${suffix}`
    : `${prefix}${workspaceLabel()} · ${appName}`;
  writeTitle(title);
}

function restoreTitle(appName: string): void {
  writeTitle(`${workspaceLabel()} · ${appName}`);
}

/** Live-updating terminal window title (OSC-0). */
export function TerminalTitle() {
  const session = useAgent((s) => s.session);
  // The window title carries the host's display name (see `AppConfig.productName`).
  const appName = useConfig((s) => s.config.productName) || DEFAULT_APP_NAME;

  useEffect(() => {
    if (!session) return;

    setTitle(appName, session.getSnapshot().status);

    const unsub = session.subscribe(
      (event) => {
        if (event.channel === "state") setTitle(appName, event.payload.status);
      },
      { channels: ["state"] }
    );

    return () => {
      unsub();
      restoreTitle(appName);
    };
  }, [session, appName]);

  return null;
}
