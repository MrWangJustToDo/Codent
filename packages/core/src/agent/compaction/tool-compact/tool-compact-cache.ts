import type { ModelToolContent } from "../../tools/runtime/contract.js";

// ============================================================================
// In-memory cache for per-toolCallId LLM-facing compact output
// ============================================================================

export class ToolCompactCache {
  private readonly entries = new Map<string, ModelToolContent>();

  get(toolCallId: string): ModelToolContent | undefined {
    return this.entries.get(toolCallId);
  }

  set(toolCallId: string, content: ModelToolContent): void {
    this.entries.set(toolCallId, content);
  }

  delete(toolCallId: string): void {
    this.entries.delete(toolCallId);
  }

  clear(): void {
    this.entries.clear();
  }

  has(toolCallId: string): boolean {
    return this.entries.has(toolCallId);
  }
}
