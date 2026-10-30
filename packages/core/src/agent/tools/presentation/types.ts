/**
 * Tool presentation descriptors — the single source of truth for how a tool is
 * displayed: fold grouping, row visibility, header summary, labels, and the result
 * text itself.
 *
 * Descriptors live in core because core owns the tools **and** because the host may
 * run in another process (remote CoreEnv, remote Agent Session, extension hosts).
 * Core renders these functions once, at tool completion, and ships the result with
 * the message part (`part.display`), so no host needs a tool-name table of its own.
 *
 * Purity: every function here MUST be a pure function of the stored tool output (or
 * the parsed input). No timestamps, randomness, or wall-clock state — the rendered
 * payload is persisted with the session, so a non-deterministic value would corrupt
 * the durable chain as well as the prompt-cache prefix.
 */

/**
 * What a tool does, in one bucket.
 *
 * `edits` is **load-bearing beyond display**: plan mode withholds exactly the tools that declare it
 * (`agent/plan/plan-tools.ts`), so moving a tool into `edits` restricts it while planning and moving
 * one out makes it available there. `validate:plan-tool-boundary` asserts that boundary, so a change
 * here is a boundary change rather than a display tweak.
 */
export type ToolActivityCategory = "reads" | "edits" | "searches" | "commands" | "tasks" | "other";

export interface ToolPresentation {
  /** Fold bucket for activity summaries (`"other"` when unset). */
  category?: ToolActivityCategory;
  /** Completed rows of this tool never fold in compact display (structured / interactive results). */
  keepRow?: boolean;
  /** Render a detailed result block in full display. */
  detailed?: boolean;
  /** The host supplies the result (e.g. an interactive prompt) — never fold. */
  clientSide?: boolean;
  /** Header text derived from the tool output, e.g. `3 matches`. */
  summary?: (output: unknown) => string | undefined;
  /** Short label for a tool call's input, shown in activity-summary label lists. */
  label?: (input: unknown) => string | undefined;
  /**
   * Result text: the one string a completed call shows (full display).
   *
   * It is NOT a row policy. Compact display folds a built-in's body like any other output; only an
   * extension tool keeps its row on `text`, because that string is its whole result. Use
   * {@link ToolPresentation.keepRow} to own the row.
   */
  text?: (output: unknown) => string | undefined;
  /** Header input text; `compact` marks compact display (callers shorten further). */
  input?: (input: unknown, opts: { compact: boolean }) => string | undefined;
  /** Declarative label source (input field name) for hosts that cannot call `label`. */
  labelKey?: string;
}

export type ToolPresentationResolver = (name: string) => ToolPresentation | undefined;

/** Host-facing, serializable projection of {@link ToolPresentation} (functions dropped). */
export interface ToolPresentationInfo {
  name: string;
  category?: ToolActivityCategory;
  keepRow?: boolean;
  detailed?: boolean;
  clientSide?: boolean;
  /** A result-text renderer exists for this tool. */
  hasText?: boolean;
  /** A header-summary renderer exists for this tool. */
  hasSummary?: boolean;
  labelKey?: string;
  /**
   * Whether the LIVE registration under this name is the tool the agent was seeded with
   * (`"builtin"`) or one an extension registered, including a shadow of a built-in name
   * (`"extension"`).
   *
   * A host's built-in-only renderer/classification must ask this rather than compare the name:
   * dispatch is by name, so both kinds carry the same name and only the registry knows which
   * implementation actually ran. Optional because a publisher that predates the field sends
   * nothing — hosts must treat that as "unknown", not as `"extension"`.
   */
  origin?: "builtin" | "extension";
}

/** Rendered presentation for one tool call, attached to that call's message part. */
export interface ToolDisplayPayload {
  text?: string;
  summary?: string;
  label?: string;
}

/** A tool-call part augmented with the core-rendered display payload. */
export type DisplayToolCallPart<T extends { type?: string } = { type?: string }> = T & {
  display?: ToolDisplayPayload;
};
