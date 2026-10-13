/**
 * WebSearch Tool — Search the web using multiple search providers.
 *
 * Provider architecture:
 * - Brave Search API (when toolConfig.websearch.braveApiKey is set)
 * - Parallel MCP endpoint (free, no key; keyed tier with parallelApiKey)
 * - Exa MCP endpoint (free, no key; keyed tier with exaApiKey)
 * - Tavily REST API (tavilyApiKey required)
 * - DuckDuckGo HTML search (free, no API key required, last-resort fallback)
 *
 * Provider selection via ProviderManager:
 * 1. toolConfig.websearch.provider can override (e.g., "brave", "parallel", "exa", "tavily", "duckduckgo", "auto")
 * 2. auto mode: a free provider chosen from the session id, else first available
 * 3. On failure, automatically falls back to the next available provider
 */

import { z } from "zod";

import { isAbortError } from "../../runtime-types/abort.js";

import { defineServerTool, isProjectedModelContent } from "./runtime/define-tool.js";
import { withDuration } from "./util/tool-result.js";
import { toolOutputBaseSchema } from "./util/types.js";
import { createConfiguredProviderManager, filterResultsByDomain } from "./websearch";

import type { ManagedAgent } from "../../runtime-types/hosts.js";

// ============================================================================
// Constants
// ============================================================================

const DEFAULT_TIMEOUT = 30; // 30 seconds
const MAX_TIMEOUT = 60; // 1 minute
const MAX_RESULTS = 10; // Maximum results to return
const DEFAULT_RESULTS = 5; // Default number of results

// ============================================================================
// Output Schema
// ============================================================================

export const websearchOutputSchema = z.object({
  /** The search query */
  query: z.string().describe("The search query that was executed"),
  /** Search results */
  results: z
    .array(
      z.object({
        title: z.string().describe("Title of the search result"),
        snippet: z.string().describe("Snippet/description of the result"),
        url: z.string().describe("URL of the result"),
      })
    )
    .describe("Array of search results"),
  /** Provider used for this search */
  provider: z.string().describe("The search provider used"),
  /** Execution duration in milliseconds */
  durationMs: z.number().describe("Execution duration in milliseconds"),
  /** Present when the USER aborted the run mid-search; see `runCommandOutputSchema.cancelled`. */
  cancelled: z.boolean().optional().describe("True when the user aborted the run while this search was in flight."),
  ...toolOutputBaseSchema.shape,
});

export type WebsearchOutput = z.infer<typeof websearchOutputSchema>;

// ============================================================================
// Tool Factory
// ============================================================================

/**
 * Creates a web search tool for searching the web via multiple providers.
 *
 * Features:
 * - Brave Search API (when toolConfig.websearch.braveApiKey is set)
 * - Parallel MCP search (free, no API key; keyed tier an optional upgrade)
 * - Exa MCP search (free, no API key; keyed tier an optional upgrade)
 * - Tavily REST search (requires tavilyApiKey)
 * - DuckDuckGo HTML search (free, no API key, fallback)
 * - Automatic provider selection and fallback
 * - Domain filtering (allow/block specific domains)
 * - Returns titles, snippets, and URLs
 */
export const createWebsearchTool = ({ managed }: { managed?: ManagedAgent }) => {
  // Agent-scoped provider manager: its own providers + key/session state, so two agents
  // (or runtimes) never share selection or credentials.
  const providerManager = createConfiguredProviderManager();

  return defineServerTool({
    name: "websearch",
    present: { category: "searches" },
    description: `Search the web and return titles, snippets, and URLs.

Use when you need current information, docs, or to discover URLs (then webfetch). Prefer over webfetch when the URL is unknown.
Supports domain allow/block filters. Provider is chosen automatically: a configured API key wins, else a free provider spread by session, else DuckDuckGo; on failure it falls back to the next available.

When answering from search results, include a Sources section with markdown links: [Title](URL).
Use the current year from <current_date> in turn context for time-sensitive queries.`,

    inputSchema: z.object({
      query: z
        .string()
        .min(2, { message: "query: must be at least 2 characters" })
        .describe("Search query — be specific and concise."),
      maxResults: z
        .number()
        .int({ message: "maxResults: must be an integer" })
        .min(1, { message: "maxResults: must be >= 1" })
        .max(MAX_RESULTS, { message: "maxResults: must be <= 10" })
        .optional()
        .describe(`Maximum number of results to return (1-${MAX_RESULTS}). Defaults to ${DEFAULT_RESULTS}.`),
      allowedDomains: z
        .array(z.string())
        .optional()
        .describe("Only include results from these domains (e.g., ['github.com', 'stackoverflow.com'])"),
      blockedDomains: z
        .array(z.string())
        .optional()
        .describe("Exclude results from these domains (e.g., ['pinterest.com', 'quora.com'])"),
      timeout: z
        .number()
        .int({ message: "timeout: must be an integer (seconds)" })
        .min(5, { message: "timeout: must be >= 5 seconds" })
        .max(MAX_TIMEOUT, { message: "timeout: must be <= 60 seconds" })
        .optional()
        .describe(`Timeout in seconds (5-${MAX_TIMEOUT}). Defaults to ${DEFAULT_TIMEOUT}.`),
    }),

    outputSchema: websearchOutputSchema,

    execute: async ({ query, maxResults, allowedDomains, blockedDomains, timeout }, { abortSignal, coreEnv }) => {
      return withDuration(async () => {
        if (allowedDomains?.length && blockedDomains?.length) {
          throw new Error("Cannot specify both allowedDomains and blockedDomains in the same request");
        }

        const timeoutMs = Math.min((timeout ?? DEFAULT_TIMEOUT) * 1000, MAX_TIMEOUT * 1000);
        const limit = maxResults ?? DEFAULT_RESULTS;

        const controller = new AbortController();
        const managedAgent = managed;
        const hasParentAgent = managedAgent?.parentId;

        // Carry the run's abort reason (`"user-cancelled"`, …) rather than a bare abort — a
        // reason-less abort becomes the platform `AbortError`, which reads as a cancel only by
        // name. Detached after the call so a long run does not accumulate one listener per search.
        const onAbort = () => controller.abort(abortSignal?.reason);
        abortSignal?.addEventListener("abort", onAbort, { once: true });

        if (!hasParentAgent) {
          managedAgent?.addPendingAbortController(controller);
        }

        try {
          const pm = providerManager;
          // A stable per-session value lets the manager spread sessions across the free
          // providers (so one public endpoint is not the single dependency) and lets a
          // provider forward it upstream (Parallel's `session_id`). Subagents have no
          // session data of their own, so fall back to the agent id — still stable per agent.
          const sessionId = managed?.getSessionData()?.id ?? managed?.id;
          // configure + search run under one lock: both mutate/read the process-global
          // manager, so concurrent runs must not interleave (see ProviderManager.runExclusive).
          const { results: rawResults, provider } = await pm.runExclusive(async (m) => {
            m.configure(managed?.config?.toolConfig?.websearch);
            m.setSessionId(sessionId);
            return m.search(query, {
              maxResults: limit,
              allowedDomains,
              blockedDomains,
              timeoutMs,
              signal: controller.signal,
              coreEnv,
              ...(sessionId ? { sessionId } : {}),
            });
          });

          const filteredResults = filterResultsByDomain(rawResults, allowedDomains, blockedDomains);

          return {
            query,
            results: filteredResults.slice(0, limit),
            provider,
          };
        } catch (err) {
          // The user aborting is not a search failure — same contract as run_command and
          // webfetch: settle normally with the marker so the row reads "cancelled".
          if (!isAbortError(err, abortSignal)) throw err;
          return { query, results: [], provider: "", cancelled: true };
        } finally {
          abortSignal?.removeEventListener("abort", onAbort);
          if (!hasParentAgent) {
            managedAgent?.removePendingAbortController(controller);
          }
        }
      });
    },
    toModelOutput({ output }: { toolCallId: string; input: unknown; output: z.infer<typeof websearchOutputSchema> }) {
      if (isProjectedModelContent(output)) return output;
      // A cancelled search returns no results; without this the model reads "no results" as
      // a real (empty) outcome instead of a stopped run.
      if (output.cancelled) {
        return [{ type: "text" as const, content: `[Search cancelled by user.] ${output.query}` }];
      }
      const lines = output.results?.map?.((r) => `${r.title}\n${r.url}\n${r.snippet}`);
      return [
        {
          type: "text" as const,
          content: `Search (${output.provider}): ${output.query}\n\n${lines?.join("\n\n") ?? "(no results)"}`,
        },
      ];
    },
  });
};
