import { errorMessage, toError } from "../../utils/errors.js";
import { AGENT_DATA_DIR } from "../../utils/workspace-paths.js";

import { mcpServerConfigSchema, resolveServerPolicy } from "./types.js";

import type { McpConfig, McpServerConfig } from "./types.js";
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
 * Name the policy problem before the transport schema gets a say.
 *
 * `mcpServerConfigSchema` is a stdio|http union, so zod reports a bad `approval` enum as a generic
 * `invalid_union` ("Invalid input") with no field and no value. `resolveServerPolicy` is the same
 * validator the manager uses, and it names the server, the value and the accepted set.
 */
function policyErrorOf(name: string, raw: unknown): string | null {
  if (raw === null || typeof raw !== "object") return null;
  try {
    resolveServerPolicy(name, raw as McpServerConfig);
    return null;
  } catch (error) {
    return `MCP server "${name}" was skipped — ${toError(error).message}`;
  }
}

/**
 * Read one document into servers, tolerating ONE bad entry.
 *
 * The envelope is parsed loosely and each server strictly, because validating the whole document
 * with `mcpConfigSchema` made a single typo (`"approval": "alwayss"`) throw for the entire file:
 * `loadMcpConfig` returned null, the extension returned before registering anything, and every MCP
 * tool disappeared for that session with only a warn in `agent.log` to explain it. A per-server
 * failure now costs exactly that server, and the error names it and the accepted values.
 */
function parseConfigDocument(parsed: unknown, errors: string[]): McpConfig {
  const envelope = parsed as { mcpServers?: unknown } | null;
  const rawServers = envelope?.mcpServers;
  if (!rawServers || typeof rawServers !== "object" || Array.isArray(rawServers)) {
    throw new Error('expected an object with an "mcpServers" map');
  }

  const mcpServers: Record<string, McpServerConfig> = {};
  for (const [name, raw] of Object.entries(rawServers as Record<string, unknown>)) {
    const policyError = policyErrorOf(name, raw);
    if (policyError) {
      errors.push(policyError);
      continue;
    }
    const result = mcpServerConfigSchema.safeParse(raw);
    if (!result.success) {
      // Structural problems (missing `command` for stdio, wrong `url` type). The union's message is
      // generic, so the first issue's path is prepended when it has one.
      const issue = result.error.issues[0];
      const where = issue && issue.path.length > 0 ? `${issue.path.join(".")}: ` : "";
      errors.push(`MCP server "${name}" is invalid and was skipped — ${where}${issue?.message ?? "invalid"}`);
      continue;
    }
    mcpServers[name] = result.data;
  }
  return { mcpServers };
}

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
      const result = parseConfigDocument(parsed, errors);
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
      config: parseConfigDocument(parsed, errors),
      sourcePath: path,
      loadErrors: errors.length > 0 ? errors : undefined,
    };
  } catch (e) {
    errors.push(`Load mcp config failed: ${path} — ${errorMessage(e)}`);
    return null;
  }
}
