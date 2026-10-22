import type { ContentPart } from "@tanstack/ai";

/** Content a tool may return to the model after projection. */
export type ModelToolContent = string | ContentPart[];

export interface ToModelOutputContext {
  toolCallId: string;
  input: unknown;
  output: unknown;
}

export type ToModelOutputFn = (ctx: ToModelOutputContext) => Promise<ModelToolContent> | ModelToolContent;

/**
 * Decorator: wraps the base `toModelOutput` handler for a tool, letting an
 * extension augment the model-facing content (e.g. append LSP diagnostics).
 * `next` invokes the underlying handler chain.
 */
export type ToModelOutputDecorator = (
  ctx: ToModelOutputContext,
  next: ToModelOutputFn
) => Promise<ModelToolContent> | ModelToolContent;
