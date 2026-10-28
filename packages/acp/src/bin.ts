#!/usr/bin/env node
/**
 * Standalone `codent-acp` entry — bootstraps a local host and serves ACP over
 * stdio. ACP clients spawn this as a child process.
 */

import { installAgentLogProcessGuards, parseModelStyle } from "@codent/core";
import { createRequire } from "node:module";

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
 * Minimal flag reader for the standalone bin (`--model/-m`, `--style`, `--base-url/-u`,
 * `--api-key/-k`, `--remote-provider`, `--system/-s`, `--max-iterations`,
 * `--max-concurrent-tasks`, `--extension-dirs`, `--mcp-config`, `--sandbox`).
 */
function parseFlags(argv: string[]): {
  model?: AcpModelOverride;
  systemPrompt?: string;
  maxIterations?: number;
  maxConcurrentTasks?: number;
  extensionDirs?: string[];
  mcpConfigPath?: string;
  sandbox?: string;
} {
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg || !arg.startsWith("-")) continue;
    const body = arg.replace(/^--?/, "");
    // `--flag=value` is one token: the value never competes with the next argument, and an empty
    // value stays "" so the validator can reject it instead of it silently meaning "not set".
    const equals = body.indexOf("=");
    if (equals >= 0) {
      flags.set(body.slice(0, equals), body.slice(equals + 1));
      continue;
    }
    const next = argv[i + 1];
    if (next && !next.startsWith("-")) {
      flags.set(body, next);
      i++;
    }
  }
  const get = (...keys: string[]): string | undefined => {
    for (const key of keys) {
      const value = flags.get(key);
      if (value) return value;
    }
    return undefined;
  };
  const remoteProvider = get("remote-provider") || process.env.REMOTE_PROVIDER;
  const model = get("model", "m");
  const systemPrompt = get("system", "s");
  const rawIterations = get("max-iterations");
  const maxIterations = rawIterations !== undefined ? Number(rawIterations) : undefined;
  const rawConcurrentTasks = get("max-concurrent-tasks");
  const maxConcurrentTasks = rawConcurrentTasks !== undefined ? Number(rawConcurrentTasks) : undefined;
  const extensionDirs = get("extension-dirs", "extension-dir")
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
            baseURL: get("base-url", "url", "u"),
            apiKey: get("api-key", "k"),
            ...(remoteProvider ? { remoteProvider } : {}),
          },
        }
      : {}),
    ...(systemPrompt ? { systemPrompt } : {}),
    ...(maxIterations !== undefined && Number.isFinite(maxIterations) ? { maxIterations } : {}),
    ...(maxConcurrentTasks !== undefined && Number.isFinite(maxConcurrentTasks) ? { maxConcurrentTasks } : {}),
    ...(extensionDirs?.length ? { extensionDirs } : {}),
    ...(mcpConfigPath ? { mcpConfigPath } : {}),
    ...(sandbox ? { sandbox } : {}),
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
  // A valueless `--sandbox` (last arg) and `--sandbox=` both mean "no value" — never "default".
  if (flags.sandbox === undefined && argv.some((arg) => arg === "--sandbox" || arg === "--sandbox=")) {
    throw new Error(`--sandbox requires "local" (OS sandbox) or "native" (no OS sandbox)`);
  }
  if (flags.sandbox !== undefined && flags.sandbox !== "local" && flags.sandbox !== "native") {
    throw new Error(`--sandbox must be "local" (OS sandbox) or "native" (no OS sandbox); got "${flags.sandbox}"`);
  }
  const options = await bootstrapAcpAgent({
    ...(flags.model ? { model: flags.model } : {}),
    // Opt-in: without it the env planes are byte-for-byte what they were before this flag existed.
    clientEnv: argv.includes("--client-env"),
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
