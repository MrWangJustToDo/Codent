/**
 * `ask_user` result assembly — the tool result is a CLIENT-supplied contract.
 *
 * `ask_user` is a client tool, so every host assembles the output by hand. They drifted: the ACP host
 * hard-coded `durationMs: 0`, and one host dropped typed text when a multi-select was submitted. The
 * merge rules below are the tool's contract, not a surface detail. Kept beside the tool (not in the
 * definition file) so the definition site stays schema + factory.
 */

import type { AskUserOutput } from "../ask-user-tool.js";

/**
 * What a host collected for an `ask_user` answer — the raw material, not the wire shape.
 *
 * `ask_user` is a client tool, so every host assembles the result by hand. They drifted: the ACP host
 * hard-coded `durationMs: 0`, and one host dropped the typed text when a multi-select was submitted.
 * The merge rules below are the tool's contract, not a surface detail.
 */
export interface AskUserAnswerInput {
  question: string;
  /** The plain-text answer (a single pick or free-form reply) when no structured field carries it. */
  answer?: string;
  /**
   * Labels the user ticked. Its presence marks the answer as MULTI-select: a single pick is reported
   * as `draft`/plain text by the host, because that is what the model must read it as.
   */
  selected?: readonly string[];
  /** Text the user typed. On a multiple-choice question it is one MORE answer, never a replacement. */
  draft?: string;
  /** Whether the question offered choices — decides `hasOptions`. Defaults to `selected.length > 0`. */
  hasOptions?: boolean;
  /**
   * The QUESTION's multi-select flag, not "how many were ticked". A multi-select answered with only
   * typed text (`selected` empty) is still a multi-select answer; the TUI sends this flag, and the
   * ACP elicitation path must too or the model loses the distinction.
   */
  multiSelect?: boolean;
  cancelled?: boolean;
  durationMs?: number;
  cachedOutputPath?: string | null;
}

/**
 * Assemble the tool result from what the host saw.
 *
 * Multi-select and the free-form field are BOTH answers: ticking two options and typing one more
 * yields all three (`selected` keeps the structure, `draft` keeps the typed part, `answer` is the
 * comma-joined reading for prompts that only read text).
 */
export function buildAskUserOutput(input: AskUserAnswerInput): AskUserOutput {
  const draft = input.draft?.trim() ? input.draft.trim() : undefined;
  const selected = input.selected ?? [];
  const base = {
    question: input.question,
    durationMs: input.durationMs ?? 0,
    cachedOutputPath: input.cachedOutputPath ?? null,
    ...(input.cancelled ? { cancelled: true } : {}),
  };

  // The `multiSelect` flag describes the QUESTION (the TUI always sends it), so a custom-only answer
  // to a multi-select question keeps it too. Fall back to the tick count for hosts that omit it.
  const multiSelect = input.multiSelect ?? selected.length > 1;
  if (selected.length > 0) {
    return {
      ...base,
      answer: [...selected, ...(draft ? [draft] : [])].join(", "),
      hasOptions: input.hasOptions ?? true,
      ...(multiSelect ? { multiSelect: true } : {}),
      selected: [...selected],
      ...(draft ? { draft } : {}),
    };
  }

  return {
    ...base,
    answer: draft ?? input.answer ?? "",
    hasOptions: input.hasOptions ?? false,
    ...(multiSelect ? { multiSelect: true } : {}),
    ...(draft ? { draft } : {}),
  };
}
