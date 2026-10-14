/**
 * `session_read` — render one past session's messages as text.
 *
 * The append-only session log is one JSON object per line, so it has no readable form without a
 * parser; `grep` can locate a session but cannot show the conversation. This tool folds a session
 * and renders it windowed, so the model can walk a long conversation a page at a time. Pair it
 * with `session_search` (which returns the `sessionId` and message index to read from).
 */

import { z } from "zod";

import { FileError } from "../../env/types";
import { formatByteSize } from "../../utils/byte-size.js";

import { defineServerTool, isProjectedModelContent } from "./runtime/define-tool.js";
import {
  MAX_SESSION_FILE_BYTES,
  readSessionMessages,
  sessionExists,
  sessionLogSize,
} from "./session-search/session-reader.js";
import { OUTPUT_LIMITS } from "./util/output-limits.js";
import { maybeCacheOutput } from "./util/tool-output-cache.js";
import { withDuration } from "./util/tool-result.js";
import { toolOutputBaseSchema } from "./util/types.js";

import type { SessionMessage } from "./session-search/session-reader.js";
import type { ManagedAgent } from "../../runtime-types/hosts.js";

/** Default number of messages rendered per page. */
const DEFAULT_LIMIT = 50;
/** Maximum messages a caller may request per page. */
const MAX_LIMIT = 200;
/** Maximum characters of one message's text kept in the result. */
const MAX_MESSAGE_CHARS = 8000;

/** Truncate one message's text, marking what was dropped so the model knows to read on. */
function truncateMessageText(text: string): string {
  if (text.length <= MAX_MESSAGE_CHARS) return text;
  return `${text.slice(0, MAX_MESSAGE_CHARS)}…[truncated ${text.length - MAX_MESSAGE_CHARS} chars]`;
}

/** Render one message as a text block (role + time, then text and a tool summary line). */
function renderMessage(message: SessionMessage): string {
  const surface = message.surface === "shadowed" ? " · shadowed" : "";
  const head = `[${message.role}${surface}]${
    message.timestamp ? ` (${new Date(message.timestamp).toISOString()})` : ""
  }`;
  const parts = [message.text].filter(Boolean);
  if (message.toolSummary) parts.push(`<${message.toolSummary}>`);
  return `${head} ${parts.join(" ")}`.trim();
}

const sessionMessageSchema = z.object({
  index: z.number().int().nonnegative().describe("0-based message index."),
  role: z.string().describe("Message role: user | assistant | tool."),
  timestamp: z.number().optional().describe("Message time in epoch ms when known."),
  surface: z
    .enum(["current", "shadowed"])
    .describe("`current` = still in the session's context; `shadowed` = compacted out (log only)."),
  text: z.string().describe("Message text (empty for a tool-only message)."),
  toolSummary: z.string().nullable().describe("One-line summary of the message's tool calls, or null."),
});

export const sessionReadOutputSchema = z.object({
  sessionId: z.string().describe("The session that was read."),
  messages: z.array(sessionMessageSchema).describe("Messages in this page, in order."),
  /** Rendered page text (what the model reads). Spilled to `cachedOutputPath` when large. */
  content: z.string().describe("The page rendered as text, or a head+tail preview when spilled to disk."),
  offset: z.number().describe("Window start (0-indexed message)."),
  limit: z.number().describe("Window size requested."),
  returned: z.number().describe("Messages returned in this page."),
  total: z.number().describe("Total messages in the session."),
  hasMore: z.boolean().describe("True when later messages remain; re-call with offset advanced."),
  durationMs: z.number().describe("Execution duration in milliseconds."),
  ...toolOutputBaseSchema.shape,
});

export type SessionReadOutput = z.infer<typeof sessionReadOutputSchema>;

/**
 * Create the `session_read` tool.
 *
 * `managed` is accepted for parity with the other tool factories but is unused: reading a named
 * session does not depend on which session is live.
 */
export const createSessionReadTool = (_options: { managed?: ManagedAgent } = {}) => {
  return defineServerTool({
    name: "session_read",
    present: { category: "reads" },
    description: `Read a past session's messages as text, one window at a time.

Use after \`session_search\` returns a \`sessionId\` you want to read in full. A page is bounded by
message count AND by total size, so it can hold fewer messages than \`limit\`; when more remain the
text ends with the exact \`offset\` to call again — use that number, do not advance by \`limit\`.`,
    inputSchema: z.object({
      sessionId: z.string().describe("Session id to read (as returned by `session_search`)."),
      offset: z
        .number()
        .int({ message: "offset: must be an integer" })
        .min(0, { message: "offset: must be >= 0 (0-indexed)" })
        .optional()
        .describe("Message index to start from. Defaults to 0."),
      limit: z
        .number()
        .int({ message: "limit: must be an integer" })
        .min(1, { message: "limit: must be >= 1" })
        .max(MAX_LIMIT, { message: `limit: must be <= ${MAX_LIMIT}` })
        .optional()
        .describe(`Maximum messages to return. Defaults to ${DEFAULT_LIMIT}.`),
    }),
    outputSchema: sessionReadOutputSchema,
    execute: async ({ sessionId, offset, limit }, { toolCallId, coreEnv }) => {
      return withDuration(async () => {
        const start = offset ?? 0;
        const take = limit ?? DEFAULT_LIMIT;

        // Bound the READ, not only the rendered page. Folding a session is inherently whole-file
        // (`readSessionMessages`), so an oversized log would be materialized in full before any of
        // the page/text caps apply — the same OOM class `read_file` rejects with a pre-read
        // `stat.size` check, and the same bound `session_search` already applies while scanning.
        // `session_search` can still find the session; the message names that alternative.
        const logSize = await sessionLogSize(coreEnv, sessionId);
        if (logSize !== null && logSize > MAX_SESSION_FILE_BYTES) {
          throw new Error(
            `Session log too large to read: ${formatByteSize(logSize)} ` +
              `(max ${formatByteSize(MAX_SESSION_FILE_BYTES)}). Use session_search to locate a specific message.`
          );
        }

        const all = await readSessionMessages(coreEnv, sessionId);
        if (all.length === 0 && !(await sessionExists(coreEnv, sessionId))) {
          throw new FileError("not_found", `Session "${sessionId}" has no log on disk`, sessionId);
        }

        // Bound the page by message count AND accumulated text: a window of very long messages
        // (a pasted document, a large tool result) must not blow the context. Messages are
        // truncated individually, and the page stops once the shared content ceiling is reached.
        const page: SessionMessage[] = [];
        let pageChars = 0;
        for (let i = start; i < all.length && page.length < take; i++) {
          const remaining = OUTPUT_LIMITS.MAX_CONTENT_CHARS - pageChars;
          if (remaining <= 0) break;
          let text = truncateMessageText(all[i]!.text);
          if (text.length > remaining) text = `${text.slice(0, remaining)}…[truncated]`;
          page.push({ ...all[i]!, text });
          pageChars += text.length;
        }

        const hasMore = start + page.length < all.length;
        const content = renderPage(sessionId, page, start, all.length, hasMore);
        // Spill the rendered page when large, so the model gets a head+tail preview plus a path.
        const cached = await maybeCacheOutput(coreEnv, content, `${toolCallId}-session-read`);

        return {
          sessionId,
          messages: page,
          content: cached.content,
          offset: start,
          limit: take,
          returned: page.length,
          total: all.length,
          hasMore,
          cachedOutputPath: cached.cachedOutputPath,
        };
      });
    },
    toModelOutput({ output }: { toolCallId: string; input: unknown; output: SessionReadOutput }) {
      if (isProjectedModelContent(output)) return output;
      return [{ type: "text" as const, content: output.content }];
    },
  });
};

/** Render a page of messages (already bounded) as the model-facing text. */
function renderPage(sessionId: string, page: SessionMessage[], start: number, total: number, hasMore: boolean): string {
  if (page.length === 0) {
    return `Session "${sessionId}" has no messages in this window.`;
  }
  const body = page.map(renderMessage).join("\n\n");
  const tail = hasMore ? `\n\n(more messages remain — call again with offset=${start + page.length})` : "";
  return `Session ${sessionId} (messages ${start}–${start + page.length - 1} of ${total}):\n\n${body}${tail}`;
}
