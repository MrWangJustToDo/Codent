/**
 * Validation: `@codent/im-bridge` keeps no private table of built-in tool names.
 *
 * Run: pnpm --filter @codent/im-bridge run validate:host-tool-names
 */

import { BUILTIN_TOOL_NAMES } from "@codent/core";

import { runHostToolNamesGuard } from "../../../scripts/host-tool-names-guard.mjs";

runHostToolNamesGuard(BUILTIN_TOOL_NAMES, new URL("../src/", import.meta.url), "@codent/im-bridge");
