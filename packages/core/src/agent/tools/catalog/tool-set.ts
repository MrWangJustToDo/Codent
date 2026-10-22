import type { AnyClientTool, AnyServerTool } from "@tanstack/ai";

// ============================================================================
// Tools record
// ============================================================================

/** Named TanStack tools assembled for a managed agent. */
export type ToolsRecord = Record<string, AnyServerTool | AnyClientTool>;

export interface ToolsToArrayOptions {
  exclude?: ReadonlySet<string>;
}

/** Flatten a tools record to the array expected by `chat({ tools })`. */
export function toolsToArray(
  tools: ToolsRecord,
  options: ToolsToArrayOptions = {}
): Array<AnyServerTool | AnyClientTool> {
  const exclude = options.exclude ?? new Set<string>();
  const result: Array<AnyServerTool | AnyClientTool> = [];

  // Sort by name so tool-schema prefixes stay byte-stable across Map/object iteration.
  for (const name of Object.keys(tools).sort((a, b) => a.localeCompare(b))) {
    const tool = tools[name];
    if (!tool || exclude.has(name)) continue;
    result.push(tool);
  }

  return result;
}

/** Flatten a tools record to TanStack tools for the agent runner. */
export function resolveToolsRecord(
  record: ToolsRecord,
  options: { exclude?: ReadonlySet<string> } = {}
): Array<AnyServerTool | AnyClientTool> {
  return toolsToArray(record, options);
}
