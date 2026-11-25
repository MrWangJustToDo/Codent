/**
 * A provider tool-call id is request-scoped, so one transcript can hold several calls sharing it
 * (`call_0` in every turn of an OpenAI-compatible stream).
 *
 * The SDK's updater matches the FIRST part in EVERY message: answering a reused id overwrote a
 * previous turn's result and left the live call unanswered. These helpers are the one rule for
 * "settle/write the LAST call", shared by the result write, the display write and the ready-check —
 * three readers that must agree about which call is the live one.
 */

import { normalizeToolResult } from "@tanstack/ai";

import type { ToolDisplayPayload } from "../tools/presentation/types.js";

/** Structural view of a tool-call part for the display patchers (UI parts carry extra fields). */
export interface PatchableToolCallPart {
  type?: string;
  id?: string;
  name?: string;
  state?: string;
  output?: unknown;
  arguments?: unknown;
  input?: unknown;
  display?: ToolDisplayPayload;
}

export interface PatchableMessage {
  parts?: PatchableToolCallPart[];
}

/** True when more than one part carries this tool-call id (a reused provider id). */
export function hasDuplicateToolCall(messages: readonly PatchableMessage[], toolCallId: string): boolean {
  let seen = 0;
  for (const message of messages) {
    for (const part of message.parts ?? []) {
      if (part?.type !== "tool-call" || part.id !== toolCallId) continue;
      seen += 1;
      if (seen > 1) return true;
    }
  }
  return false;
}

/** Patch the LAST part carrying `toolCallId` (the live call when provider ids are reused). */
export function patchLastToolCall<M extends PatchableMessage>(
  messages: M[],
  toolCallId: string,
  patch: Record<string, unknown>
): M[] | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const parts = messages[i]?.parts;
    if (!parts?.length) continue;
    for (let j = parts.length - 1; j >= 0; j--) {
      const part = parts[j];
      if (part?.type !== "tool-call" || part.id !== toolCallId) continue;
      const nextParts = [...parts];
      nextParts[j] = { ...part, ...patch } as PatchableToolCallPart;
      const next = [...messages];
      next[i] = { ...messages[i], parts: nextParts } as M;
      return next;
    }
  }
  return null;
}

/**
 * Settle the LAST call carrying `toolCallId`, in the message that owns it.
 *
 * Mirrors both halves of the SDK's `addToolResult`: the call's `state`/`output` and a `tool-result`
 * part in the SAME message (the model wire reads `tool-result`; a call-only patch would settle the
 * UI and leave the model without an answer).
 */
export function attachResultToLastCall<M extends PatchableMessage>(
  messages: M[],
  toolCallId: string,
  output: unknown,
  error?: string
): M[] | null {
  let messageIndex = -1;
  let partIndex = -1;
  for (let i = messages.length - 1; i >= 0 && messageIndex < 0; i--) {
    const parts = messages[i]?.parts;
    if (!parts?.length) continue;
    for (let j = parts.length - 1; j >= 0; j--) {
      const part = parts[j];
      if (part?.type === "tool-call" && part.id === toolCallId) {
        messageIndex = i;
        partIndex = j;
        break;
      }
    }
  }
  if (messageIndex < 0) return null;

  const message = messages[messageIndex]!;
  const parts = [...(message.parts ?? [])];
  const call = parts[partIndex]!;
  parts[partIndex] = {
    ...call,
    output: error ? { error } : output,
    state: error ? "error" : "complete",
  };
  const content = normalizeToolResult(output);
  const resultIndex = parts.findIndex((part) => part?.type === "tool-result" && part.id === toolCallId);
  // Mirror the SDK's `updateToolResultPart`: an EXISTING result keeps the fields this function does
  // not own (`name`, `id`, `metadata`) and the new state replaces the rest — including clearing a
  // stale `error` when the call now succeeds.
  const existing = resultIndex >= 0 ? (parts[resultIndex] as Record<string, unknown>) : undefined;
  const resultPart = {
    ...(existing ?? {}),
    type: "tool-result",
    toolCallId,
    content,
    state: error ? "error" : "complete",
  } as unknown as Record<string, unknown>;
  if (error) resultPart.error = error;
  else delete resultPart.error;
  // A CONTROL outcome left on metadata outlives the result it described. The SDK strips it whenever
  // the result completes without a new outcome (`withoutStaleToolResultOutcome`), because the wire
  // reader treats `metadata.tanstack.toolResultOutcome` as the verdict — a kept `"denied"` would make
  // a now-complete result project as an error. Same rule, same place.
  if (!error) {
    const metadata = (resultPart as { metadata?: Record<string, unknown> }).metadata;
    const tanstack = metadata?.tanstack as Record<string, unknown> | undefined;
    if (metadata && tanstack && "toolResultOutcome" in tanstack) {
      const { toolResultOutcome: _staleOutcome, ...restTanstack } = tanstack;
      const nextMetadata = { ...metadata };
      if (Object.keys(restTanstack).length > 0) nextMetadata.tanstack = restTanstack;
      else delete nextMetadata.tanstack;
      if (Object.keys(nextMetadata).length > 0) resultPart.metadata = nextMetadata;
      else delete resultPart.metadata;
    }
  }
  if (resultIndex >= 0) parts[resultIndex] = resultPart as unknown as PatchableToolCallPart;
  else parts.push(resultPart as unknown as PatchableToolCallPart);

  const next = [...messages];
  next[messageIndex] = { ...message, parts } as M;
  return next;
}
