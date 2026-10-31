/**
 * Builtin command ARGUMENT grammar — the one definition of what a command's arguments mean.
 *
 * `BUILTIN_COMMAND_CATALOG` says which commands exist; this module says what their arguments dispatch.
 * Both are core rather than host concerns, because the same advertised command must mean the same
 * thing everywhere. It did not: the TUI's `/mode` understood `execute|done|cancel|status|save|load|list`
 * while the ACP slash handler mapped every one of them to `mode.toggle` (it only recognised
 * `plan|auto|off`), so a client that advertised the documented usage silently toggled the mode instead
 * of building the plan. The grammar was simply living in one host.
 *
 * These are **intents**, not commands: an intent is the argument's meaning, and each host maps it to the
 * `AgentSessionCommand` it dispatches plus whatever text it wants to show. Dispatch stays host-visible
 * (ACP dispatches directly, the TUI goes through its command registry), and no message text lives here.
 */

import { isReasoningEffort, type ReasoningEffort } from "../../models/types.js";

import type { AgentMode } from "../../runtime-types/session-payloads.js";

// ============================================================================
// /mode
// ============================================================================

/**
 * What `/mode <args>` asks for.
 *
 * - `set` / `toggle` — mode changes (`normal` / `auto` / `plan`), including `/mode switch <mode>`.
 * - `status` — report the current mode/phase.
 * - `execute` / `done` / `cancel` — plan lifecycle (`plan.execute` / `plan.complete` / `plan.cancel`).
 * - `save` / `load` / `list` — named plan persistence (the name is the remainder of the line,
 *   case preserved).
 */
export type ModeCommandIntent =
  | { kind: "set"; mode: AgentMode }
  | { kind: "toggle" }
  | { kind: "status" }
  | { kind: "execute" }
  | { kind: "done" }
  | { kind: "cancel" }
  | { kind: "save"; name?: string }
  | { kind: "load"; name: string }
  | { kind: "list" };

/**
 * Parse `/mode` arguments into an intent.
 *
 * @returns `undefined` when the head is not a known subcommand (or `load` has no name) — the host
 *   reports its own usage error, since the wording belongs to the surface.
 */
export function parseModeCommand(rawArgs = ""): ModeCommandIntent | undefined {
  const tokens = rawArgs.trim().split(/\s+/).filter(Boolean);
  const head = (tokens[0] ?? "").toLowerCase();
  const second = (tokens[1] ?? "").toLowerCase();
  // Names keep the user's spelling: `save My Plan` must not become `my plan`.
  const rest = tokens.slice(1).join(" ").trim();

  switch (head) {
    case "":
    case "toggle":
      return { kind: "toggle" };
    case "plan":
      return { kind: "set", mode: second === "off" ? "normal" : "plan" };
    case "auto":
      return { kind: "set", mode: second === "off" ? "normal" : "auto" };
    case "switch":
      if (second === "plan") return { kind: "set", mode: "plan" };
      if (second === "auto") return { kind: "set", mode: "auto" };
      return undefined;
    case "off":
    case "normal":
      return { kind: "set", mode: "normal" };
    case "status":
      return { kind: "status" };
    case "execute":
    case "run":
    case "build":
      return { kind: "execute" };
    case "done":
    case "complete":
      return { kind: "done" };
    case "cancel":
      return { kind: "cancel" };
    case "save":
      return { kind: "save", ...(rest ? { name: rest } : {}) };
    case "load":
      return rest ? { kind: "load", name: rest } : undefined;
    case "list":
      return { kind: "list" };
    default:
      return undefined;
  }
}

// ============================================================================
// /models
// ============================================================================

/**
 * What `/models <args>` asks for.
 *
 * One command switches the model **and** its thinking depth (`/models` used to be accompanied by a
 * separate `/effort`, which meant the same decision was made in two places and a level could survive a
 * model switch that does not accept it). The model argument is `"<entryIndex>:<model>"` — the encoding
 * `@codent/app`'s menu and ACP's `category: "model"` option both use — or a bare model id, which the
 * host resolves against the loaded entries.
 *
 * A second argument is an effort level (`high` …) or `off` (explicitly back to the model default):
 *
 * ```text
 * /models                 → list the entries and their models
 * /models 0:gpt-5.1       → switch the model (effort untouched)
 * /models 0:gpt-5.1 high  → switch the model, then set its reasoning effort
 * /models 0:gpt-5.1 off   → switch the model, then clear the effort
 * ```
 */
export type ModelsCommandIntent =
  | { kind: "list" }
  | { kind: "invalid"; value: string }
  | {
      kind: "set";
      model: string;
      /** Absent when the argument was a bare model id — the host resolves the entry. */
      entryIndex?: number;
      /** Effort to apply after the switch. */
      effort?: ReasoningEffort;
      /** `off`: clear the effort (back to the model default) after the switch. */
      clearEffort?: boolean;
    };

/**
 * The wire form of a model choice: `"<entryIndex>:<model>"`.
 *
 * Encodes the ENTRY, not just the model, because a model id is only unique within an entry and
 * switching a model can also switch the connection. This is a **protocol value**, not a display
 * detail: the TUI's `/models` menu, ACP's `category: "model"` option, and `parseModelsCommand`'s
 * argument all use it, so the encode/decode pair lives here — one definition, next to the parser that
 * consumes it. Three private copies (one per host) is how the two hosts would drift on a format that
 * has to round-trip between them.
 */
export function encodeModelChoice(entryIndex: number, model: string): string {
  return `${entryIndex}:${model}`;
}

/**
 * Split a model choice back into its entry index and model id, or `undefined` when `value` is not in
 * the encoded form (a bare model id names no entry — the host resolves it by search).
 *
 * Splits on the FIRST colon: the entry index never contains one while a model id may (`a:b`).
 */
export function decodeModelChoice(value: string): { entryIndex: number; model: string } | undefined {
  const separator = value.indexOf(":");
  if (separator <= 0) return undefined;
  const entryIndex = Number(value.slice(0, separator));
  const model = value.slice(separator + 1);
  if (!Number.isInteger(entryIndex) || entryIndex < 0 || !model) return undefined;
  return { entryIndex, model };
}

/** Parse `/models` arguments into an intent. */
export function parseModelsCommand(rawArgs = ""): ModelsCommandIntent {
  const tokens = rawArgs.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return { kind: "list" };
  if (tokens.length > 2) return { kind: "invalid", value: rawArgs.trim() };

  const [head, tail] = tokens as [string, string?];
  const decoded = decodeModelChoice(head);
  // A token carrying a separator MUST be a valid encoding: `"0:"` is a malformed choice. A bare id
  // that itself contains a colon (`vendor/model:free`) is therefore not accepted unencoded — the
  // encoded form (`0:vendor/model:free`) is, and that is what every host's menu emits.
  if (head.includes(":") && !decoded) return { kind: "invalid", value: head };
  // A bare token is a model id the host resolves against its own entries.
  const entryIndex = decoded?.entryIndex;
  const model = decoded?.model ?? head;
  if (!model) return { kind: "invalid", value: head };

  if (tail === undefined) {
    return { kind: "set", model, ...(entryIndex !== undefined ? { entryIndex } : {}) };
  }
  const effort = tail.toLowerCase();
  if (effort === "off") {
    return { kind: "set", model, ...(entryIndex !== undefined ? { entryIndex } : {}), clearEffort: true };
  }
  if (!isReasoningEffort(effort)) return { kind: "invalid", value: `${head} ${tail}` };
  return { kind: "set", model, ...(entryIndex !== undefined ? { entryIndex } : {}), effort };
}

// ============================================================================
// /usage
// ============================================================================

/**
 * Longest span `/usage` may ask for.
 *
 * One year: the history store is written per year and a weekly graph spanning longer than that
 * draws columns nobody can read. The clamp sits in the grammar so no host can widen it.
 */
export const USAGE_HISTORY_MAX_WEEKS = 52;

/**
 * What `/usage <args>` asks for: a report over the last `weeks` weeks.
 *
 * `weeks` is omitted when the argument named none — the span is then the SURFACE's default (the TUI
 * sizes the heatmap to the terminal width, a headless host has no width to consult). No message text
 * here, same as the other intents.
 */
export type UsageCommandIntent = { kind: "history"; weeks?: number } | { kind: "invalid"; value: string };

/**
 * Parse `/usage [Nw]` into an intent.
 *
 * `4w` is the documented form; `4week` / `4weeks` read the same. A span outside 1…{@link
 * USAGE_HISTORY_MAX_WEEKS} is clamped rather than rejected, because "the last 0 weeks" and "the last
 * 300 weeks" are both a span the user meant, just out of range.
 */
export function parseUsageCommand(rawArgs = ""): UsageCommandIntent {
  const raw = rawArgs.trim();
  if (raw === "") return { kind: "history" };
  const match = /^(\d+)\s*(?:w|weeks?)$/i.exec(raw);
  if (!match) return { kind: "invalid", value: raw };
  const weeks = Number(match[1]);
  if (!Number.isFinite(weeks)) return { kind: "invalid", value: raw };
  return { kind: "history", weeks: Math.min(USAGE_HISTORY_MAX_WEEKS, Math.max(1, weeks)) };
}
