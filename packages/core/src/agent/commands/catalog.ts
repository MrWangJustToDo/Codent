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
   * The `AgentSessionCommand` type this command ultimately dispatches, when it
   * maps to exactly one (its type name, e.g. `"session.new"`). `undefined` means
   * the command is handled entirely in the host UI (e.g. `/settings`, `/quit`).
   */
  command?: string;
}

/** The canonical built-in command list. Keep descriptions in sync with the app handlers. */
export const BUILTIN_COMMAND_CATALOG: readonly BuiltinCommandInfo[] = [
  {
    name: "clear",
    description: "Clear the screen and start a new session",
    usage: "/clear",
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
    name: "effort",
    description: "Configure reasoning effort for the current model (thinking depth)",
    usage: "/effort [low|medium|high|...|off] | /effort display [on|off]",
    scope: "both",
    command: "effort.set",
  },
  {
    name: "models",
    description: "Switch the model for the current session (models.json entries)",
    usage: "/models [entryIndex:modelId] | /models",
    scope: "ui",
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
    description: "Toggle UI appearance — color theme, transcript density, diff renderer — and edit the model config",
    usage: "/settings [theme|display|diff|config]",
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
