import { parseModelStyle, resolveModelConnection } from "@codent/core";
import { createRequire } from "node:module";

import { parseModelInfoFromEnv } from "./model-env.js";

import type { AppConfig } from "@codent/app";
import type { ModelStyle } from "@codent/core";

// ============================================================================
// Argument Parsing (local-only, remote-provider plane)
// ============================================================================
//
// `codent` is the local-only release host. It carries `--remote-provider`
// (LLM keys on a remote server, orthogonal to the local CoreEnv) so the
// provider server can hold the API keys while the workspace stays local.
// The other two remote planes the development host (`@codent/cli`) has —
// `--remote-env` (workspace) and `--remote-session` (whole agent loop) — are
// intentionally absent here, so neither `REMOTE_ENV` / `REMOTE_SESSION` nor a
// conflicting flag pair is ever parsed.

/** Default max iterations for the CLI host agent loop. */
export const CLI_DEFAULT_MAX_ITERATIONS = 50;

interface ParsedArgs {
  positional: string[];
  flags: Record<string, string | boolean>;
}

function parseArgs(args: string[]): ParsedArgs {
  const result: ParsedArgs = { positional: [], flags: {} };
  let i = 0;
  while (i < args.length) {
    const arg = args[i];
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const nextArg = args[i + 1];
      if (nextArg && !nextArg.startsWith("-")) {
        result.flags[key] = nextArg;
        i += 2;
      } else {
        result.flags[key] = true;
        i += 1;
      }
    } else if (arg.startsWith("-") && arg.length > 1) {
      const key = arg.slice(1);
      const nextArg = args[i + 1];
      if (nextArg && !nextArg.startsWith("-")) {
        result.flags[key] = nextArg;
        i += 2;
      } else {
        result.flags[key] = true;
        i += 1;
      }
    } else {
      result.positional.push(arg);
      i += 1;
    }
  }
  return result;
}

function getFlag(args: ParsedArgs, ...keys: string[]): string | boolean | undefined {
  for (const key of keys) {
    if (args.flags[key] !== undefined) return args.flags[key];
  }
  return undefined;
}

function getFlagString(args: ParsedArgs, defaultValue: string, ...keys: string[]): string {
  const value = getFlag(args, ...keys);
  return typeof value === "string" ? value : defaultValue;
}

function getFlagNumber(args: ParsedArgs, defaultValue: number, ...keys: string[]): number {
  const value = getFlag(args, ...keys);
  if (typeof value === "string") {
    const num = parseInt(value, 10);
    return isNaN(num) ? defaultValue : num;
  }
  return defaultValue;
}

function getFlagBoolean(args: ParsedArgs, ...keys: string[]): boolean {
  const value = getFlag(args, ...keys);
  return value === true || value === "true";
}

function parseCliStyle(raw: string | undefined): ModelStyle | undefined {
  if (!raw) return undefined;
  return parseModelStyle(raw);
}

// ============================================================================
// Environment Helpers
// ============================================================================

const getEnv = (key: string, fallback: string = ""): string => process.env[key] ?? fallback;

// ============================================================================
// Main Export
// ============================================================================

export interface ParsedCliConfig extends Partial<AppConfig> {
  /** Remote model provider URL (`--remote-provider` / REMOTE_PROVIDER).
   *  Orthogonal to CoreEnv — the provider server holds the LLM keys while the
   *  workspace stays on the local filesystem. */
  remoteProvider?: string;
  /** Whether any model-related flag was passed explicitly on the CLI
   *  (`--model` / `--style` / `--base-url` / `--api-key`), as opposed to
   *  only `.env` defaults. */
  modelExplicit?: boolean;
}

export function parseCliArgs(argv: string[]): ParsedCliConfig {
  const parsed = parseArgs(argv);

  const envModel = getEnv("MODEL") || getEnv("model");
  const envMaxIterations = getEnv("MAX_ITERATIONS") || getEnv("maxIterations");
  const envMaxIter = envMaxIterations ? parseInt(envMaxIterations, 10) : CLI_DEFAULT_MAX_ITERATIONS;
  const envMaxConcurrentTasks = getEnv("MAX_CONCURRENT_TASKS") || getEnv("maxConcurrentTasks");

  const cliStyle = parseCliStyle(getFlagString(parsed, "", "style"));
  const cliBaseURL = getFlagString(parsed, "", "base-url", "baseURL", "url", "u");
  const cliApiKey = getFlagString(parsed, "", "api-key", "k");

  const envModelId = getFlagString(parsed, envModel, "model", "m");
  const cliModel = getFlagString(parsed, "", "model", "m");
  const envStyle = parseCliStyle(getEnv("MODEL_STYLE") || getEnv("STYLE") || undefined);
  const envBaseURL = getEnv("BASE_URL") || getEnv("MODEL_BASE_URL") || undefined;
  const envApiKey = getEnv("API_KEY") || undefined;

  const modelExplicit = Boolean(cliModel || cliStyle || cliBaseURL || cliApiKey);

  const connection = resolveModelConnection({
    model: envModelId,
    style: cliStyle ?? envStyle,
    baseURL: cliBaseURL || envBaseURL,
    apiKey: cliApiKey || envApiKey,
  });

  const modelInfo = connection.model
    ? parseModelInfoFromEnv(process.env, connection.model, connection.style === "anthropic" ? "anthropic" : "openai")
    : undefined;

  const braveApiKey = getEnv("BRAVE_API_KEY") || undefined;
  const exaApiKey = getEnv("EXA_API_KEY") || undefined;
  const parallelApiKey = getEnv("PARALLEL_API_KEY") || undefined;
  const tavilyApiKey = getEnv("TAVILY_API_KEY") || undefined;
  const websearchProvider = getEnv("WEBSEARCH_PROVIDER") || undefined;
  const websearchConfig = {
    ...(braveApiKey ? { braveApiKey } : {}),
    ...(exaApiKey ? { exaApiKey } : {}),
    ...(parallelApiKey ? { parallelApiKey } : {}),
    ...(tavilyApiKey ? { tavilyApiKey } : {}),
    ...(websearchProvider ? { provider: websearchProvider } : {}),
  };
  const toolConfig = Object.keys(websearchConfig).length > 0 ? { websearch: websearchConfig } : undefined;

  let resumeSession = "";
  const resumeFlag = getFlag(parsed, "resume", "r");
  if (typeof resumeFlag === "string") {
    resumeSession = resumeFlag;
  } else if (resumeFlag === true) {
    resumeSession = "__picker__";
  }

  const envMcpConfig = getEnv("MCP_CONFIG_PATH");

  // Extra dirs from CLI only; `AGENT_EXTENSION_DIRS` is read in core `getDefaultExtensionDirs`.
  const extensionDirsRaw = getFlagString(parsed, "", "extension-dirs", "extension-dir");
  const extensionDirs = extensionDirsRaw
    .split(",")
    .map((d) => d.trim())
    .filter((d) => d.length > 0);

  const maxConcurrentTasks = getFlagNumber(
    parsed,
    envMaxConcurrentTasks ? parseInt(envMaxConcurrentTasks, 10) : NaN,
    "max-concurrent-tasks"
  );

  // Remote provider plane (`--remote-provider` / REMOTE_PROVIDER): orthogonal to
  // CoreEnv — the workspace stays local while the LLM keys live on the server.
  const envRemoteProvider = getEnv("REMOTE_PROVIDER");
  const remoteProviderFlag = getFlag(parsed, "remote-provider");
  const remoteProvider = typeof remoteProviderFlag === "string" ? remoteProviderFlag : envRemoteProvider || undefined;

  return {
    model: connection.model,
    style: connection.style,
    baseURL: connection.baseURL,
    apiKey: connection.apiKey,
    ...(remoteProvider ? { remoteProvider } : {}),
    systemPrompt: getFlagString(parsed, "", "system", "s"),
    initialPrompt: parsed.positional.join(" "),
    maxIterations: getFlagNumber(parsed, isNaN(envMaxIter) ? CLI_DEFAULT_MAX_ITERATIONS : envMaxIter, "max-iterations"),
    ...(Number.isFinite(maxConcurrentTasks) ? { maxConcurrentTasks } : {}),
    debug: getFlagBoolean(parsed, "debug", "d"),
    mcpConfigPath: getFlagString(parsed, envMcpConfig, "mcp-config"),
    extensionDirs,
    continueSession: getFlagBoolean(parsed, "continue", "c"),
    resumeSession,
    modelExplicit,
    ...(modelInfo ? { modelInfo } : {}),
    ...(toolConfig ? { toolConfig } : {}),
  };
}

export const isHelpRequested = (argv: string[]): boolean => {
  const parsed = parseArgs(argv);
  return getFlagBoolean(parsed, "help", "h");
};

const requireFromCli = createRequire(import.meta.url);

/**
 * Version string of the installed `codent` package. `dist/index.mjs` sits next
 * to `package.json` both in the monorepo and in the published tarball, so this
 * resolves correctly before and after `npm install -g`.
 */
export function cliVersion(): string {
  return (requireFromCli("../package.json") as { version: string }).version;
}

export const isVersionRequested = (argv: string[]): boolean => {
  const parsed = parseArgs(argv);
  return getFlagBoolean(parsed, "version", "v");
};
