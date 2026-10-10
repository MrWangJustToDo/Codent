/**
 * `session_search` — search this workspace's past conversations.
 *
 * The model's only other route to earlier sessions was to grep the raw files itself; the session
 * logs are one JSON object per line, so a grep hit identifies a session but is not readable. This
 * tool returns bounded, parsed matches from the session log — the complete conversation (compaction
 * only appends a summary, it never drops the messages) — and excludes the current session by
 * default because its content is already the live conversation. See `session-reader.ts`.
 */

import { z } from "zod";

import { defineServerTool } from "./runtime/define-tool.js";
import { DEFAULT_SEARCH_ROLES, searchHistory } from "./session-search/session-reader.js";
import { withDuration } from "./util/tool-result.js";
import { toolOutputBaseSchema } from "./util/types.js";

import type { ManagedAgent } from "../../runtime-types/hosts.js";

/** Default number of matches returned. */
const DEFAULT_LIMIT = 20;
/** Maximum matches a caller may request. */
const MAX_LIMIT = 50;

const sessionMatchSchema = z.object({
  sessionId: z.string().describe("Session the match came from."),
  role: z.string().optional().describe("Message role."),
  timestamp: z.number().optional().describe("Message time in epoch ms when known."),
  surface: z
    .enum(["current", "shadowed"])
    .describe(
      "Position relative to the session's latest compaction summary: `current` = still in that session's context; `shadowed` = compacted out of context (log only)."
    ),
  messageIndex: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe("0-based message index — pass to `session_read` to read the context."),
  snippet: z.string().describe("Text around the match."),
});

export const sessionSearchOutputSchema = z.object({
  query: z.string().describe("The query that was searched."),
  matches: z.array(sessionMatchSchema).describe("Matches, newest session first."),
  total: z.number().describe("Total matches found in the scanned scope."),
  returned: z.number().describe("Matches returned in this result."),
  withheld: z.number().describe("Matches not returned because of `limit`."),
  truncated: z
    .boolean()
    .describe("True when the scan itself was bounded (session cap or an oversized log), so `total` is a floor."),
  durationMs: z.number().describe("Execution duration in milliseconds."),
  ...toolOutputBaseSchema.shape,
});

export type SessionSearchOutput = z.infer<typeof sessionSearchOutputSchema>;

/**
 * Create the `session_search` tool.
 *
 * `managed` supplies the current session id so it can be excluded by default (the live
 * conversation already holds it). Pass no `sessionId` to search all other sessions.
 */
export const createSessionSearchTool = ({ managed }: { managed?: ManagedAgent } = {}) => {
  return defineServerTool({
    name: "session_search",
    present: { category: "searches" },
    description: `Search past conversations in this workspace (earlier sessions from the same project).

Use when the task depends on something discussed before — a decision, a constraint, or a detail no longer in context. Returns parsed matches from the session logs — the complete conversation, including parts the current context has compacted away. Results are newest-session-first, not ranked by relevance.

The current session is excluded unless you pass its \`sessionId\` explicitly. Follow a hit with \`session_read\` to read the surrounding conversation.`,
    inputSchema: z.object({
      query: z
        .string()
        .min(2, { message: "query: must be at least 2 characters" })
        .describe("Literal text to find (case-insensitive). Not a regular expression."),
      sessionId: z
        .string()
        .optional()
        .describe("Restrict the search to one session (also re-includes the current session)."),
      role: z
        .enum(["user", "assistant"])
        .optional()
        .describe(`Only match messages of this role. Defaults to both (${DEFAULT_SEARCH_ROLES.join(", ")}).`),
      since: z
        .number()
        .int({ message: "since: must be an integer (epoch ms)" })
        .optional()
        .describe("Only match messages at or after this time (epoch ms)."),
      until: z
        .number()
        .int({ message: "until: must be an integer (epoch ms)" })
        .optional()
        .describe("Only match messages at or before this time (epoch ms)."),
      limit: z
        .number()
        .int({ message: "limit: must be an integer" })
        .min(1, { message: "limit: must be >= 1" })
        .max(MAX_LIMIT, { message: `limit: must be <= ${MAX_LIMIT}` })
        .optional()
        .describe(`Maximum matches to return. Defaults to ${DEFAULT_LIMIT}.`),
    }),
    outputSchema: sessionSearchOutputSchema,
    execute: async ({ query, sessionId, role, since, until, limit }) => {
      return withDuration(async () => {
        const currentSessionId = managed?.getSessionData()?.id;
        const result = await searchHistory({
          query,
          sessionId,
          role,
          since,
          until,
          limit: limit ?? DEFAULT_LIMIT,
          // Only the implicit "search everything" case excludes the live session; naming one is explicit intent.
          excludeSessionId: sessionId ? undefined : currentSessionId,
        });

        return {
          query,
          matches: result.matches,
          total: result.total,
          returned: result.matches.length,
          withheld: Math.max(0, result.total - result.matches.length),
          truncated: result.truncated,
        };
      });
    },
    toModelOutput({ output }: { toolCallId: string; input: unknown; output: SessionSearchOutput }) {
      if (output.matches.length === 0) {
        const note = output.truncated ? " (scan was bounded, so this is not guaranteed complete)" : "";
        return [{ type: "text" as const, content: `session search "${output.query}": no matches${note}.` }];
      }

      const lines = output.matches.map((match) => {
        const where = `${match.sessionId}${match.role ? ` · ${match.role}` : ""}${
          match.messageIndex !== undefined ? ` #${match.messageIndex}` : ""
        }`;
        return `- ${where} [${match.surface}]: ${match.snippet}`;
      });
      const withheldNote =
        output.withheld > 0 ? `\n(${output.withheld} more withheld — raise limit or narrow the query)` : "";
      const truncatedNote = output.truncated ? "\n(scan bounded; results may be incomplete)" : "";

      return [
        {
          type: "text" as const,
          content: `session search "${output.query}": ${output.returned} of ${output.total} matches\n${lines.join(
            "\n"
          )}${withheldNote}${truncatedNote}`,
        },
      ];
    },
  });
};
