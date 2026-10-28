import {
  DEFAULT_AGENT_MAX_ITERATIONS,
  parseModelStyle,
  resolveModelConnection,
  websearchToolConfigFromEnv,
} from "@codent/core";
import { createRequire } from "node:module";
import { parseArgs, type ParseArgsConfig } from "node:util";

import { parseModelInfoFromEnv } from "./model-env.js";

import type { AppConfig } from "@codent/app";
import type { ModelStyle } from "@codent/core";

// ============================================================================
// Argument Parsing
// ============================================================================

/**
 * Every flag this shell understands.
 *
 * Parsing is Node's `util.parseArgs` in STRICT mode, so an undeclared flag is an error instead of
 * being accepted into a map nothing reads (`--max-iteration` used to be silently ignored). It also
 * gives us `--flag=value`, the `--` terminator (so a positional prompt may start with `-`), short
 * aliases, and `-1`-shaped values rejected loudly rather than swallowed as the next flag.
 *
 * Adding a flag here is the only step needed for it to parse; the env fallbacks live below.
 */
const CLI_OPTIONS = {
  acp: { type: "boolean" },
  help: { type: "boolean", short: "h" },
  version: { type: "boolean", short: "v" },
  model: { type: "string", short: "m" },
  style: { type: "string" },
  "base-url": { type: "string", short: "u" },
  /** Legacy camelCase spelling kept as an alias. */
  baseURL: { type: "string" },
  url: { type: "string" },
  "api-key": { type: "string", short: "k" },
  system: { type: "string", short: "s" },
  "max-iterations": { type: "string" },
  "max-concurrent-tasks": { type: "string" },
  "extension-dirs": { type: "string" },
  /** Legacy singular spelling kept as an alias. */
  "extension-dir": { type: "string" },
  "mcp-config": { type: "string" },
  sandbox: { type: "string" },
  continue: { type: "boolean", short: "c" },
  resume: { type: "string", short: "r" },
  "remote-env": { type: "string", short: "R" },
  "remote-provider": { type: "string" },
  "remote-session": { type: "string" },
  "client-env": { type: "boolean" },
} as const satisfies NonNullable<ParseArgsConfig["options"]>;

/** Parsed values by flag name; every declared flag is `string` or `boolean`. */
type CliValues = Readonly<Record<string, string | boolean | undefined>>;

/** `AppConfig.resumeSession` sentinel: `-r` with no id opens the picker. */
const RESUME_PICKER = "__picker__";

/**
 * `--resume` / `-r` may omit its id to open the session picker, and `parseArgs` has no
 * "optional value" option type. Rewrite the bare form to the sentinel the host already
 * understands, so `-r` alone keeps working and `-r <id>` is untouched.
 */
function normalizeResume(argv: string[]): string[] {
  return argv.map((arg, index) => {
    if (arg !== "-r" && arg !== "--resume") return arg;
    const next = argv[index + 1];
    return next === undefined || next.startsWith("-") ? `--resume=${RESUME_PICKER}` : arg;
  });
}

/**
 * Parse the command line, or throw a one-line message a host can print.
 *
 * Node's own messages are precise (`Unknown option '--max-iteration'`,
 * `Option '--sandbox <value>' argument missing`) but append a multi-line hint; only the first
 * line is user-facing.
 */
function parseCli(argv: string[]): { values: CliValues; positionals: string[] } {
  try {
    const parsed = parseArgs({
      args: normalizeResume(argv),
      options: CLI_OPTIONS,
      allowPositionals: true,
      strict: true,
    });
    return { values: parsed.values, positionals: parsed.positionals };
  } catch (error) {
    const message = error instanceof Error ? error.message.split("\n")[0] : String(error);
    throw new Error(message);
  }
}

function getFlag(values: CliValues, ...keys: string[]): string | boolean | undefined {
  for (const key of keys) {
    if (values[key] !== undefined) return values[key];
  }
  return undefined;
}

function getFlagString(values: CliValues, defaultValue: string, ...keys: string[]): string {
  const value = getFlag(values, ...keys);
  return typeof value === "string" ? value : defaultValue;
}

function getFlagNumber(values: CliValues, defaultValue: number, ...keys: string[]): number {
  const value = getFlag(values, ...keys);
  if (typeof value === "string") {
    const num = parseInt(value, 10);
    return isNaN(num) ? defaultValue : num;
  }
  return defaultValue;
}

function getFlagBoolean(values: CliValues, ...keys: string[]): boolean {
  return getFlag(values, ...keys) === true;
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
  /** `--client-env`: the ACP host borrows the client's filesystem / terminal per session. */
  clientEnv: boolean;
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
  const { values, positionals } = parseCli(argv);
  // `--sandbox=` yields "", which the host's resolver rejects ("requires a value") instead of
  // silently falling back to the env/default.
  const sandboxFlag = getFlag(values, "sandbox");

  const envModel = getEnv("MODEL") || getEnv("model");
  const envMaxIterations = getEnv("MAX_ITERATIONS") || getEnv("maxIterations");
  const envMaxIter = envMaxIterations ? parseInt(envMaxIterations, 10) : DEFAULT_AGENT_MAX_ITERATIONS;
  const envMaxConcurrentTasks = getEnv("MAX_CONCURRENT_TASKS") || getEnv("maxConcurrentTasks");

  const cliStyle = parseCliStyle(getFlagString(values, "", "style"));
  const cliBaseURL = getFlagString(values, "", "base-url", "baseURL", "url");
  const cliApiKey = getFlagString(values, "", "api-key");

  const envModelId = getFlagString(values, envModel, "model");
  const cliModel = getFlagString(values, "", "model");
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

  // ONE env→toolConfig mapping, shared with the ACP bootstrap (`websearchToolConfigFromEnv`): a
  // host-specific copy is how a key that worked here stayed dead over ACP.
  const toolConfig = websearchToolConfigFromEnv(process.env);

  // The picker sentinel is injected by `normalizeResume` (a bare `-r` / `--resume`), so this is
  // always a plain value.
  const resumeSession = getFlagString(values, "", "resume");

  const envMcpConfig = getEnv("MCP_CONFIG_PATH");
  const envRemote = getEnv("REMOTE_ENV");
  const remoteEnvFlag = getFlag(values, "remote-env");
  const remoteEnv = typeof remoteEnvFlag === "string" ? remoteEnvFlag : envRemote || undefined;

  const envRemoteProvider = getEnv("REMOTE_PROVIDER");
  const remoteProviderFlag = getFlag(values, "remote-provider");
  const remoteProvider = typeof remoteProviderFlag === "string" ? remoteProviderFlag : envRemoteProvider || undefined;

  const envRemoteSession = getEnv("REMOTE_SESSION");
  const remoteSessionFlag = getFlag(values, "remote-session");
  const remoteSession = typeof remoteSessionFlag === "string" ? remoteSessionFlag : envRemoteSession || undefined;

  // Extra dirs from CLI only; `AGENT_EXTENSION_DIRS` is read in core `getDefaultExtensionDirs`.
  const extensionDirsRaw = getFlagString(values, "", "extension-dirs", "extension-dir");
  const extensionDirs = extensionDirsRaw
    .split(",")
    .map((d) => d.trim())
    .filter((d) => d.length > 0);

  const maxConcurrentTasks = getFlagNumber(
    values,
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
    systemPrompt: getFlagString(values, "", "system"),
    sandbox: typeof sandboxFlag === "string" ? sandboxFlag : undefined,
    initialPrompt: positionals.join(" "),
    maxIterations: getFlagNumber(
      values,
      isNaN(envMaxIter) ? DEFAULT_AGENT_MAX_ITERATIONS : envMaxIter,
      "max-iterations"
    ),
    ...(Number.isFinite(maxConcurrentTasks) ? { maxConcurrentTasks } : {}),
    mcpConfigPath: getFlagString(values, envMcpConfig, "mcp-config"),
    extensionDirs,
    continueSession: getFlagBoolean(values, "continue"),
    clientEnv: getFlagBoolean(values, "client-env"),
    resumeSession,
    remoteEnv,
    remoteProvider,
    remoteSession,
    modelExplicit,
    ...(modelInfo ? { modelInfo } : {}),
    ...(toolConfig ? { toolConfig } : {}),
  };
}

/**
 * `--help` must win even when the rest of the command line is invalid (a typo'd flag, a missing
 * value), so this is a raw scan rather than a parse. Same for `--version`.
 */
export const isHelpRequested = (argv: string[]): boolean => argv.includes("--help") || argv.includes("-h");

const requireFromCli = createRequire(import.meta.url);

/**
 * Version string of the installed `@codent/cli` package. `dist/index.mjs`
 * sits next to `package.json` both in the monorepo and in the published
 * tarball, so this resolves correctly before and after `npm install -g`.
 */
export function cliVersion(): string {
  return (requireFromCli("../package.json") as { version: string }).version;
}

export const isVersionRequested = (argv: string[]): boolean => argv.includes("--version") || argv.includes("-v");
