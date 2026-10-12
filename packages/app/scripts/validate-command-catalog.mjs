/**
 * Command-catalog parity — the app's built-in commands MUST be derived from the core
 * `BUILTIN_COMMAND_CATALOG` (the single source of truth a headless host, ACP, also
 * advertises). Command files register behavior via `registerBuiltinCommand`, which
 * sources `name` / `aliases` / `description` / `usage` from the catalog, so this script
 * asserts the two cannot drift: every catalog entry is registered, and no app command
 * carries a value of its own that disagrees with the catalog.
 *
 * Run: pnpm --filter @codent/app run validate:command-catalog
 */

import { BUILTIN_COMMAND_CATALOG, findBuiltinCommand } from "@codent/core";

import { getAllCommands } from "../dist/index.mjs";

// At module-load time only built-ins are registered (extension commands sync later).
const appCommands = getAllCommands();
const problems = [];
const registered = new Set();

for (const cmd of appCommands) {
  registered.add(cmd.name);
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
  if (entry.usage !== cmd.usage) {
    problems.push(`usage drift for "/${cmd.name}":\n  catalog: ${entry.usage}\n  app:     ${cmd.usage}`);
  }
  const entryAliases = [...(entry.aliases ?? [])].sort().join(",");
  const cmdAliases = [...(cmd.aliases ?? [])].sort().join(",");
  if (entryAliases !== cmdAliases) {
    problems.push(`alias drift for "/${cmd.name}":\n  catalog: ${entryAliases}\n  app:     ${cmdAliases}`);
  }
}

for (const entry of BUILTIN_COMMAND_CATALOG) {
  if (!registered.has(entry.name)) {
    problems.push(`catalog command "/${entry.name}" is not registered by the app`);
  }
}

if (problems.length > 0) {
  console.error("command-catalog parity FAILED:\n" + problems.join("\n"));
  process.exit(1);
}

console.log(`command-catalog parity OK (${appCommands.length} built-in commands, catalog-derived)`);
