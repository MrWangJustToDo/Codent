// Import command files to trigger registration
import "./clear.js";
import "./resume.js";
import "./clone.js";
import "./fork.js";
import "./compact.js";
import "./rename.js";
import "./settings.js";
import "./mode.js";
import "./models.js";
import "./help.js";
import "./quit.js";
import "./usage.js";

export {
  clearExtensionCommands,
  dispatchCommand,
  getAllCommands,
  getCommand,
  registerBuiltinCommand,
  registerCommand,
  registerExtensionCommand,
} from "./utils/registry.js";
export type { BuiltinCommandDefinition } from "./utils/registry.js";
export { splitExtensionCommandArgs, syncExtensionCommands } from "./utils/sync-extension-commands.js";
export { COMMAND_FREEFORM_VALUE, typedArgsAfterCommand, withFreeformOption } from "./utils/command-options.js";

export type { Command, CommandContext, CommandOption, CommandResult } from "./utils/types.js";
