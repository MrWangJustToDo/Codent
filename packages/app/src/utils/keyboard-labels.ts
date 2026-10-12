/**
 * Terminal (Ink) keyboard chord labels — single source for UI copy.
 *
 * Conventions:
 * - Prefer what Ink actually receives, not desktop-app habits.
 * - TUI chords use **Ctrl**, never Cmd/⌘ (terminals deliver Control; ⌘ is usually
 *   eaten by the host terminal or OS).
 * - The newline chord is **Ctrl+J** (the raw `\n` character), which every
 *   terminal delivers reliably. Option/Alt+Enter sends \x1b\r (ESC+CR) which
 *   parseKeypress detects as `meta+return` on macOS.
 * - Shift+Enter is **not** reliable: it sends \r like plain Enter (or an
 *   unrecognized \x1b\r) on most terminals and cannot be distinguished, so it
 *   must never be advertised as the newline key.
 * - Platform comes from CoreEnv (`getPlatform`), never `process.platform`.
 */

import type { CoreEnv } from "@codent/core";

/** Cached CoreEnv platform id (`darwin`, `linux`, `win32`, …). */
let cachedPlatform: string | undefined;

/**
 * Refresh the cached platform from the active session's CoreEnv.
 * Call during workspace / agent bootstrap with that runtime's env.
 */
export async function refreshKeyboardPlatform(env?: CoreEnv): Promise<string | undefined> {
  // Keyboard shortcuts reflect the physical terminal the user types in, not the
  // (possibly remote) CoreEnv the agent runs on — a macOS CLI attached to a
  // Linux server must still show ⌘ labels. Node hosts report the local platform
  // directly; other hosts (e.g. the browser playground) fall back to CoreEnv.
  if (typeof process !== "undefined" && typeof process.platform === "string") {
    cachedPlatform = process.platform;
    return cachedPlatform;
  }
  if (!env) {
    cachedPlatform = undefined;
    return undefined;
  }
  cachedPlatform = await env.getPlatform();
  return cachedPlatform;
}

/** Last CoreEnv platform from {@link refreshKeyboardPlatform}, if any. */
export function getCachedKeyboardPlatform(): string | undefined {
  return cachedPlatform;
}

export function isMacPlatform(): boolean {
  return cachedPlatform === "darwin";
}

/** Canonical chord strings for tips / help / footers. */
export const KeyLabel = {
  enter: "Enter",
  esc: "Esc",
  slash: "/",
  tab: "Tab",
  space: "Space",
  upDown: "↑↓",
  leftRight: "←→",
  y: "y",
  n: "n",
  p: "p",
  r: "R",
  ctrlA: "Ctrl+A",
  ctrlC: "Ctrl+C",
  ctrlE: "Ctrl+E",
  ctrlJ: "Ctrl+J",
  ctrlO: "Ctrl+O",
  ctrlP: "Ctrl+P",
  ctrlT: "Ctrl+T",
  ctrlU: "Ctrl+U",
  ctrlV: "Ctrl+V",
  ctrlX: "Ctrl+X",
  ctrlY: "Ctrl+Y",
  shiftEnter: "Shift+Enter",
  shiftTab: "Shift+Tab",
} as const;

export type KeyLabelId = keyof typeof KeyLabel;

/**
 * Chord for Option/Ctrl+Enter (macOS) or Shift+Enter (Linux) — force-submit while
 * running; also used as the advertised modified-Enter chord in help text.
 *
 * On macOS, Option+Enter sends \x1b\r which parseKeypress detects as meta+return.
 */
export function modifiedEnterLabel(): string {
  // On macOS advertise Ctrl+Enter as a reliable fallback; Option+Enter is the meta key.
  return isMacPlatform() ? "Option/Ctrl+Enter" : KeyLabel.shiftEnter;
}

/**
 * Idle newline chord — Ctrl+J sends the raw `\n` character, which every
 * terminal delivers reliably (unlike Shift+Enter, whose `\x1b\r` sequence is
 * not recognized on many Linux terminals).
 */
export function newlineEnterLabel(): string {
  return KeyLabel.ctrlJ;
}

export function exitAbortLabel(): string {
  return `${KeyLabel.ctrlC} / ${KeyLabel.esc}`;
}

export function approveDenyLabel(): string {
  return `${KeyLabel.y} / ${KeyLabel.n}`;
}

/** Header tip row — keys come from {@link KeyLabel}. */
export function headerShortcutTips(): ReadonlyArray<{ key: string; desc: string }> {
  return [
    { key: KeyLabel.slash, desc: "for commands" },
    { key: KeyLabel.shiftTab, desc: "Cycle mode" },
    { key: KeyLabel.ctrlE, desc: "workspace" },
    { key: KeyLabel.ctrlT, desc: "task panel" },
    { key: KeyLabel.ctrlY, desc: "extensions panel" },
  ];
}

export interface ShortcutSection {
  title: string;
  lines: ReadonlyArray<{ key: string; desc: string }>;
}

/** Full shortcut reference for `/help` and the startup Help screen. */
export function getKeyboardShortcutSections(): ShortcutSection[] {
  const modifiedEnter = modifiedEnterLabel();
  const newline = newlineEnterLabel();
  return [
    {
      title: "Chat",
      lines: [
        { key: KeyLabel.enter, desc: "Submit prompt (while running: queue follow-up)" },
        { key: `${newline} (idle)`, desc: "Insert newline when idle" },
        { key: `${modifiedEnter} (running)`, desc: "Force-submit while running (abort + new turn)" },
        { key: KeyLabel.esc, desc: "Abort current run / dismiss UI" },
        { key: KeyLabel.ctrlC, desc: "Exit the app" },
        { key: KeyLabel.ctrlU, desc: "Clear input" },
        { key: KeyLabel.ctrlA, desc: "Select all input" },
        { key: KeyLabel.ctrlO, desc: "Expand/collapse pasted text placeholder" },
        { key: KeyLabel.ctrlV, desc: "Paste image from clipboard" },
        { key: KeyLabel.slash, desc: "Open slash commands" },
      ],
    },
    {
      title: "Panels",
      lines: [
        { key: KeyLabel.shiftTab, desc: "Cycle mode" },
        { key: KeyLabel.ctrlP, desc: "Review plan markdown (when plan ready, input empty)" },
        { key: KeyLabel.enter, desc: "Build approved plan (when plan preview is open)" },
        { key: KeyLabel.ctrlE, desc: "Workspace panel" },
        { key: KeyLabel.ctrlT, desc: "Task / subagent panel" },
        { key: KeyLabel.ctrlY, desc: "Extensions panel (view / toggle)" },
      ],
    },
    {
      title: "Approvals",
      lines: [
        { key: KeyLabel.y, desc: "Approve tool (when input empty)" },
        { key: KeyLabel.n, desc: "Deny tool / enter reason" },
      ],
    },
    {
      title: "Navigation",
      lines: [
        { key: KeyLabel.upDown, desc: "History / autocomplete / lists" },
        { key: KeyLabel.tab, desc: "Accept autocomplete suggestion" },
        { key: `${KeyLabel.esc} (autocomplete)`, desc: "Dismiss suggestions" },
      ],
    },
  ];
}

/** Format shortcut sections for CommandOutput / terminal. */
export function formatKeyboardShortcutsHelp(): string {
  const sections = getKeyboardShortcutSections();
  const lines: string[] = ["Keyboard shortcuts", ""];
  for (const section of sections) {
    lines.push(section.title);
    for (const row of section.lines) {
      lines.push(`  ${row.key.padEnd(28)} ${row.desc}`);
    }
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}

/** Workspace panel footer hint. */
export function workspacePanelHint(): string {
  return `${KeyLabel.tab} preview/diff · ${KeyLabel.leftRight} focus · ${KeyLabel.upDown} scroll · ${KeyLabel.enter} open · [ ] files · ${KeyLabel.r} refresh · ${KeyLabel.ctrlP} find · ${KeyLabel.ctrlE}/${KeyLabel.esc} close`;
}

/** Busy-agent footer: follow-up / force-submit / abort. */
export function busyQueueHint(steerCount: number, followUpCount: number): string {
  const follow = `${KeyLabel.enter}: follow-up${followUpCount > 0 ? ` (${followUpCount})` : ""}`;
  const force = `${modifiedEnterLabel()}: force submit`;
  const parts = [follow, force, `${KeyLabel.esc}: abort`];
  if (steerCount > 0) {
    parts.unshift(`steer queued (${steerCount})`);
  }
  return parts.join(" | ");
}

export function freeformSubmitHint(): string {
  return `Submit: ${KeyLabel.enter} | Cancel: ${KeyLabel.esc}`;
}

export function approvalKeysHint(): string {
  return `${KeyLabel.y}: approve | ${KeyLabel.n}: deny`;
}

/** e.g. "↑↓ navigate, Enter open, Esc back" */
export function listNavHint(action: string, back = "back"): string {
  return `(${KeyLabel.upDown} navigate, ${KeyLabel.enter} ${action}, ${KeyLabel.esc} ${back})`;
}

export function pressEscToReturnHint(): string {
  return `Press ${KeyLabel.esc} to return.`;
}

/** ask_user / select-list footer hints. */
export function selectListHint(options: { multiSelect: boolean; cursorOnFreeform: boolean }): string {
  const { multiSelect, cursorOnFreeform } = options;
  if (multiSelect) {
    return cursorOnFreeform
      ? `${KeyLabel.upDown} | ${KeyLabel.space}: toggle | →: edit answer | ${KeyLabel.enter}: submit`
      : `${KeyLabel.upDown} | ${KeyLabel.space}: toggle | ${KeyLabel.enter}: submit`;
  }
  return cursorOnFreeform
    ? `${KeyLabel.upDown} | →: edit answer | ${KeyLabel.enter}: submit`
    : `${KeyLabel.upDown} | ${KeyLabel.enter}: select`;
}

/**
 * True when the user pressed a modified Enter that should mean force-submit (busy)
 * or newline (idle) — not a plain submit/follow-up.
 *
 * - `meta` + return: Option+Enter on macOS / Alt+Enter on Linux
 *   (ESC+CR, detected as meta)
 * - `shift` + return: Shift+Enter (only works on terminals that send \x1b\r;
 *   on macOS terminals Shift+Enter sends \r like plain Enter and cannot be
 *   distinguished — use Option+Enter instead)
 * - `ctrl` + return: Ctrl+Enter
 * - `ctrl` + `\n`: Ctrl+J (some terminals map Ctrl+Enter this way)
 */
export function isModifiedEnter(
  inputChar: string,
  key: { return?: boolean; shift?: boolean; meta?: boolean; ctrl?: boolean }
): boolean {
  if (key.return && (key.shift || key.meta || key.ctrl)) return true;
  if (key.ctrl && inputChar === "\n") return true;
  return false;
}
