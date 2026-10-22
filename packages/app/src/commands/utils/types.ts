import type { AgentAdapter, CommandResult } from "../../adapter/types.js";
import type { UseAgentChatReturn } from "../../hooks/use-agent-chat.js";
import type { useUserInput } from "../../hooks/use-user-input.js";
import type { AgentSession } from "@codent/core";
import type { UIMessage } from "@tanstack/ai";

/**
 * Context passed to every command's execute function.
 */
export interface CommandContext {
  inputActions: ReturnType<typeof useUserInput.getActions>;
  getInputState: () => ReturnType<typeof useUserInput.getReadonlyState>;
  getSession: () => AgentSession | null;
  getMessages?: () => UIMessage[];
  saveSessionFromChat?: () => void;
  exit?: () => void;
  adapter?: AgentAdapter;
  addToolApprovalResponse?: UseAgentChatReturn["addToolApprovalResponse"];
}

export type { CommandResult };

/**
 * Resolves the option list of a **nested** level.
 *
 * `path` is the chain of option values chosen so far, ending with the value of the option that owns
 * this resolver (e.g. `["0:gpt-5.1"]` for the effort level under that model). A resolver may close
 * over what it needs, but the path is what lets one generic menu walk several levels without the
 * option objects having to be rebuilt per keystroke.
 */
export type CommandOptionResolver = (
  ctx?: CommandContext,
  path?: readonly string[]
) => CommandOption[] | Promise<CommandOption[]>;

export interface CommandOption {
  label: string;
  value: string;
  description?: string;
  freeform?: boolean;
  defaultSelected?: boolean;
  /**
   * Visual divider in the option menu — not selectable, not matched while
   * filtering. Label/value are ignored; AutocompleteList renders a rule line.
   */
  separator?: boolean;
  /**
   * Present = selecting this row opens a **submenu** instead of executing the command.
   *
   * The menu is generic: `Esc` retreats one level (it does not close the menu until the root
   * level), and a selection that has no `getOptions` executes as before (`/cmd <path…> <value>`).
   * A row whose submenu would be empty must NOT declare this — an empty level is indistinguishable
   * from a broken one, and the user would be stuck one level deep with nothing to pick.
   */
  getOptions?: CommandOptionResolver;
}

export interface Command {
  name: string;
  /**
   * Extra names this command answers to (dispatch + autocomplete). Kept for
   * renames users have in muscle memory — e.g. `/appearance` after the command
   * became `/settings`. Aliases are not listed by `/help`.
   */
  aliases?: readonly string[];
  description: string;
  usage: string;
  execute: (args: string, ctx: CommandContext) => CommandResult | Promise<CommandResult>;
  immediate?: boolean;
  /**
   * The option list for one level of the menu.
   *
   * `path` is the chain of values already chosen (empty at the root), so a command that nests can
   * serve every level from one resolver — see {@link CommandOption.getOptions}.
   */
  getOptions?: (ctx?: CommandContext, path?: readonly string[]) => CommandOption[] | Promise<CommandOption[]>;
  allowCustomInput?: boolean;
  /**
   * Selecting a secondary-menu option fills `/cmd <option> ` into the input
   * (instead of executing immediately), letting the user append text before
   * submitting. Use for commands where an option is a prefix for a larger
   * request (e.g. /skill <name> + follow-up instructions).
   */
  insertOnSelect?: boolean;
}
