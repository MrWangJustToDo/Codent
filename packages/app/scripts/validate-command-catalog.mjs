/**
 * Command-catalog parity — the app's built-in commands MUST match the core
 * `BUILTIN_COMMAND_CATALOG` (name + description), which is the single source of
 * truth a headless host (ACP) advertises. Drift here means the ACP
 * `available_commands_update` and the terminal `/help` disagree.
 *
 * Run: pnpm --filter @codent/app run validate:command-catalog
 */

import { BUILTIN_COMMAND_CATALOG, findBuiltinCommand } from "@codent/core";

import { getAllCommands } from "../dist/index.mjs";

// At module-load time only built-ins are registered (extension commands sync later).
const appCommands = getAllCommands();
const problems = [];

for (const cmd of appCommands) {
  const entry = findBuiltinCommand(cmd.name);
  if (!entry) {
    problems.push(`app command "/${cmd.name}" is missing from BUILTIN_COMMAND_CATALOG`);
    continue;
  }
  if (entry.description !== cmd.description) {
    problems.push(
      `description drift for "/${cmd.name}":\n  catalog: ${entry.description}\n  app:     ${cmd.description}`
    );
  }
}

for (const entry of BUILTIN_COMMAND_CATALOG) {
  if (!appCommands.some((c) => c.name === entry.name)) {
    problems.push(`catalog command "/${entry.name}" is not registered by the app`);
  }
}

if (problems.length > 0) {
  console.error("command-catalog parity FAILED:\n" + problems.join("\n"));
  process.exit(1);
}

console.log(`command-catalog parity OK (${appCommands.length} built-in commands)`);
