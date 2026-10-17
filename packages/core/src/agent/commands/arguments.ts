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
// /effort
// ============================================================================

/**
 * What `/effort <args>` asks for.
 *
 * `display` is UI state (the terminal footer's thinking line) that a headless host has no way to keep;
 * classifying it as an intent lets such a host say so instead of forwarding `display` as an effort
 * level to the model (`effort.set` accepted it, so the session recorded an unsupported value).
 */
export type EffortCommandIntent =
  | { kind: "display"; action: "on" | "off" | "toggle" | "status" }
  | { kind: "status" }
  | { kind: "clear" }
  | { kind: "set"; effort: ReasoningEffort }
  | { kind: "invalid"; value: string };

/** Parse `/effort` arguments into an intent. */
export function parseEffortCommand(rawArgs = ""): EffortCommandIntent {
  const value = rawArgs.trim().toLowerCase();

  switch (value) {
    case "":
    case "status":
      return { kind: "status" };
    case "display":
    case "display toggle":
      return { kind: "display", action: "toggle" };
    case "display on":
      return { kind: "display", action: "on" };
    case "display off":
      return { kind: "display", action: "off" };
    case "display?":
      return { kind: "display", action: "status" };
    case "off":
      return { kind: "clear" };
    default:
      return isReasoningEffort(value) ? { kind: "set", effort: value } : { kind: "invalid", value };
  }
}
