/**
 * `codent acp` — serve the agent over the Agent Client Protocol on stdio.
 *
 * Intercepted before the TUI boots (ACP is a headless protocol: stdout must
 * carry only JSON-RPC frames). Bootstraps a local host + model provider exactly
 * like the CLI's local mode, then hands stdio to the ACP agent.
 */

import type { AcpModelOverride } from "@codent/acp";

export async function runAcpCommand(model?: AcpModelOverride, options: { clientEnv?: boolean } = {}): Promise<never> {
  const { bootstrapAcpAgent, runAcpAgentStdio } = await import("@codent/acp");
  const bootOptions = {
    ...(model ? { model } : {}),
    ...(options.clientEnv ? { clientEnv: true } : {}),
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
