import { z } from "zod";

import { defineServerTool } from "./runtime/define-tool.js";
import { commandJobRegistry } from "./util/command-job-registry.js";
import { killCommandOutputSchema } from "./util/types.js";

import type { KillCommandOutput } from "./util/types.js";
import type { ManagedAgent } from "../../runtime-types/hosts.js";

export const createKillCommandTool = ({ managed }: { managed?: ManagedAgent } = {}) => {
  const registry = managed?.getCommandJobRegistry() ?? commandJobRegistry;
  return defineServerTool({
    name: "kill_command",
    present: {
      category: "commands",
      detailed: true,
    },
    description: "Stop a background shell job started with run_command(run_in_background=true).",
    inputSchema: z.object({
      jobId: z.string().describe("The jobId returned by a background run_command."),
    }),
    outputSchema: killCommandOutputSchema,
    needsApproval: true,
    lazy: true,
    execute: async ({ jobId }) => {
      const existing = registry.get(jobId);
      if (!existing) {
        throw new Error(`Unknown background jobId: ${jobId}`);
      }
      const killed = await registry.kill(jobId);
      const after = registry.get(jobId);
      return {
        jobId,
        status: after?.status ?? "killed",
        killed,
        cachedOutputPath: null,
      };
    },
    toModelOutput({ output }: { toolCallId: string; input: unknown; output: KillCommandOutput }) {
      return [
        {
          type: "text" as const,
          content: output.killed
            ? `Killed job ${output.jobId} (status: ${output.status}).`
            : `Job ${output.jobId} was not running (status: ${output.status}).`,
        },
      ];
    },
  });
};
