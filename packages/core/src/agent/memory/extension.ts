/**
 * Built-in Memory extension — exposes persistent cross-session memories to the agent.
 *
 * Provides:
 * - `memory_list` tool: list memory files (name + description from the index)
 * - `memory_read` tool: read the full content of a specific memory
 * - `memory_write` tool: create / update a memory (user preference, project fact, ...)
 * - Turn-context injection of the MEMORY.md index into its own
 *   `<ctx kind="ext:codent-memory:index">` section (progressive disclosure: names + descriptions
 *   are always visible; the full body is loaded on demand via `memory_read`), plus the per-turn
 *   selection section `ext:codent-memory:selection`.
 *
 * The per-turn relevance query (top-N memories by current user message) also lives here: the
 * extension selects through its own `ctx.llm` port and publishes the result as its
 * `ext:codent-memory:selection` section, so the run lifecycle no longer knows memory exists. The
 * index is the sibling `ext:codent-memory:index` section (independent hash admission), and the
 * surfaced set is committed when the turn's first assistant message starts
 * (`message:start.firstOutput`).
 *
 * End-of-turn extraction/consolidation still belongs to the run lifecycle (`MemoryService`): it
 * needs the finished turn's model-visible window and runs after finalize, which a context
 * provider cannot express.
 *
 * Runtime-agnostic: all I/O goes through the injected `MemoryManager`, which uses the global
 * CoreEnv (`getEnv()`), and all model access goes through `ctx.llm`.
 */

import { DISCOVERY_TOOL_NAME } from "@tanstack/ai";

import { defaultByteLength } from "../../env";
import { errorMessage } from "../../utils/errors.js";
import { extractTextFromContent } from "../compaction/message-utils.js";
import { BUILTIN_EXTENSION_ORDER } from "../dispatch-order.js";
import { isProjectedModelContent } from "../tools/runtime/projected-model-content.js";

import { findRelevantMemories, formatRelevantMemories } from "./memory-retrieval.js";

import type { MemoryManager } from "./memory-manager.js";
import type { MemoryCompletion, MemoryLog, MemoryTelemetry } from "./types.js";
import type { ExtensionAPI, ExtensionContext, ExtensionContextSectionProvider } from "../extension/types.js";
import type { SchemaInput } from "@tanstack/ai";

// ============================================================================
// Config
// ============================================================================

/** Fine-grained configuration for the built-in memory extension. */
export interface MemoryExtensionConfig {
  /**
   * Disable the on-demand tools (memory_list/memory_read/memory_write). Default: false (tools
   * registered); the context sections stay enabled unless `indexDisabled`/`selectionDisabled`
   * say otherwise.
   */
  toolsDisabled?: boolean;
  /**
   * Disable injecting the memory index into turn context. Default: false
   * (index injected when memories exist).
   */
  indexDisabled?: boolean;
  /**
   * Disable the per-turn relevance query (the `ext:codent-memory:selection` section).
   * Default: false (one selection completion per user turn).
   */
  selectionDisabled?: boolean;
}

// ============================================================================
// Extension factory
// ============================================================================

export interface CreateMemoryExtensionOptions {
  /** Pre-initialized memory manager (created by the agent factory). */
  memoryManager: MemoryManager;
  /** Fine-grained config. */
  config?: MemoryExtensionConfig;
  /**
   * Host telemetry sink for `memory:prefetch` (and, once extraction moves here, the other two
   * memory events). Injected by the core bootstrap because an extension cannot emit bus events;
   * it is core-internal, not part of the public extension API.
   */
  emitEvent?: MemoryTelemetry;
}

/** Create the built-in Memory extension. */
export function createMemoryExtension(options: CreateMemoryExtensionOptions): ExtensionAPI {
  const { memoryManager, config, emitEvent } = options;
  return {
    id: "codent-memory",
    // Built-ins are the baseline: they run first in interceptor/transformer chains and lose a
    // same-name tool to a user extension. Loading last must not mean "runs last, wins".
    order: BUILTIN_EXTENSION_ORDER,
    name: "Memory",
    version: "1.0.0",
    description:
      "Persistent cross-session memories: memory_list/memory_read/memory_write tools + MEMORY.md index injected into turn context",
    async activate(ctx) {
      await activateMemory(ctx, memoryManager, config, emitEvent);
    },
  };
}

async function activateMemory(
  ctx: ExtensionContext,
  memoryManager: MemoryManager,
  config?: MemoryExtensionConfig,
  emitEvent?: MemoryTelemetry
): Promise<void> {
  const z = ctx.z;

  if (config?.toolsDisabled !== true) {
    ctx.registerTool({
      name: "memory_list",
      present: { category: "searches" as const },
      // Lazy: the <memory_index> in turn context already carries name + type +
      // description for every memory, so the eager schema was ~471 bytes of prompt
      // per turn restating what the model can already read. Measured over 195 root
      // runs it was called once. The index (below) and the description both name
      // DISCOVERY_TOOL_NAME, so nothing has to guess how to reach it.
      lazy: true,
      description: `List available memories (name + type + description).

Memories are durable facts extracted from previous sessions (user preferences,
project conventions, decisions). The <memory_index> in turn context already
lists them; call this to refresh or enumerate with type/filename detail.

This is a lazy tool: discover it via ${DISCOVERY_TOOL_NAME} before calling.`,
      inputSchema: z.object({}),
      outputSchema: z.object({
        memories: z.array(
          z.object({
            name: z.string(),
            type: z.string(),
            description: z.string(),
            filename: z.string(),
          })
        ),
        count: z.number(),
      }),
      execute: async () => {
        const memories = await memoryManager.listMemories();
        return {
          memories: memories.map((m) => ({
            name: m.name,
            type: m.type,
            description: m.description,
            filename: m.filename,
          })),
          count: memories.length,
        };
      },
      // Only send the readable summary to the LLM — filename is derived, avoid extra tokens.
      toModelOutput({ output }) {
        if (isProjectedModelContent(output)) return output;
        const list = output as { memories?: Array<{ name: string; type: string; description: string }> };
        const lines = list?.memories?.map((m) => `- [${m.type}] ${m.name}: ${m.description}`) ?? [];
        return lines.length > 0 ? `Available memories:\n${lines.join("\n")}` : "No memories stored.";
      },
    });

    ctx.registerTool({
      name: "memory_read",
      present: { category: "reads" as const },
      description: `Read the full content of a memory by name or filename.

Use after memory_list (or the <memory_index>) to load the full body of a specific
memory. Returns the memory wrapped in <memory> tags.`,
      inputSchema: z.object({
        name: z.string().describe("The memory name or filename to read"),
      }),
      outputSchema: z.object({
        name: z.string(),
        type: z.string(),
        description: z.string(),
        content: z.string(),
      }),
      execute: async (input) => {
        const { name } = (input ?? {}) as { name?: string };
        const memories = await memoryManager.listMemories();
        const match =
          memories.find((m) => m.name === String(name)) ??
          memories.find((m) => m.filename === String(name)) ??
          memories.find((m) => m.filename.replace(/\.md$/, "") === String(name));
        if (!match) {
          const available =
            memories.length > 0
              ? `Available memories: ${memories.map((m) => m.name).join(", ")}`
              : "No memories are currently stored.";
          throw new Error(`Unknown memory '${String(name)}'. ${available}`);
        }
        const content = `<memory name="${match.name.replace(/"/g, "&quot;")}" type="${match.type}">\n${match.description}\n\n${match.body}\n</memory>`;
        return { name: match.name, type: match.type, description: match.description, content };
      },
      // Only send content to the LLM — name is echoed in the input.
      toModelOutput({ output }) {
        if (isProjectedModelContent(output)) return output;
        return (output as { content: string }).content;
      },
    });

    ctx.registerTool({
      name: "memory_write",
      present: { category: "edits" as const },
      description: `Write a durable memory to persist knowledge across sessions.

Use for user preferences, corrections, project facts, decisions, and external
references worth remembering later. Prefer updating an existing memory over
creating a duplicate (check memory_list first).`,
      inputSchema: z.object({
        name: z.string().describe("Short kebab-case identifier (e.g. user-prefers-tabs)"),
        type: z.enum(["user", "feedback", "project", "reference"]).describe("Memory category"),
        description: z.string().describe("One-line summary for the index"),
        body: z.string().describe("Full detail in markdown"),
      }),
      outputSchema: z.object({
        filename: z.string(),
        ok: z.boolean(),
      }),
      execute: async (input) => {
        const { name, type, description, body } = (input ?? {}) as {
          name?: string;
          type?: "user" | "feedback" | "project" | "reference";
          description?: string;
          body?: string;
        };
        const filename = await memoryManager.writeMemory(
          String(name),
          String(type) as "user" | "feedback" | "project" | "reference",
          String(description),
          String(body)
        );
        return { filename, ok: true };
      },
      toModelOutput({ output }) {
        if (isProjectedModelContent(output)) return output;
        return `Memory saved to ${(output as { filename: string }).filename}.`;
      },
    });
  }

  // ==========================================================================
  // Per-turn context: index + selection as independent named sections
  // ==========================================================================

  /** Filenames already injected this session, and the ones this turn injected (commit pending). */
  const alreadySurfaced = new Set<string>();
  let pendingFilenames: string[] = [];
  let lastSessionId: string | null = null;

  const log: MemoryLog = {
    info: (message) => ctx.logger.log("info", "memory", message),
    warn: (message) => ctx.logger.log("warn", "memory", message),
  };

  // The one-shot port: the host owns the connection/catalog/usage/budget, and defaults the
  // abort signal to the live run (`ctx.signal`).
  const complete: MemoryCompletion = async ({ system, prompt, maxOutputTokens, schema }) => {
    const result = await ctx.llm.complete({
      system,
      prompt,
      maxOutputTokens,
      schema: schema as SchemaInput,
    });
    return result.data;
  };

  /** The current user turn's text (the last user message on the model-visible wire). */
  const latestUserText = (): string => {
    const messages = ctx.getMessages();
    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i];
      if (message?.role === "user") return extractTextFromContent(message.content);
    }
    return "";
  };

  const indexContent = (): string | undefined => {
    const index = memoryManager.getIndexContent();
    if (!index.trim()) return undefined;
    return [
      "<memory_index>",
      "These are memories from previous sessions. Respect user preferences from memory.",
      "When the user says 'remember' or expresses a clear preference, it will be automatically extracted.",
      `memory_list is a lazy tool — discover it via ${DISCOVERY_TOOL_NAME} before calling.`,
      "",
      index.trim(),
      "</memory_index>",
    ].join("\n");
  };

  const produceSelection = async (): Promise<string | undefined> => {
    // A session switch means a new conversation: none of the surfaced memories are "already
    // shown" to it. Comparing ids is robust for new/switch/restore, none of which this extension
    // has to observe separately.
    if (ctx.sessionId !== lastSessionId) {
      alreadySurfaced.clear();
      lastSessionId = ctx.sessionId;
    }

    if (ctx.signal?.aborted) {
      pendingFilenames = [];
      emitEvent?.("memory:prefetch", { status: "aborted" });
      return undefined;
    }

    const query = latestUserText();
    if (!query.trim()) {
      pendingFilenames = [];
      emitEvent?.("memory:prefetch", { status: "skip-no-query" });
      return undefined;
    }

    try {
      const relevant = await findRelevantMemories(
        query,
        memoryManager,
        complete,
        alreadySurfaced,
        {},
        memoryManager.getEnv(),
        log
      );
      // An abort mid-call makes the helper fall back to keyword selection; that result belongs to
      // a turn nobody is waiting for, so drop it instead of injecting it.
      if (ctx.signal?.aborted) {
        pendingFilenames = [];
        emitEvent?.("memory:prefetch", { status: "aborted" });
        return undefined;
      }
      if (relevant.length === 0) {
        pendingFilenames = [];
        emitEvent?.("memory:prefetch", { status: "empty" });
        return undefined;
      }
      const content = formatRelevantMemories(relevant);
      pendingFilenames = relevant.map((memory) => memory.filename);
      emitEvent?.("memory:prefetch", {
        status: "selected",
        count: relevant.length,
        filenames: pendingFilenames,
        byteSize: defaultByteLength(content, "utf-8"),
      });
      return content;
    } catch (err) {
      pendingFilenames = [];
      emitEvent?.("memory:prefetch", { status: "error", error: errorMessage(err) });
      return undefined;
    }
  };

  // One commit per turn: the first assistant message proves the turn is actually running. A turn
  // aborted before any message never consumes the surfaced set.
  ctx.events.observe("message:start", (event) => {
    if (event.agentId !== ctx.agentId) return;
    const payload = event.payload as { role?: string; firstOutput?: boolean };
    if (payload.role !== "assistant" || payload.firstOutput !== true) return;
    for (const filename of pendingFilenames) alreadySurfaced.add(filename);
    pendingFilenames = [];
  });

  const sections: ExtensionContextSectionProvider[] = [];
  if (config?.indexDisabled !== true) {
    sections.push({ name: "index", content: indexContent });
  }
  if (config?.selectionDisabled !== true) {
    sections.push({ name: "selection", content: produceSelection });
  }
  ctx.registerContextProvider({
    ...(sections.length > 0 ? { sections } : {}),
    disabledContent: () =>
      "Memory extension is disabled — memory_list/memory_read/memory_write tools, the MEMORY.md index, and per-turn memory selection are unavailable.",
  });

  // `/memory` — list or read a memory. Listing needs no model turn; reading a
  // specific memory injects its full body into the session (drives the agent).
  ctx.registerCommand({
    name: "memory",
    description: "List memories, or load one by name: /memory [<name>]. With no name, lists all memories.",
    getOptions: async () => {
      const memories = await memoryManager.listMemories();
      return memories.map((m) => ({
        label: m.name,
        value: m.name,
        description: m.description,
      }));
    },
    execute: async (args) => {
      const name = args[0]?.trim();
      const memories = await memoryManager.listMemories();
      if (!name) {
        if (memories.length === 0) return "No memories are currently stored.";
        return memories.map((m) => `- [${m.type}] ${m.name}: ${m.description}`).join("\n");
      }
      const match =
        memories.find((m) => m.name === name) ??
        memories.find((m) => m.filename === name) ??
        memories.find((m) => m.filename.replace(/\.md$/, "") === name);
      if (!match) {
        const available =
          memories.length > 0 ? `Available memories: ${memories.map((m) => m.name).join(", ")}` : "none";
        return `Unknown memory '${name}'. ${available}`;
      }
      return `Loaded memory '${match.name}'. Agent will now act on it.`;
    },
    // Inject the full memory body into the session so the agent sees it.
    // Any text appended after /memory <name> is merged into the injected message
    // so the user can specify what they want done with the memory.
    injectMessage: async (args) => {
      const name = args[0]?.trim();
      if (!name) return undefined;
      const memories = await memoryManager.listMemories();
      const match =
        memories.find((m) => m.name === name) ??
        memories.find((m) => m.filename === name) ??
        memories.find((m) => m.filename.replace(/\.md$/, "") === name);
      if (!match) return undefined;
      const followup = args.slice(1).join(" ").trim();
      const body = `<memory name="${match.name.replace(/"/g, "&quot;")}" type="${match.type}">\n${match.description}\n\n${match.body}\n</memory>`;
      if (!followup) return body;
      return `${body}\n\nUser request with this memory:\n${followup}`;
    },
  });

  ctx.logger.info(
    `Memory extension activated (${memoryManager.getIndexContent().trim() ? "index ready" : "empty index"})`
  );
}
