#!/usr/bin/env node
/**
 * Standalone `codent-acp` entry — bootstraps a local host and serves ACP over
 * stdio. ACP clients spawn this as a child process.
 */

import { installAgentLogProcessGuards, parseModelStyle } from "@codent/core";
import { createRequire } from "node:module";
import { parseArgs, type ParseArgsConfig } from "node:util";

import { bootstrapAcpAgent, type AcpModelOverride } from "./bootstrap.js";
import { runAcpAgentStdio } from "./stdio.js";

const requireFromBin = createRequire(import.meta.url);

/** The standalone bin's own package version, reported as `agentInfo.version`. */
function acpVersion(): string {
  try {
    return (requireFromBin("../package.json") as { version: string }).version;
  } catch {
    return "0.0.1";
  }
}

/**
 * Flags the standalone bin understands (`--model/-m`, `--style`, `--base-url/-u`, `--api-key/-k`,
 * `--remote-provider`, `--system/-s`, `--max-iterations`, `--max-concurrent-tasks`,
 * `--extension-dirs`, `--mcp-config`, `--sandbox`, `--client-env`).
 *
 * Parsed by Node's STRICT `util.parseArgs`: an unknown flag (or a missing value) is an error
 * instead of a setting that is silently ignored. Positionals stay accepted and unused — an ACP
 * client may append one and the bin never had a meaning for it.
 */
const ACP_OPTIONS = {
  model: { type: "string", short: "m" },
  style: { type: "string" },
  "base-url": { type: "string", short: "u" },
  url: { type: "string" },
  "api-key": { type: "string", short: "k" },
  "remote-provider": { type: "string" },
  system: { type: "string", short: "s" },
  "max-iterations": { type: "string" },
  "max-concurrent-tasks": { type: "string" },
  "extension-dirs": { type: "string" },
  /** Legacy singular spelling kept as an alias. */
  "extension-dir": { type: "string" },
  "mcp-config": { type: "string" },
  sandbox: { type: "string" },
  "client-env": { type: "boolean" },
} as const satisfies NonNullable<ParseArgsConfig["options"]>;

function parseFlags(argv: string[]): {
  model?: AcpModelOverride;
  systemPrompt?: string;
  maxIterations?: number;
  maxConcurrentTasks?: number;
  extensionDirs?: string[];
  mcpConfigPath?: string;
  sandbox?: string;
  clientEnv: boolean;
} {
  const { values } = parseArgs({ args: argv, options: ACP_OPTIONS, allowPositionals: true, strict: true });
  // `!== undefined` rather than truthiness: `--sandbox=` must stay "" so it is rejected, not
  // treated as "flag absent".
  const get = (key: keyof typeof ACP_OPTIONS): string | undefined => {
    const value = values[key];
    return typeof value === "string" ? value : undefined;
  };
  const remoteProvider = get("remote-provider") || process.env.REMOTE_PROVIDER;
  const model = get("model");
  const systemPrompt = get("system");
  const rawIterations = get("max-iterations");
  const maxIterations = rawIterations !== undefined ? Number(rawIterations) : undefined;
  const rawConcurrentTasks = get("max-concurrent-tasks");
  const maxConcurrentTasks = rawConcurrentTasks !== undefined ? Number(rawConcurrentTasks) : undefined;
  const extensionDirs = (get("extension-dirs") ?? get("extension-dir"))
    ?.split(",")
    .map((dir) => dir.trim())
    .filter((dir) => dir.length > 0);
  const mcpConfigPath = get("mcp-config");
  const sandbox = get("sandbox");
  return {
    ...(model || remoteProvider
      ? {
          model: {
            ...(model ? { model } : {}),
            style: parseModelStyle(get("style")),
            baseURL: get("base-url") ?? get("url"),
            apiKey: get("api-key"),
            ...(remoteProvider ? { remoteProvider } : {}),
          },
        }
      : {}),
    ...(systemPrompt ? { systemPrompt } : {}),
    ...(maxIterations !== undefined && Number.isFinite(maxIterations) ? { maxIterations } : {}),
    ...(maxConcurrentTasks !== undefined && Number.isFinite(maxConcurrentTasks) ? { maxConcurrentTasks } : {}),
    ...(extensionDirs?.length ? { extensionDirs } : {}),
    ...(mcpConfigPath ? { mcpConfigPath } : {}),
    ...(sandbox !== undefined ? { sandbox } : {}),
    clientEnv: values["client-env"] === true,
  };
}

async function main(): Promise<void> {
  // This is a long-lived child process an editor spawns: a crash or a hard exit must still land the
  // buffered agent-log rows (and any extension `registerExitFlush` state) on disk. The CLI host does
  // this in its own bootstrap; the standalone `codent-acp` entry had no equivalent, so exit flushes
  // registered by extensions were written into a registry nothing ever drained.
  installAgentLogProcessGuards();

  const argv = process.argv.slice(2);
  const flags = parseFlags(argv);
  // A valueless `--sandbox` is a parser error (`argument missing`); `--sandbox=` reaches here as ""
  // and is rejected rather than silently meaning "default".
  if (flags.sandbox !== undefined && flags.sandbox !== "local" && flags.sandbox !== "native") {
    const detail = flags.sandbox === "" ? "requires a value" : `got "${flags.sandbox}"`;
    throw new Error(`--sandbox must be "local" (OS sandbox) or "native" (no OS sandbox); ${detail}`);
  }
  const options = await bootstrapAcpAgent({
    ...(flags.model ? { model: flags.model } : {}),
    // Opt-in: without it the env planes are byte-for-byte what they were before this flag existed.
    clientEnv: flags.clientEnv,
    version: acpVersion(),
    ...(flags.sandbox ? { sandbox: flags.sandbox } : {}),
    ...(flags.systemPrompt ? { systemPrompt: flags.systemPrompt } : {}),
    ...(flags.maxIterations !== undefined ? { maxIterations: flags.maxIterations } : {}),
    ...(flags.maxConcurrentTasks !== undefined ? { maxConcurrentTasks: flags.maxConcurrentTasks } : {}),
    ...(flags.extensionDirs ? { extensionDirs: flags.extensionDirs } : {}),
    ...(flags.mcpConfigPath ? { mcpConfigPath: flags.mcpConfigPath } : {}),
  });
  const connection = runAcpAgentStdio(options);

  const shutdown = (): void => {
    try {
      connection.close();
    } catch {
      // ignore
    }
    // Let the JSON-RPC transport flush its last frame before exiting. `process.exit()` truncates
    // stdout, which a client can see as a dropped final response.
    let exited = false;
    const exit = (): void => {
      if (exited) return;
      exited = true;
      process.exit(0);
    };
    try {
      process.stdout.write("", exit);
      // The callback is not guaranteed when stdout is already destroyed; do not hang on it.
      setTimeout(exit, 50).unref?.();
    } catch {
      exit();
    }
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  process.stdin.on("end", shutdown);
  process.stdin.on("close", shutdown);
  process.stdout.on("error", (error: NodeJS.ErrnoException) => {
    // The client closed its end. Nothing can be delivered; exit quietly rather than crash.
    if (error.code === "EPIPE") shutdown();
  });

  await connection.closed.catch(() => undefined);
}

main().catch((error: unknown) => {
  process.stderr.write(`codent-acp: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
