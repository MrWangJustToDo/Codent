/**
 * `codent acp` — serve the agent over the Agent Client Protocol on stdio.
 *
 * Intercepted before the TUI boots (ACP is a headless protocol: stdout must
 * carry only JSON-RPC frames). Bootstraps a local host + model provider exactly
 * like the CLI's local mode, then hands stdio to the ACP agent.
 */

import type { AcpModelOverride } from "@codent/acp";

export async function runAcpCommand(
  model?: AcpModelOverride,
  options: {
    clientEnv?: boolean;
    version?: string;
    sandbox?: "local" | "native";
    systemPrompt?: string;
    maxIterations?: number;
    maxConcurrentTasks?: number;
    extensionDirs?: string[];
    mcpConfigPath?: string;
  } = {}
): Promise<never> {
  const { bootstrapAcpAgent, runAcpAgentStdio } = await import("@codent/acp");
  // Everything `AcpAgentDefaults` can carry is forwarded. The remaining `codent` flags
  // (`--resume` / `--continue`) are protocol-driven in ACP: the client chooses the session.
  const bootOptions = {
    ...(model ? { model } : {}),
    ...(options.clientEnv ? { clientEnv: true } : {}),
    ...(options.version ? { version: options.version } : {}),
    ...(options.sandbox ? { sandbox: options.sandbox } : {}),
    ...(options.systemPrompt ? { systemPrompt: options.systemPrompt } : {}),
    ...(options.maxIterations !== undefined ? { maxIterations: options.maxIterations } : {}),
    ...(options.maxConcurrentTasks !== undefined ? { maxConcurrentTasks: options.maxConcurrentTasks } : {}),
    ...(options.extensionDirs?.length ? { extensionDirs: options.extensionDirs } : {}),
    ...(options.mcpConfigPath ? { mcpConfigPath: options.mcpConfigPath } : {}),
  };
  const acpOptions = await bootstrapAcpAgent(bootOptions);
  const connection = runAcpAgentStdio(acpOptions);

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
  process.exit(0);
}

/** True when argv selects the ACP subcommand. */
export function isAcpRequested(argv: string[]): boolean {
  const first = argv[0];
  return first === "acp" || first === "--acp";
}
