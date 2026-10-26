/**
 * Extension UI payload types: the generic render tree, the context snapshot and the UI facade.
 *
 * Split out of `types.ts`, which is at the 800-line ceiling: these are one closed subject (what an
 * extension may draw and read), and nothing here depends on the registration or context types.
 *
 * Payloads cross process boundaries (core → host, including remote servers), so every node stays
 * plain JSON-serializable data — never functions or components.
 */

/**
 * One node of the generic layout tree an extension may render into a host
 * surface.
 *
 * Deliberately a *closed* set of layout primitives — `text` / `row` / `column` /
 * `box` — carrying no domain semantics (no progress bar, label, table, …). An
 * extension needing something richer composes it from these primitives, or
 * publishes a raw ANSI string payload instead.
 *
 * Payloads cross process boundaries (core → host, including remote servers), so
 * nodes MUST stay plain JSON-serializable data — never functions or components.
 */
export type ExtensionRenderNode =
  | {
      type: "text";
      /** Text content; MAY contain ANSI SGR styling escape sequences. */
      value: string;
    }
  | {
      type: "row";
      /** Blank columns between children. */
      gap?: number;
      children: readonly ExtensionRenderNode[];
    }
  | {
      type: "column";
      gap?: number;
      children: readonly ExtensionRenderNode[];
    }
  | {
      type: "box";
      /** Draw a border around the children. */
      border?: boolean;
      /** Horizontal padding, in cells. */
      padding?: number;
      children: readonly ExtensionRenderNode[];
    };

/**
 * What an extension can publish into a surface: free-form raw text (ANSI and
 * line breaks preserved verbatim) or a generic layout tree.
 */
export type ExtensionRenderPayload = string | ExtensionRenderNode;

/** Model identity exposed to extensions for data-driven rendering. */
export interface ExtensionUiModel {
  /** Active model id. */
  id: string;
  /** Human-readable model name (falls back to {@link ExtensionUiModel.id}). */
  displayName: string;
}

/** Token / cost usage exposed to extensions. */
export interface ExtensionUiUsage {
  /**
   * Fill against the compaction budget, 0 upward — NOT clamped at 100: the budget is
   * `min(contextWindow, 400k)` and the auto-compact trigger sits at `compactAtPercent` of it (80 by
   * default), so a value above 100 means the trigger did not fire. A renderer that wants a 0-100 bar
   * clamps for itself.
   */
  percent: number;
  /** The compaction budget the percentage is against (`min(contextWindow, 400k)`), not the model's window. */
  tokenLimit: number;
  /** Tokens currently occupying the context window. */
  windowTokens: number;
  /** Cumulative session cost in USD. */
  costUsd: number;
}

/**
 * Live session snapshot an extension can read to render data-driven content.
 * Pushed to subscribers as a `context` notification when relevant state
 * changes, and readable on demand via {@link ExtensionUI.getContext}.
 */
export interface ExtensionUiContext {
  model: ExtensionUiModel | null;
  /** Agent status (`idle` / `running` / `thinking` / …). */
  status: string;
  usage: ExtensionUiUsage | null;
  workspace: { root: string; branch: string | null };
  /** Session name/title, when the host knows one. */
  sessionName: string | null;
  /** Derived agent mode (`normal` / `auto` / `plan`). */
  mode: string | null;
}

/** Severity of a host notification published via {@link ExtensionUI.notify}. */
export type ExtensionNotificationLevel = "success" | "info" | "error";

export interface ExtensionUI {
  /**
   * Publish a **transient** notification to the host (the CLI renders it in its
   * input feedback line, which clears itself). Use {@link render} instead for
   * content that should persist in a surface slot.
   */
  notify(message: string, level?: ExtensionNotificationLevel): void;
  subscribe<T = unknown>(type: string, handler: (data: T) => void): () => void;
  /**
   * Render `payload` into a host surface slot.
   *
   * `surface` names the host region (currently `"footer"`); `key` scopes the
   * slot so extensions never overwrite one another. Passing `null` (or an empty
   * raw string) removes the slot. Slots are attributed to the calling extension
   * and cleared when it is disabled or destroyed.
   */
  render(surface: string, key: string, payload: ExtensionRenderPayload | null): void;
  /**
   * Current UI context snapshot (model / status / usage / workspace / session /
   * mode). Subscribe to the `context` notification to be pushed on changes
   * instead of polling.
   */
  getContext(): ExtensionUiContext;
}
