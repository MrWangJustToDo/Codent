import type { ModelStyle } from "../types.js";
import type { ContentPart, ModelMessage, ServerTool, SystemPrompt } from "@tanstack/ai";

// ============================================================================
// Constants
// ============================================================================

/**
 * Separator between static and dynamic parts of the system prompt.
 * Content before this marker is eligible for API-level prompt caching (Anthropic, OpenAI).
 * Content after changes per-turn and cannot use global cache.
 */
export const SYSTEM_PROMPT_DYNAMIC_BOUNDARY = "\n<SYSTEM_PROMPT_DYNAMIC_BOUNDARY>\n";

/** Anthropic / OpenAI-compatible ephemeral prompt-cache marker (default 5m TTL). */
export const EPHEMERAL_CACHE_CONTROL = { type: "ephemeral" as const };

/** Max explicit Anthropic `cache_control` breakpoints per request. */
export const ANTHROPIC_CACHE_BREAKPOINT_CAP = 4;

// ============================================================================
// System prompt split (frozen vs dynamic)
// ============================================================================

export interface SplitSystemPromptResult {
  frozen: string;
  dynamic?: string;
}

/**
 * Split a system prompt string on {@link SYSTEM_PROMPT_DYNAMIC_BOUNDARY}.
 * Frozen includes the boundary marker when present (byte-stable prefix).
 */
export function splitSystemPromptAtDynamicBoundary(system: string): SplitSystemPromptResult {
  const marker = SYSTEM_PROMPT_DYNAMIC_BOUNDARY;
  const idx = system.indexOf(marker.trim());
  if (idx < 0) {
    return { frozen: system };
  }

  // Prefer the full marker (with surrounding newlines) when present.
  const fullIdx = system.indexOf(marker);
  if (fullIdx >= 0) {
    const end = fullIdx + marker.length;
    const dynamic = system.slice(end);
    return {
      frozen: system.slice(0, end),
      ...(dynamic.length > 0 ? { dynamic } : {}),
    };
  }

  const trimmed = marker.trim();
  const end = idx + trimmed.length;
  const dynamic = system.slice(end);
  return {
    frozen: system.slice(0, end),
    ...(dynamic.length > 0 ? { dynamic } : {}),
  };
}

function systemPromptContent(prompt: SystemPrompt): string {
  return typeof prompt === "string" ? prompt : prompt.content;
}

/**
 * Build Anthropic-friendly `systemPrompts`: frozen block with `cache_control`,
 * dynamic block without. Keeps a single concatenated string unchanged when there
 * is no dynamic segment (still marks frozen for caching).
 */
export function buildAnthropicCachedSystemPrompts(
  systemPrompts: SystemPrompt[] | undefined
): SystemPrompt[] | undefined {
  if (!systemPrompts?.length) return systemPrompts;

  const joined = systemPrompts.map(systemPromptContent).join("");
  if (!joined) return systemPrompts;

  const { frozen, dynamic } = splitSystemPromptAtDynamicBoundary(joined);
  const frozenEntry: SystemPrompt = {
    content: frozen,
    metadata: { cache_control: EPHEMERAL_CACHE_CONTROL },
  };

  if (dynamic == null || dynamic.length === 0) {
    return [frozenEntry];
  }
  return [frozenEntry, dynamic];
}

// ============================================================================
// Tools
// ============================================================================

/** Stable tool order for prefix-identical tool schemas across requests. */
export function sortToolsByName<T extends { name: string }>(tools: T[]): T[] {
  // Code-unit order, NOT `localeCompare`: collation is ICU/locale dependent, so the same tool set
  // could sort differently on another machine (or ICU version) and silently miss the prefix cache.
  return [...tools].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/**
 * Clone tools (sorted) and attach Anthropic `cacheControl` on the last tool.
 * Counts as one of the ≤4 explicit breakpoints.
 */
export function applyAnthropicToolCacheBreakpoint(tools: ServerTool[] | undefined): ServerTool[] | undefined {
  if (!tools?.length) return tools;

  const sorted = sortToolsByName(tools);
  const lastIndex = sorted.length - 1;
  const last = sorted[lastIndex]!;
  sorted[lastIndex] = {
    ...last,
    metadata: {
      ...last.metadata,
      cacheControl: EPHEMERAL_CACHE_CONTROL,
    },
  };
  return sorted;
}

// ============================================================================
// Messages — latest user breakpoint
// ============================================================================

function stripCacheControlMetadata(metadata: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!metadata) return undefined;
  const { cache_control: _ignored, ...rest } = metadata;
  return Object.keys(rest).length > 0 ? rest : undefined;
}

function withCacheControlOnLastPart(parts: ContentPart[]): ContentPart[] {
  return parts.map((part, index) => {
    const baseMeta =
      part.metadata && typeof part.metadata === "object"
        ? stripCacheControlMetadata(part.metadata as Record<string, unknown>)
        : undefined;
    if (index !== parts.length - 1) {
      return baseMeta ? { ...part, metadata: baseMeta } : { ...part, metadata: undefined };
    }
    return {
      ...part,
      metadata: {
        ...baseMeta,
        cache_control: EPHEMERAL_CACHE_CONTROL,
      },
    };
  });
}

/**
 * Stamp `cache_control` on the last content part of the latest `user` message.
 * Converts string content to a text part so Anthropic can attach the marker.
 * Safe across tool-loop iterations (same user message stays the breakpoint).
 */
export function applyAnthropicLatestUserCacheBreakpoint(messages: ModelMessage[]): ModelMessage[] {
  let lastUserIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === "user") {
      lastUserIdx = i;
      break;
    }
  }
  if (lastUserIdx < 0) return messages;

  const msg = messages[lastUserIdx]!;
  let nextContent: ContentPart[];

  if (typeof msg.content === "string") {
    nextContent = [
      {
        type: "text",
        content: msg.content,
        metadata: { cache_control: EPHEMERAL_CACHE_CONTROL },
      },
    ];
  } else if (Array.isArray(msg.content) && msg.content.length > 0) {
    nextContent = withCacheControlOnLastPart(msg.content as ContentPart[]);
  } else {
    return messages;
  }

  const next = messages.slice();
  next[lastUserIdx] = { ...msg, content: nextContent };
  return next;
}

// ============================================================================
// OpenAI prompt_cache_key
// ============================================================================

/** Session-scoped key for OpenAI / compatible Chat Completions routing affinity. */
export function resolvePromptCacheKey(sessionId: string | undefined, agentId: string): string {
  const raw = sessionId?.trim() || agentId;
  // OpenAI allows up to 64 chars; keep stable alphanumeric-ish keys.
  return raw.length <= 64 ? raw : raw.slice(0, 64);
}

export function shouldApplyOpenAIPromptCacheKey(style: ModelStyle | undefined): boolean {
  return style !== "anthropic";
}

export function shouldApplyAnthropicCacheBreakpoints(style: ModelStyle | undefined): boolean {
  return style === "anthropic";
}
