/**
 * Minimal JSON-RPC-over-HTTP client for the public MCP search endpoints
 * (`search.parallel.ai`, `mcp.exa.ai`).
 *
 * These endpoints speak MCP (`tools/call`) but are only ever hit for one tool by one
 * provider, so this is a direct POST plus response unwrapping — not a transport, not a
 * session, not `@tanstack/ai-mcp`. It exists so the ~60 lines of request framing and
 * SSE/JSON unwrapping are shared by Parallel and Exa instead of copied.
 *
 * The response body may be SSE (`data: {...}` frames) or plain JSON; both are accepted.
 */

import { getEnv, type ResolvedCoreEnv } from "../../../../../../env";
import { createTimeoutAbort } from "../../../../shared/abort-timeout.js";
import { DEFAULT_MAX_BODY_BYTES, readBodyTextBounded } from "../../fetch/bounded-body.js";

/** One MCP `tools/call`, returning the first text content block. */
export async function callMcpTool(options: {
  url: string;
  toolName: string;
  args: Record<string, unknown>;
  timeoutMs: number;
  signal?: AbortSignal;
  /** Extra request headers (e.g. `Authorization: Bearer <key>`). Keys are never put in the URL. */
  headers?: Record<string, string>;
  /** Workspace env for `fetch`; ambient when omitted. */
  coreEnv?: ResolvedCoreEnv;
}): Promise<string> {
  const { url, toolName, args, timeoutMs, signal, headers } = options;
  const { controller, cleanup } = createTimeoutAbort({ timeoutMs, signal });

  try {
    const response = await (options.coreEnv ?? getEnv()).fetch(url, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        ...headers,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: toolName, arguments: args },
      }),
    });

    if (!response.ok) {
      throw new Error(`MCP search failed with status: ${response.status}`);
    }

    const body = await readBodyTextBounded(response, DEFAULT_MAX_BODY_BYTES);
    const text = parseMcpResponse(body);
    if (text === undefined) {
      throw new Error("MCP search returned no content");
    }
    return text;
  } finally {
    cleanup();
  }
}

/**
 * Extract the text of the first content block from an MCP response, accepting either an
 * SSE stream (`data: {...}` lines) or a plain JSON body.
 *
 * Throws when the JSON-RPC result is an error (`result.isError === true`). MCP servers
 * report tool failures inside a success envelope (e.g. Exa returns a 401 message as
 * `isError:true` text), so treating that text as content would parse it into zero results
 * and mask a real failure as a successful empty search — the caller must throw instead so
 * `ProviderManager` falls back to the next provider.
 */
export function parseMcpResponse(body: string): string | undefined {
  for (const line of body.split("\n")) {
    if (!line.startsWith("data:")) continue;
    const data = line.slice(5).trim();
    if (!data || data === "[DONE]" || data === "null") continue;
    const text = extractContentText(data);
    if (text !== undefined) return text;
  }
  return extractContentText(body);
}

function extractContentText(raw: string): string | undefined {
  try {
    const parsed = JSON.parse(raw) as {
      result?: { content?: Array<{ text?: string }>; isError?: boolean };
      error?: { message?: string };
    };
    if (parsed?.result?.isError) {
      const message = parsed.result.content?.[0]?.text?.trim();
      throw new Error(message ? `MCP search error: ${message}` : "MCP search returned an error");
    }
    if (parsed?.error) {
      throw new Error(`MCP search error: ${parsed.error.message ?? "unknown"}`);
    }
    const content = parsed?.result?.content;
    if (Array.isArray(content) && typeof content[0]?.text === "string") {
      return content[0].text;
    }
  } catch (error) {
    // A JSON.parse failure is "not JSON — fall through"; an MCP error we raised is not.
    if (error instanceof SyntaxError) return undefined;
    throw error;
  }
  return undefined;
}
