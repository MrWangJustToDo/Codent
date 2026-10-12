import { formatKeyboardShortcutsHelp } from "../utils/keyboard-labels.js";

import { getAllCommands, registerBuiltinCommand } from "./utils/registry.js";

registerBuiltinCommand("help", {
  immediate: true,
  execute: () => {
    const commands = getAllCommands();
    const commandLines = commands.map((c) => `  ${c.usage.padEnd(30)} ${c.description}`);
    return {
      ok: true,
      message: [
        formatKeyboardShortcutsHelp(),
        "",
        "Available commands:",
        ...commandLines,
        "",
        "Tip: /settings, /mode, /resume open option menus after Tab/Enter.",
      ].join("\n"),
    };
  },
});
