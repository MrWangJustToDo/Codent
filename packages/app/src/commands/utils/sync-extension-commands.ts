/**
 * Bridge extension-registered slash commands into the app registry via Session.dispatch.
 */

import { clearExtensionCommands, registerExtensionCommand } from "./registry.js";

import type { Command } from "./types.js";
import type { AgentSession } from "@codent/core";

/** Split `/cmd a b` args string into argv for extension handlers. */
export function splitExtensionCommandArgs(args: string): string[] {
  const trimmed = args.trim();
  return trimmed ? trimmed.split(/\s+/) : [];
}

function extensionSlashCommand(session: AgentSession, name: string, description: string, hasOptions: boolean): Command {
  const command: Command = {
    name,
    description,
    usage: `/${name}`,
    execute: async (args) => {
      const result = await session.dispatch({
        type: "extension.invokeCommand",
        name,
        args: splitExtensionCommandArgs(args),
      });
      if (!result.ok) return { ok: false, error: result.error };
      const message = result.data?.message;
      return message ? { ok: true, message } : { ok: true };
    },
  };

  // Only commands that expose secondary-menu options (e.g. /skill <name>,
  // /memory <name>) get a browseable options menu. Pure-display commands
  // (e.g. /lsp, /mcp) have no secondary menu and run on submit.
  if (hasOptions) {
    command.usage = `/${name} [option]`;
    // Extensions may expose browseable secondary-menu options (e.g. /skill <name>,
    // /memory <name>) fetched via dispatch — mirrors built-in /resume's getOptions.
    command.allowCustomInput = true;
    // Selecting an option fills `/cmd <option> ` so the user can append follow-up
    // text (e.g. /skill <name> + instructions) before sending. Extension commands
    // are content-loading by nature (skill/memory bodies), so a follow-up prompt
    // is the common intent — unlike /resume which acts immediately on selection.
    command.insertOnSelect = true;
    command.getOptions = async () => {
      const result = await session.dispatch({
        type: "extension.getCommandOptions",
        name,
      });
      if (!result.ok) return [];
      const options = result.data?.options ?? [];
      return options.map((o) => ({ label: o.label, value: o.value, description: o.description }));
    };
  }

  return command;
}

/**
 * Replace extension slash commands from the Session extensions snapshot.
 */
export function syncExtensionCommands(session: AgentSession): void {
  clearExtensionCommands();
  for (const ext of session.getSnapshot().extensions.extensions) {
    if (!ext.enabled) continue;
    for (const { name, hasOptions } of ext.commands) {
      registerExtensionCommand(extensionSlashCommand(session, name, `${ext.name}: /${name}`, hasOptions));
    }
  }
}
