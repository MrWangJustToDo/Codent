/**
 * Validation: `@codent/app` keeps no private table of built-in tool names.
 *
 * Run: pnpm --filter @codent/app run validate:host-tool-names
 */

import { BUILTIN_TOOL_NAMES } from "@codent/core";

import { runHostToolNamesGuard } from "../../../scripts/host-tool-names-guard.mjs";

runHostToolNamesGuard(BUILTIN_TOOL_NAMES, new URL("../src/", import.meta.url), "@codent/app");
