#!/usr/bin/env node
/**
 * Standalone `codent-acp` entry — bootstraps a local host and serves ACP over
 * stdio. ACP clients spawn this as a child process.
 */

import { installAgentLogProcessGuards, parseModelStyle } from "@codent/core";

import { bootstrapAcpAgent, type AcpModelOverride } from "./bootstrap.js";
import { runAcpAgentStdio } from "./stdio.js";

/** Minimal flag reader for the standalone bin (`--model/-m`, `--style`, `--base-url/-u`, `--api-key/-k`, `--remote-provider`). */
function parseModelFlags(argv: string[]): AcpModelOverride | undefined {
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg || !arg.startsWith("-")) continue;
    const key = arg.replace(/^--?/, "");
    const next = argv[i + 1];
    if (next && !next.startsWith("-")) {
      flags.set(key, next);
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
  if (!model && !remoteProvider) return undefined;
  return {
    ...(model ? { model } : {}),
    style: parseModelStyle(get("style")),
    baseURL: get("base-url", "url", "u"),
    apiKey: get("api-key", "k"),
    ...(remoteProvider ? { remoteProvider } : {}),
  };
}

async function main(): Promise<void> {
  // This is a long-lived child process an editor spawns: a crash or a hard exit must still land the
  // buffered agent-log rows (and any extension `registerExitFlush` state) on disk. The CLI host does
  // this in its own bootstrap; the standalone `codent-acp` entry had no equivalent, so exit flushes
  // registered by extensions were written into a registry nothing ever drained.
  installAgentLogProcessGuards();

  const argv = process.argv.slice(2);
  const options = await bootstrapAcpAgent({
    model: parseModelFlags(argv),
    // Opt-in: without it the env planes are byte-for-byte what they were before this flag existed.
    clientEnv: argv.includes("--client-env"),
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
