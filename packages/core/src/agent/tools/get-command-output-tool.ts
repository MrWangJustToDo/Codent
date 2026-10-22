import { z } from "zod";

import { defineServerTool, isProjectedModelContent } from "./runtime/define-tool.js";
import { getCommandOutputSchema } from "./util/types.js";

import type { AgentToolContext } from "./runtime/tool-context.js";
import type { GetCommandOutput } from "./util/types.js";

export const createGetCommandOutputTool = ({ context }: { context?: AgentToolContext } = {}) => {
  return defineServerTool({
    name: "get_command_output",
    present: {
      category: "commands",
      detailed: true,
    },
    description:
      "Read incremental stdout/stderr and status for a background job started with run_command(run_in_background=true). " +
      "Each call returns output since the previous poll for that jobId. " +
      "The job's full log is returned as cachedOutputPath — read it with read_file for output that already scrolled past.",
    inputSchema: z.object({
      jobId: z.string().describe("The jobId returned by a background run_command."),
    }),
    outputSchema: getCommandOutputSchema,
    needsApproval: false,
    lazy: true,
    execute: async ({ jobId }) => {
      const registry = context?.getCommandJobRegistry();
      if (!registry) throw new Error("get_command_output requires an AgentToolContext");
      await registry.ready();
      const result = registry.poll(jobId);
      if (!result) {
        throw new Error(`Unknown background jobId: ${jobId}`);
      }
      return {
        ...result,
        cachedOutputPath: result.logPath,
      };
    },
    toModelOutput({ output }: { toolCallId: string; input: unknown; output: GetCommandOutput }) {
      if (isProjectedModelContent(output)) return output;
      const parts = [
        `jobId: ${output.jobId}`,
        `status: ${output.status}`,
        `running: ${output.running}`,
        `exitCode: ${output.exitCode ?? "n/a"}`,
      ];
      if (output.stderr?.trim()) parts.push(`stderr:\n${output.stderr}`);
      if (output.stdout?.trim()) parts.push(`stdout:\n${output.stdout}`);
      else if (!output.stderr?.trim()) parts.push("(no new output)");
      if (output.cachedOutputPath) {
        parts.push(
          `log: ${output.cachedOutputPath} (full log — read_file; a missing "[exit ...]" footer means still running)`
        );
      }
      return [{ type: "text" as const, content: parts.join("\n") }];
    },
  });
};
