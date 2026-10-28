import { DEFAULT_AGENT_MAX_ITERATIONS, parseModelStyle, resolveModelConnection } from "@codent/core";
import { createRequire } from "node:module";

import { parseModelInfoFromEnv } from "./model-env.js";

import type { AppConfig } from "@codent/app";
import type { ModelStyle } from "@codent/core";

// ============================================================================
// Argument Parsing
// ============================================================================

interface ParsedArgs {
  positional: string[];
  flags: Record<string, string | boolean>;
}

/**
 * TODO(cli-args): this hand-rolled parser DROPS input silently in three reachable shapes:
 *
 * 1. A value starting with `-` is consumed as the NEXT flag, not as a value. `--max-iterations -1`
 *    parses as `max-iterations: true` plus a flag literally named `1`, so `getFlagNumber` falls
 *    back to the default and the user's `-1` is gone with no error. Same for any model id, path or
 *    prompt that starts with `-`.
 * 2. A positional (the initial prompt) starting with `-` is swallowed as a flag too, so
 *    `codent "--fix the bug"` sends no prompt at all — it just sets `true` under some key.
 * 3. Unknown flags (`--max-iteration` typo, `--model=x` equals-form) are accepted into `flags`
 *    and never read by anything. Nothing validates the flag set, so a typo is indistinguishable
 *    from "accepted but ignored" and the default silently applies.
 *
 * Fix by using a real parser, or at minimum: treat a leading `-` as a flag only when it names a
 * known flag, reject unknown flags, and support `--flag=value`.
 */
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
  /** Always resolved (flag > env > core default), so a host never has to re-apply a fallback. */
  maxIterations: number;
  /**
   * Raw `--sandbox` value. `parseCliArgs` stays pure (no process/env side effects); the host
   * validates it and applies flag > `SANDBOX_ENV` > `local`.
   */
  sandbox?: string;
  /** CoreEnv workspace remote URL (`--remote-env` / REMOTE_ENV). */
  remoteEnv?: string;
  /** Remote model provider URL (`--remote-provider` / REMOTE_PROVIDER). Orthogonal to CoreEnv. */
  remoteProvider?: string;
  /** Remote Agent Session URL (`--remote-session` / REMOTE_SESSION). */
  remoteSession?: string;
  /** Whether any model-related flag was passed explicitly on the CLI
   *  (`--model` / `--style` / `--base-url` / `--api-key`), as opposed to
   *  only `.env` defaults. Lets a `--remote-session` host defer model
   *  resolution to the server when nothing was given explicitly. */
  modelExplicit?: boolean;
}

export function parseCliArgs(argv: string[]): ParsedCliConfig {
  const parsed = parseArgs(argv);
  // `--sandbox` without a value is a flag with `true`; keep it as an empty string so the host's
  // resolver rejects it instead of silently falling back to the env/default.
  const sandboxFlag = getFlag(parsed, "sandbox");

  const envModel = getEnv("MODEL") || getEnv("model");
  const envMaxIterations = getEnv("MAX_ITERATIONS") || getEnv("maxIterations");
  const envMaxIter = envMaxIterations ? parseInt(envMaxIterations, 10) : DEFAULT_AGENT_MAX_ITERATIONS;
  const envMaxConcurrentTasks = getEnv("MAX_CONCURRENT_TASKS") || getEnv("maxConcurrentTasks");

  const cliStyle = parseCliStyle(getFlagString(parsed, "", "style"));
  const cliBaseURL = getFlagString(parsed, "", "base-url", "baseURL", "url", "u");
  const cliApiKey = getFlagString(parsed, "", "api-key", "k");

  const envModelId = getFlagString(parsed, envModel, "model", "m");
  const cliModel = getFlagString(parsed, "", "model", "m");
  const envStyle = parseCliStyle(getEnv("MODEL_STYLE") || getEnv("STYLE") || undefined);
  const envBaseURL = getEnv("BASE_URL") || getEnv("MODEL_BASE_URL") || undefined;
  const envApiKey = getEnv("API_KEY") || undefined;

  // Any explicit model-related flag overrides the "defer to server" default for
  // remote sessions (`.env`-only values are treated as host defaults).
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
  const envRemote = getEnv("REMOTE_ENV");
  const remoteEnvFlag = getFlag(parsed, "remote-env", "R");
  const remoteEnv = typeof remoteEnvFlag === "string" ? remoteEnvFlag : envRemote || undefined;

  const envRemoteProvider = getEnv("REMOTE_PROVIDER");
  const remoteProviderFlag = getFlag(parsed, "remote-provider");
  const remoteProvider = typeof remoteProviderFlag === "string" ? remoteProviderFlag : envRemoteProvider || undefined;

  const envRemoteSession = getEnv("REMOTE_SESSION");
  const remoteSessionFlag = getFlag(parsed, "remote-session");
  const remoteSession = typeof remoteSessionFlag === "string" ? remoteSessionFlag : envRemoteSession || undefined;

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

  // NOTE: `codent acp` re-parses this same result but forwards only the settings its own host has
  // a seam for (model connection + `--system` / `--max-iterations` / `--client-env`). The session
  // library, MCP config, extension dirs and resume flags are ACP-client concerns; `host.tsx`
  // documents the split.
  return {
    model: connection.model,
    style: connection.style,
    baseURL: connection.baseURL,
    apiKey: connection.apiKey,
    // Runtime knobs are flag > env > default (no models.json copy — see `ModelsConfigGlobal`).
    systemPrompt: getFlagString(parsed, "", "system", "s"),
    sandbox: typeof sandboxFlag === "string" ? sandboxFlag : sandboxFlag === true ? "" : undefined,
    initialPrompt: parsed.positional.join(" "),
    maxIterations: getFlagNumber(
      parsed,
      isNaN(envMaxIter) ? DEFAULT_AGENT_MAX_ITERATIONS : envMaxIter,
      "max-iterations"
    ),
    ...(Number.isFinite(maxConcurrentTasks) ? { maxConcurrentTasks } : {}),
    mcpConfigPath: getFlagString(parsed, envMcpConfig, "mcp-config"),
    extensionDirs,
    continueSession: getFlagBoolean(parsed, "continue", "c"),
    resumeSession,
    remoteEnv,
    remoteProvider,
    remoteSession,
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
 * Version string of the installed `@codent/cli` package. `dist/index.mjs`
 * sits next to `package.json` both in the monorepo and in the published
 * tarball, so this resolves correctly before and after `npm install -g`.
 */
export function cliVersion(): string {
  return (requireFromCli("../package.json") as { version: string }).version;
}

export const isVersionRequested = (argv: string[]): boolean => {
  const parsed = parseArgs(argv);
  return getFlagBoolean(parsed, "version", "v");
};
