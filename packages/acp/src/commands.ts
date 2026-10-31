/**
 * Slash-command handling for the ACP host.
 *
 * ACP has no explicit "invoke command" method: a client sends `/name args` as an
 * ordinary prompt. We parse that, dispatch the matching `AgentSessionCommand`
 * (built-in) or `extension.invokeCommand` (extension), and return any text the
 * command produced.
 */

import {
  encodeModelChoice,
  findBuiltinCommand,
  listAdvertisableCommands,
  parseModeCommand,
  parseModelsCommand,
  parseUsageCommand,
  resolveSessionRef,
  errorMessage,
} from "@codent/core";

import { applyModel, applyThoughtLevel, THOUGHT_LEVEL_DEFAULT } from "./session-config-options.js";
import { formatUsageReport } from "./usage-report.js";

import type { ModelSwitchOutcome } from "./session-config-options.js";
import type { AcpCommands } from "./types.js";
import type { UsageHistoryPayload } from "./usage-report.js";
import type { AgentSession, AgentSessionSnapshot, ModelCatalogRead } from "@codent/core";

/**
 * Advertizable command set: built-ins (non-UI) + the session's extension commands.
 *
 * Reads `extensions.commands` — the LIVE registration per name — never a flatten of
 * `extensions[].commands`, which is each extension's own claim (management view): two extensions
 * may claim one name, and the shadowed copy can never run, so advertising it offers a command that
 * does nothing. A name a built-in wins is dropped too, because dispatch resolves built-ins first.
 */
export function commandsFromSnapshot(snapshot: AgentSessionSnapshot): AcpCommands {
  const extension = snapshot.extensions.commands
    .filter((cmd) => !findBuiltinCommand(cmd.name))
    .map((cmd) => ({ name: cmd.name, description: cmd.description || "" }));
  return { builtin: listAdvertisableCommands(), extension };
}

export interface ParsedCommand {
  name: string;
  args: string[];
  raw: string;
}

/** Parse a leading `/name args` from prompt text. Returns null when it is not a command. */
export function parseSlashCommand(text: string): ParsedCommand | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) return null;
  const body = trimmed.slice(1);
  const match = /^([a-zA-Z][\w-]*)(?:\s+([\s\S]*))?$/.exec(body);
  if (!match) return null;
  const name = match[1]!;
  const raw = match[2] ?? "";
  const args = raw.trim().length > 0 ? raw.trim().split(/\s+/) : [];
  return { name, args, raw };
}

export interface SlashResult {
  handled: boolean;
  /** Text the command produced (for the client), if any. */
  message?: string;
  /** A manual compaction's outcome, so the projector can close its row with the truth. */
  compact?: { ok: boolean; error?: string };
  /** The catalog entry a model switch landed on, so the host records the connection. */
  entryIndex?: number;
}

/**
 * Dispatch a parsed slash command. A built-in token is reserved (extension
 * commands are only reachable when no built-in matches).
 */
export async function dispatchSlashCommand(
  session: AgentSession,
  snapshot: AgentSessionSnapshot,
  parsed: ParsedCommand,
  read?: ModelCatalogRead,
  currentEntryIndex?: number
): Promise<SlashResult> {
  const entry = findBuiltinCommand(parsed.name);

  if (!entry) {
    // The live set, not the claims: a shadowed name is not reachable, and `extension.invokeCommand`
    // resolves it against the same per-name list.
    const extensionNames = new Set(snapshot.extensions.commands.map((c) => c.name));
    if (extensionNames.has(parsed.name)) {
      const result = await session.dispatch({ type: "extension.invokeCommand", name: parsed.name, args: parsed.args });
      return { handled: true, message: result.ok ? result.data?.message : undefined };
    }
    return { handled: false };
  }

  // Dispatch on the catalog's `command` (the AgentSessionCommand a built-in maps to), so
  // the host never restates a command name — the catalog is the single source.
  //
  // Every handled branch MUST produce a message (or an error that does). ACP has no panel: the
  // chunk this returns is the only thing the client can show, so `handled: true` with no text is a
  // command that does nothing from the user's side — which is what `/usage`, `/rename`, `/new`,
  // `/resume` and `/clone` all did, because their session commands return structured data
  // (`{ sessionId }`, `{ name }`, the usage aggregate) rather than prose.
  switch (entry.command) {
    case "session.new": {
      const result = await session.dispatch({ type: "session.new" });
      if (!result.ok) return finish(result);
      const sessionId = (result.data as { sessionId?: string } | undefined)?.sessionId;
      return { handled: true, message: sessionId ? `Started a new session (${sessionId})` : "Started a new session" };
    }
    case "compact": {
      const result = await session.dispatch({ type: "compact", focus: parsed.raw || undefined });
      return {
        ...finish(result),
        // The summary stream's `end` always fires (core closes it in `finally`) and cannot tell a
        // failed manual compaction from a successful one; the command result is authoritative.
        compact: { ok: result.ok, ...(result.ok ? {} : { error: result.error ?? "compaction failed" }) },
      };
    }
    case "rename": {
      const result = parsed.raw
        ? await session.dispatch({ type: "rename", name: parsed.raw })
        : await session.dispatch({ type: "rename.generate" });
      if (!result.ok) return finish(result);
      const name = (result.data as { name?: string } | undefined)?.name;
      return { handled: true, message: name ? `Renamed this session to "${name}"` : "Renamed this session" };
    }
    case "session.resume": {
      const query = parsed.raw.trim();
      if (!query) return { handled: true, message: "Usage: /resume <session-id or name>" };
      const listed = await session.dispatch({ type: "session.list" });
      if (!listed.ok) return finish(listed);
      const sessions = listed.data?.sessions ?? [];
      // `/resume <name>` is what the catalog advertises; resolving the query is core's rule
      // (`resolveSessionRef`), not this host's, so the id-vs-name grammar cannot drift.
      const match = resolveSessionRef(sessions, query);
      if (!match) return { handled: true, message: `No session found matching "${query}"` };
      const resumed = await session.dispatch({ type: "session.resume", sessionId: match.id });
      if (!resumed.ok) return finish(resumed);
      // The dispatch answers with the restored conversation (`{ sessionId, name, model, uiMessages }`),
      // not with text: report which session the client is now looking at.
      const restored = resumed.data as { sessionId?: string; name?: string } | undefined;
      const sessionId = restored?.sessionId ?? match.id;
      const label = restored?.name ? `"${restored.name}" ` : "";
      return { handled: true, message: `Resumed ${label}(${sessionId})` };
    }
    case "session.clone": {
      const cloned = await session.dispatch({ type: "session.clone", ...(parsed.raw ? { name: parsed.raw } : {}) });
      // It used to report `handled: true` whatever the dispatch said, so a failed clone looked like a
      // successful one with no output.
      if (!cloned.ok) return finish(cloned);
      const branch = cloned.data as { sessionId?: string; name?: string } | undefined;
      const label = branch?.name ? `"${branch.name}"` : "a new session";
      return {
        handled: true,
        message: `Cloned this session into ${label}${branch?.sessionId ? ` (${branch.sessionId})` : ""}`,
      };
    }
    case "mode.set":
      return dispatchModeCommand(session, parsed.raw);
    case "model.set":
      return dispatchModelsCommand(session, parsed.raw, read, currentEntryIndex);
    case "usage.history": {
      const intent = parseUsageCommand(parsed.raw);
      if (intent.kind === "invalid") {
        return { handled: true, message: `Unknown /usage argument "${intent.value}". Usage: /usage [Nw]` };
      }
      const history = await session.dispatch({
        type: "usage.history",
        ...(intent.weeks !== undefined ? { weeks: intent.weeks } : {}),
      });
      if (!history.ok) return finish(history);
      // `usage.history` answers with the raw aggregate (weeks/daily/models) for a panel to draw; a text
      // client gets the same numbers as a report. Before this, `/usage` returned no text at all — and
      // `[Nw]` was never even sent to the command.
      return {
        handled: true,
        message: formatUsageReport(session.getSnapshot().usage, history.data as UsageHistoryPayload | undefined),
      };
    }
    default: {
      // A built-in this client cannot dispatch: either its scope is `ui` (`/help`, `/settings`, `/quit`
      // — a panel, a keybinding, a process exit) or it has no session command here. It used to report
      // `handled: false`, which fell through to `send` and turned the line into a PROMPT — typing a
      // host command in a client that lacks it looked like the agent choosing to answer a question.
      const available = listAdvertisableCommands()
        .map((command) => `/${command.name}`)
        .join(", ");
      return {
        handled: true,
        message: `/${entry.name} is not available in this client. Available: ${available}`,
      };
    }
  }
}

function finish(result: { ok: boolean; data?: unknown; error?: string }): SlashResult {
  if (!result.ok) return { handled: true, message: result.error ?? "command failed" };
  const data = result.data as { message?: string } | undefined;
  return { handled: true, message: data?.message };
}

const MODE_USAGE =
  "Usage: /mode [plan|auto|off|switch plan|switch auto|status|execute|done|cancel|save [name]|load <name>|list]";

/**
 * `/mode <args>` — the grammar is core's ({@link parseModeCommand}), so this host and the TUI dispatch
 * the same intent. It used to recognise only `plan|auto|off` and treat everything else as a toggle,
 * which made the advertised `/mode execute|done|cancel|status|save|load|list` flip the mode instead.
 */
async function dispatchModeCommand(session: AgentSession, rawArgs: string): Promise<SlashResult> {
  const intent = parseModeCommand(rawArgs);
  if (!intent) return { handled: true, message: MODE_USAGE };

  switch (intent.kind) {
    case "set":
      await session.dispatch({ type: "mode.set", mode: intent.mode });
      return { handled: true };
    case "toggle":
      await session.dispatch({ type: "mode.toggle" });
      return { handled: true };
    case "status":
      return { handled: true, message: modeStatusLine(session.getSnapshot()) };
    case "execute": {
      const result = await session.dispatch({ type: "plan.execute" });
      if (!result.ok) return finish(result);
      const data = result.data;
      return {
        handled: true,
        message: data?.queued ? "Plan queued — starts after the current run finishes" : "Building approved plan…",
      };
    }
    case "done": {
      const result = await session.dispatch({ type: "plan.complete" });
      return result.ok ? { handled: true, message: "Plan complete — plan mode off" } : finish(result);
    }
    case "cancel": {
      const result = await session.dispatch({ type: "plan.cancel" });
      return result.ok ? { handled: true, message: "Building paused — back to review" } : finish(result);
    }
    case "save": {
      const result = await session.dispatch({ type: "plan.save", nameHint: intent.name });
      if (!result.ok) return finish(result);
      const path = result.data?.path;
      return { handled: true, message: `Plan saved to ${path ?? "workspace"}` };
    }
    case "load": {
      const result = await session.dispatch({ type: "plan.load", name: intent.name });
      if (!result.ok) return finish(result);
      const data = result.data;
      return {
        handled: true,
        message: `Loaded ${data?.path ?? intent.name} (${data?.stepCount ?? 0} steps) — review, then /mode execute`,
      };
    }
    case "list": {
      const result = await session.dispatch({ type: "plan.list" });
      if (!result.ok) return finish(result);
      const files = result.data?.files ?? [];
      return {
        handled: true,
        message: files.length > 0 ? `Saved plans:\n${files.map((file) => `- ${file}`).join("\n")}` : "No saved plans",
      };
    }
    default:
      return { handled: true, message: MODE_USAGE };
  }
}

/**
 * `/models <args>` — core's grammar, one command for the model AND its thinking depth.
 *
 * The write goes through {@link applyModel}, the same function `session/set_config_option` uses, so
 * the slash command and the client's model selector cannot drift. Depth is applied through
 * `effort.set` and only after the switch, because the level is validated against the NEW model's
 * advertisement — the current model's list says nothing about the one being switched to.
 */
async function dispatchModelsCommand(
  session: AgentSession,
  rawArgs: string,
  read: ModelCatalogRead | undefined,
  currentEntryIndex?: number
): Promise<SlashResult> {
  const intent = parseModelsCommand(rawArgs);

  if (intent.kind === "invalid") {
    return {
      handled: true,
      message:
        `Unknown /models argument "${intent.value}". ` +
        `Usage: /models [entryIndex:modelId [effort|off]] (no argument lists the entries)`,
    };
  }
  if (intent.kind === "list") {
    const entries = read?.entries ?? [];
    if (entries.length === 0) return { handled: true, message: "No models are configured" };
    const lines = entries.map(
      (entry, index) => `${index}: ${entry.style}@${entry.baseURL} — ${entry.models.join(", ") || "(no models)"}`
    );
    return { handled: true, message: `Models:\n${lines.join("\n")}` };
  }

  // A bare id names no entry, so it is resolved against the catalog the same way the TUI's menu
  // does — `applyModel` only accepts a bare value that is already the session's model (that is how a
  // current model missing from the catalog is advertised). Without this, `/models <id>` fails with
  // "Unknown model" even when the id is right there in the catalog.
  const value =
    intent.entryIndex !== undefined
      ? encodeModelChoice(intent.entryIndex, intent.model)
      : resolveBareModel(intent.model, read);

  let applied: ModelSwitchOutcome;
  try {
    applied = await applyModel({ session, acpId: session.id }, value, read, currentEntryIndex);
  } catch (error) {
    return { handled: true, message: errorMessage(error) };
  }

  const switched = applied.snapshot.model ?? intent.model;
  const entry = applied.entryIndex !== undefined ? { entryIndex: applied.entryIndex } : {};
  if (intent.effort === undefined && intent.clearEffort !== true) {
    return { handled: true, message: `Switched to ${switched}`, ...entry };
  }

  // Depth goes through the ONE write path (`applyThoughtLevel`) — the same function the
  // `thought_level` selector calls. It validates against the metadata the switch just installed and
  // clears the effort for the `off` marker, so the two routes cannot disagree about either.
  const level = intent.clearEffort ? THOUGHT_LEVEL_DEFAULT : intent.effort!;
  try {
    await applyThoughtLevel({ session, acpId: session.id }, level);
  } catch (error) {
    return {
      handled: true,
      message: `Switched to ${switched}, but ${errorMessage(error)}`,
      ...entry,
    };
  }
  return {
    handled: true,
    message: `Switched to ${switched}, thinking: ${level === THOUGHT_LEVEL_DEFAULT ? "model default" : level}`,
    ...entry,
  };
}

/** A bare model id → the catalog's encoded choice; unchanged when no entry lists it. */
function resolveBareModel(model: string, read: ModelCatalogRead | undefined): string {
  const index = read?.entries.findIndex((entry) => entry.models.includes(model)) ?? -1;
  return index >= 0 ? encodeModelChoice(index, model) : model;
}

/** One line for `/mode status`; the plan phase is what a client cannot infer. */
function modeStatusLine(snapshot: AgentSessionSnapshot): string {
  if (snapshot.plan.phase !== "off") {
    const phase =
      snapshot.plan.phase === "ready"
        ? "review"
        : snapshot.plan.phase === "executing"
          ? "building"
          : snapshot.plan.phase;
    const steps = snapshot.plan.steps.length > 0 ? ` — ${snapshot.plan.steps.length} steps` : "";
    return `Mode: plan (${phase})${steps}`;
  }
  return snapshot.autoMode
    ? "Mode: auto — tools run without approval"
    : "Mode: normal — tools require approval when configured";
}
