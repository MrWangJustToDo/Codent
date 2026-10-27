import { z } from "zod";

import { defineServerTool, isProjectedModelContent } from "../../runtime/define-tool.js";
import { getCommandOutputSchema } from "../../shared/schemas.js";

import type { AgentToolContext } from "../../runtime/tool-context.js";
import type { GetCommandOutput } from "../../shared/schemas.js";

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
      // Polling is for intermediate output, not for waiting: the completion is pushed by
      // `background-middleware` and an idle session is woken for it. Saying only "each call
      // returns the delta" invited a model to sit here re-polling a job it would be told about.
      "Use it on demand; you do not need to poll to wait for the job to finish — its completion is pushed back to you. " +
      "The job's full log is returned as cachedOutputPath — read it with read_file for output that already scrolled past.",
    inputSchema: z.object({
      jobId: z.string().describe("The jobId returned by a background run_command."),
    }),
    outputSchema: getCommandOutputSchema,
    needsApproval: false,
    lazy: true,
    execute: async ({ jobId }) => {
      const commands = context?.getCommandService();
      if (!commands) throw new Error("get_command_output requires an AgentToolContext");
      const result = await commands.poll(jobId);
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
