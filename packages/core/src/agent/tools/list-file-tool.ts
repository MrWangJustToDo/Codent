import { z } from "zod";

import { defineServerTool } from "./runtime/define-tool.js";
import { OUTPUT_LIMITS } from "./util/output-limits.js";
import { withDuration } from "./util/tool-result.js";
import { listFileOutputSchema } from "./util/types.js";

import type { ListFileOutput } from "./util/types.js";

const DEFAULT_LIMIT = OUTPUT_LIMITS.MAX_ARRAY_ITEMS;

export const createListFileTool = () => {
  return defineServerTool({
    name: "list_file",
    present: { category: "reads" },
    description:
      "Lists one directory level with name, type, size, and modification date. Prefer tree for hierarchical overview; glob for pattern matching across the tree. Supports pagination with offset/limit.",
    inputSchema: z.object({
      path: z.string().optional().describe("Directory to list, relative to project root (default: current)."),
      offset: z
        .number()
        .int({ message: "offset: must be an integer" })
        .min(0, { message: "offset: must be >= 0 (0-indexed)" })
        .optional()
        .describe("Number of entries to skip (0-indexed). Use for pagination. Defaults to 0."),
      limit: z
        .number()
        .int({ message: "limit: must be an integer" })
        .min(1, { message: "limit: must be >= 1" })
        .max(DEFAULT_LIMIT, { message: "limit: exceeds maximum" })
        .optional()
        .describe(`Maximum number of entries to return. Defaults to ${DEFAULT_LIMIT}.`),
    }),
    outputSchema: listFileOutputSchema,
    execute: async ({ path: inputPath, offset, limit }, { coreEnv }) => {
      return withDuration(async () => {
        const path = inputPath ?? ".";
        const skip = offset ?? 0;
        const take = limit ?? DEFAULT_LIMIT;

        const fs = coreEnv.fs;
        const exists = await fs.exists(path);

        if (!exists) {
          throw new Error(`Directory does not exist: ${path}`);
        }

        const allEntries = await fs.readdir(path);
        const paginatedEntries = allEntries.slice(skip, skip + take);
        const totalEntries = allEntries.length;

        return {
          entries: paginatedEntries.map((entry) => ({
            name: entry.name,
            type: entry.type,
            size: entry.size,
            modified: entry.modified?.toISOString(),
          })),
          offset: skip,
          limit: take,
          count: paginatedEntries.length,
          totalEntries,
        };
      });
    },
    // Only send entries to the LLM — path is echoed in the input,
    // pagination metadata is for the UI only.
    toModelOutput({ output }: { toolCallId: string; input: unknown; output: ListFileOutput }) {
      const lines = output.entries?.map?.((e) => `${e.name}${e.type === "directory" ? "/" : ""}`);
      return [
        {
          type: "text" as const,
          content:
            `offset(current pagination): ${output.offset}; limit(Maximum number of items to return): ${output.limit}` +
            lines?.join("\n"),
        },
      ];
    },
  });
};
