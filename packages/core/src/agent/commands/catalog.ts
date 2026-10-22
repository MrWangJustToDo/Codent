/**
 * Built-in slash-command catalog — the single source of truth for the commands
 * a host may advertise and invoke.
 *
 * Two consumers share this list, which is why it lives in core rather than in
 * the app or the ACP package:
 *
 * - `@codent/app` renders the built-in commands (and its registry is asserted
 *   against this catalog so the two cannot drift), and
 * - a headless host (`@codent/acp`) advertises them to a client
 *   (`available_commands_update`) without importing the app UI layer.
 *
 * It is deliberately metadata only (`name`/`aliases`/`description`/`usage` +
 * the optional `AgentSessionCommand` type name it maps to) — the executable
 * handlers stay in the app, and the ACP host dispatches through
 * `AgentSession.dispatch`.
 */

import type { AgentSessionCommand } from "../../agent-session/types.js";

/**
 * Where a command is meaningful. A headless ACP host filters to
 * `scope !== "ui"`; the terminal app shows all of them.
 */
export type BuiltinCommandScope = "ui" | "agent" | "both";

export interface BuiltinCommandInfo {
  /** Primary command token (without the leading `/`). */
  name: string;
  /** Extra tokens that resolve to this command (not listed by `/help`). */
  aliases?: readonly string[];
  /** Human-readable one-line description. */
  description: string;
  /** Usage string shown in `/help` and advertised to ACP clients. */
  usage: string;
  /** Where the command applies (see {@link BuiltinCommandScope}). */
  scope: BuiltinCommandScope;
  /**
   * The primary `AgentSessionCommand` this command dispatches (its type name, e.g.
   * `"session.new"`), so a host can route without restating the command name. A command
   * may dispatch more than one session command (e.g. `/mode` also toggles, `/rename` also
   * generates, `/models` also sets the thinking depth) — this is the entry's primary and the
   * host handles the rest. `undefined` means the command is handled entirely in the host UI
   * (e.g. `/settings`, `/quit`).
   *
   * Typed as the `AgentSessionCommand` discriminant so a headless host's dispatch switch
   * is compile-checked against core and a catalog typo is a build error, not a silently
   * dead command.
   */
  command?: AgentSessionCommand["type"];
}

/** The canonical built-in command list. Keep descriptions in sync with the app handlers. */
export const BUILTIN_COMMAND_CATALOG: readonly BuiltinCommandInfo[] = [
  {
    name: "new",
    description: "Start a new session",
    usage: "/new",
    scope: "both",
    command: "session.new",
  },
  {
    name: "resume",
    description: "Resume a previous session",
    usage: "/resume [session-id or name]",
    scope: "both",
    command: "session.resume",
  },
  {
    name: "clone",
    description: "Clone this session into a new one and switch to it",
    usage: "/clone [name]",
    scope: "both",
    command: "session.clone",
  },
  {
    name: "fork",
    description: "Start a new session from an earlier user message",
    usage: "/fork [message]",
    scope: "ui",
    command: "session.fork",
  },
  {
    name: "compact",
    description: "Compress conversation context to reduce token usage",
    usage: "/compact [focus]",
    scope: "both",
    command: "compact",
  },
  {
    name: "rename",
    description: "Rename current session (or auto-generate a title)",
    usage: "/rename [title]",
    scope: "both",
    command: "rename",
  },
  {
    name: "mode",
    description: "Switch agent mode — normal / auto / plan (contextual menu)",
    usage: "/mode [plan|auto|off|switch plan|switch auto|status|execute|done|cancel|save [name]|load <name>|list]",
    scope: "both",
    command: "mode.set",
  },
  {
    name: "models",
    description: "Switch model and thinking depth (models.json entries)",
    usage: "/models [entryIndex:modelId [effort|off]]",
    scope: "both",
    command: "model.set",
  },
  {
    name: "usage",
    description: "Show session token usage, cost, and a global activity graph",
    usage: "/usage [Nw]",
    scope: "both",
    command: "usage.history",
  },
  {
    name: "help",
    description: "Show keyboard shortcuts and available commands",
    usage: "/help",
    scope: "ui",
  },
  {
    name: "settings",
    aliases: ["appearance"],
    description:
      "Toggle UI appearance — color theme, transcript density, diff renderer, thinking line — and edit the model config",
    usage: "/settings [theme|display|diff|thinking|config]",
    scope: "ui",
  },
  {
    name: "quit",
    description: "Exit the cli",
    usage: "/quit",
    scope: "ui",
  },
] as const;

/** Look up a catalog entry by name or alias. */
export function findBuiltinCommand(token: string): BuiltinCommandInfo | undefined {
  return BUILTIN_COMMAND_CATALOG.find((c) => c.name === token || c.aliases?.includes(token));
}

/**
 * The commands a headless agent host should advertise (everything not purely a
 * UI concern), each as `{ name, description }` — the minimal shape ACP's
 * `available_commands_update` needs.
 */
export function listAdvertisableCommands(): Array<{ name: string; description: string }> {
  return BUILTIN_COMMAND_CATALOG.filter((c) => c.scope !== "ui").map((c) => ({
    name: c.name,
    description: c.description,
  }));
}
