/** Tool-facing command port; the owning manager implements it. */
import type { ResolvedCoreEnv } from "../../../env";
import type { CommandJobPollResult, CommandJobStatus } from "../builtin/shell/jobs/registry.js";

export interface StartBackgroundInput {
  command: string;
  toolCallId: string;
  cwd?: string;
  env?: Record<string, string>;
  coreEnv: ResolvedCoreEnv;
}

export interface StartBackgroundResult {
  jobId: string;
  cachedOutputPath?: string;
}

export interface KillCommandResult {
  killed: boolean;
  status: CommandJobStatus;
  logPath?: string;
}

export interface AgentCommandPort {
  startBackground(input: StartBackgroundInput): Promise<StartBackgroundResult>;
  poll(jobId: string): Promise<CommandJobPollResult>;
  kill(jobId: string): Promise<KillCommandResult>;
}
