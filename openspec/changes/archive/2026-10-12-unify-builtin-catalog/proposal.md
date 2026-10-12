# Change: Unify built-in command and tool identity in core

## Why

Core already owns the built-in catalogs — `BUILTIN_COMMAND_CATALOG` for slash commands and the
tool factories + `present` descriptors (surfaced through `getToolPresentation` /
`BUILTIN_PRESENTATION`) for tools. But every host re-states them:

- `@codent/app` re-declares each command's `name` / `description` / `usage` in
  `commands/*.ts`, and keeps `ALWAYS_VISIBLE_TOOL_NAMES` / `DETAILED_OUTPUT_TOOL_NAMES` in
  `utils/tool-display.ts` that are already fully implied by core's built-in presentation table.
- `@codent/acp` re-lists tool names in `tools.ts` (`NAME_KIND_OVERRIDES`, `TITLE_VERBS`) and
  re-switches on command names in `commands.ts`.
- `@codent/im-bridge` re-lists tool names in `interaction/render.ts`.

So adding or renaming a built-in means edits in several packages, and drift is only caught after the
fact by parity scripts. The goal is one place to change: core.

## What Changes

- **Core is the single source of identity.** Export a canonical built-in tool identifier registry
  (`BUILTIN_TOOL_NAMES`) and the `begin_summary` tool name, alongside the existing
  `BUILTIN_COMMAND_CATALOG`. A validator asserts the exported registry matches the tools core
  actually builds, so it cannot drift.
- **`@codent/app`** — command files register behavior only; `name` / `description` / `usage` /
  `aliases` come from the catalog. `utils/tool-display.ts` drops its duplicate visibility sets and
  derives from core presentation; `use-task.ts` and message views use core identifiers.
  - **BREAKING**: the `ALWAYS_VISIBLE_TOOL_NAMES` / `DETAILED_OUTPUT_TOOL_NAMES` exports are removed
    from `@codent/app` (they duplicated core's presentation table; use `getToolPresentation` /
    `keepsCompactRow` from `@codent/core`).
- **`@codent/acp`** — tool kind derives from the core presentation category (with a minimal,
  identifier-keyed override record for `delete` / `fetch`), titles and slash-command dispatch key off
  core identifiers instead of a private name list.
- **`@codent/im-bridge`** — tool formatting keys off core identifiers instead of a private name list.
- **Validators** — the command parity script asserts host commands are catalog-derived (no restated
  metadata) instead of asserting equal strings; a new guard asserts hosts keep no built-in name
  tables.

## Impact

- Affected specs: `tool-presentation`, `builtin-command-catalog` (new)
- Affected code: `packages/core/src/{index.ts,agent/tools/tool-names.ts,agent/commands/catalog.ts}`,
  `packages/app/src/{commands/*,utils/tool-display.ts,hooks/use-task.ts,messages/*}`,
  `packages/acp/src/{tools.ts,commands.ts,agent.ts}`,
  `packages/im-bridge/src/interaction/{render.ts,pending.ts}`, host parity/guard scripts.
- Not breaking the wire: built-in tool and command names are unchanged; this only removes host-side
  copies of them.
