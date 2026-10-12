#!/usr/bin/env node
/**
 * Standalone `codent-acp` entry — bootstraps a local host and serves ACP over
 * stdio. ACP clients spawn this as a child process.
 */

import { parseModelStyle } from "@codent/core";

import { runAcpAgentStdio } from "./agent.js";
import { bootstrapAcpAgent, type AcpModelOverride } from "./bootstrap.js";

/** Minimal model-flag reader for the standalone bin (`--model/-m`, `--style`, `--base-url/-u`, `--api-key/-k`). */
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
  const model = get("model", "m");
  if (!model) return undefined;
  return {
    model,
    style: parseModelStyle(get("style")),
    baseURL: get("base-url", "url", "u"),
    apiKey: get("api-key", "k"),
  };
}

async function main(): Promise<void> {
  const options = await bootstrapAcpAgent({ model: parseModelFlags(process.argv.slice(2)) });
  const connection = runAcpAgentStdio(options);

  const shutdown = (): void => {
    try {
      connection.close();
    } catch {
      // ignore
    }
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  process.stdin.on("end", shutdown);
  process.stdin.on("close", shutdown);

  await connection.closed.catch(() => undefined);
}

main().catch((error: unknown) => {
  process.stderr.write(`codent-acp: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
