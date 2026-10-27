import { errorMessage } from "../../utils/errors.js";
import { AGENT_DATA_DIR } from "../../utils/workspace-paths.js";

import { mcpConfigSchema } from "./types.js";

import type { McpConfig } from "./types.js";
import type { CoreEnv, CoreEnvFs } from "../../env";

export interface McpConfigLoadResult {
  config: McpConfig;
  sourcePath: string;
  /** Error messages encountered during loading (e.g. parse failures). */
  loadErrors?: string[];
}

// ============================================================================
// Constants
// ============================================================================

export const DEFAULT_MCP_CONFIG_PATH = `${AGENT_DATA_DIR}/mcp.json`;

/**
 * Additional default MCP config file paths (checked in order if no explicit path given).
 * `.mcp.json` is the community-standard MCP config file name used by many tools.
 */
const FALLBACK_MCP_CONFIG_PATHS = [".mcp.json"];

// ============================================================================
// Config Loading
// ============================================================================

/**
 * Load MCP configuration from a JSON file on disk.
 *
 * When `configPath` is explicitly provided, only that single path is checked.
 * When `configPath` is omitted, the primary default (`.agents/mcp.json`) is
 * checked first, then fallback paths (`.mcp.json`) are tried in order.
 *
 * Returns null if no config file is found or all are invalid (MCP disabled).
 */
export async function loadMcpConfig(env: CoreEnv, configPath?: string): Promise<McpConfigLoadResult | null> {
  const fs = env.fs;
  const errors: string[] = [];

  // If an explicit path is given, only check that one
  if (configPath) {
    return loadSingleConfig(fs, configPath, errors);
  }

  // Otherwise, try the primary default first, then fallbacks
  const paths = [DEFAULT_MCP_CONFIG_PATH, ...FALLBACK_MCP_CONFIG_PATHS];
  for (const path of paths) {
    try {
      const exists = await fs.exists(path);
      if (!exists) continue;

      const content = await fs.readFile(path);
      const parsed = JSON.parse(content);
      const result = mcpConfigSchema.parse(parsed);
      return { config: result, sourcePath: path, loadErrors: errors.length > 0 ? errors : undefined };
    } catch (e) {
      errors.push(`Load mcp config failed: ${path} — ${errorMessage(e)}`);
      // Continue to next fallback
    }
  }

  return null;
}

/**
 * Try loading MCP config from a single path.
 */
async function loadSingleConfig(fs: CoreEnvFs, path: string, errors: string[]): Promise<McpConfigLoadResult | null> {
  try {
    const exists = await fs.exists(path);
    if (!exists) {
      errors.push(`MCP config file not found: ${path}`);
      return null;
    }

    const content = await fs.readFile(path);
    const parsed = JSON.parse(content);
    return {
      config: mcpConfigSchema.parse(parsed),
      sourcePath: path,
      loadErrors: errors.length > 0 ? errors : undefined,
    };
  } catch (e) {
    errors.push(`Load mcp config failed: ${path} — ${errorMessage(e)}`);
    return null;
  }
}
