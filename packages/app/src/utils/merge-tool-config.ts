import type { AgentToolConfig, WebsearchToolConfig } from "@codent/core";

/**
 * Merge the websearch `toolConfig` from a loaded `models.json` (`global.toolConfig`) into
 * the host-provided `toolConfig`.
 *
 * Precedence is **per field**: the host (CLI/env) value wins, the file fills the gaps. A
 * file that sets `provider: "parallel"` while the env supplies a Brave key yields both.
 * The file's `websearchProvider` spelling is already normalized to `provider` by
 * `loadModels` (see `normalizeGlobalToolConfig`), so this only deals with the new name.
 *
 * Returns the host config unchanged when the file declares nothing, and a fresh object
 * when it does — the inputs are not mutated.
 */
export function mergeModelsConfigToolConfig(
  hostConfig: AgentToolConfig | undefined,
  fileConfig: { toolConfig?: { provider?: string; [key: string]: unknown } } | undefined
): AgentToolConfig | undefined {
  const file = fileConfig?.toolConfig;
  if (!file) return hostConfig;

  const merged: WebsearchToolConfig = { ...(file as WebsearchToolConfig) };
  for (const [key, value] of Object.entries(hostConfig?.websearch ?? {})) {
    if (value !== undefined && value !== "") {
      (merged as Record<string, unknown>)[key] = value;
    }
  }

  return { ...hostConfig, websearch: merged };
}
