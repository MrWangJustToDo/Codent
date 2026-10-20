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
  resolveSessionRef,
} from "@codent/core";

import { applyModel, applyThoughtLevel, THOUGHT_LEVEL_DEFAULT } from "./session-config-options.js";

import type { ModelSwitchOutcome } from "./session-config-options.js";
import type { AcpCommands } from "./types.js";
import type { AgentSession, AgentSessionSnapshot, ModelCatalogRead } from "@codent/core";

/** Advertizable command set: built-ins (non-UI) + the session's extension commands. */
export function commandsFromSnapshot(snapshot: AgentSessionSnapshot): AcpCommands {
  const extension: Array<{ name: string; description: string }> = [];
  for (const ext of snapshot.extensions.extensions) {
    for (const cmd of ext.commands) {
      if (cmd.name) extension.push({ name: cmd.name, description: cmd.description || "" });
    }
  }
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
    const extensionNames = new Set(snapshot.extensions.extensions.flatMap((e) => e.commands.map((c) => c.name)));
    if (extensionNames.has(parsed.name)) {
      const result = await session.dispatch({ type: "extension.invokeCommand", name: parsed.name, args: parsed.args });
      const data = result.ok ? (result.data as { message?: string } | undefined) : undefined;
      return { handled: true, message: data?.message };
    }
    return { handled: false };
  }

  // Dispatch on the catalog's `command` (the AgentSessionCommand a built-in maps to), so
  // the host never restates a command name — the catalog is the single source.
  switch (entry.command) {
    case "session.new":
      await session.dispatch({ type: "session.new" });
      return { handled: true };
    case "compact": {
      const result = await session.dispatch({ type: "compact", focus: parsed.raw || undefined });
      return {
        ...finish(result),
        // The summary stream's `end` always fires (core closes it in `finally`) and cannot tell a
        // failed manual compaction from a successful one; the command result is authoritative.
        compact: { ok: result.ok, ...(result.ok ? {} : { error: result.error ?? "compaction failed" }) },
      };
    }
    case "rename":
      return finish(
        parsed.raw
          ? await session.dispatch({ type: "rename", name: parsed.raw })
          : await session.dispatch({ type: "rename.generate" })
      );
    case "session.resume": {
      const query = parsed.raw.trim();
      if (!query) return { handled: true, message: "Usage: /resume <session-id or name>" };
      const listed = await session.dispatch({ type: "session.list" });
      if (!listed.ok) return finish(listed);
      const sessions = (listed.data as { sessions?: Array<{ id: string; name: string }> } | undefined)?.sessions ?? [];
      // `/resume <name>` is what the catalog advertises; resolving the query is core's rule
      // (`resolveSessionRef`), not this host's, so the id-vs-name grammar cannot drift.
      const match = resolveSessionRef(sessions, query);
      if (!match) return { handled: true, message: `No session found matching "${query}"` };
      return finish(await session.dispatch({ type: "session.resume", sessionId: match.id }));
    }
    case "session.clone":
      await session.dispatch({ type: "session.clone", ...(parsed.raw ? { name: parsed.raw } : {}) });
      return { handled: true };
    case "mode.set":
      return dispatchModeCommand(session, parsed.raw);
    case "model.set":
      return dispatchModelsCommand(session, parsed.raw, read, currentEntryIndex);
    case "usage.history":
      return finish(await session.dispatch({ type: "usage.history" }));
    default:
      // A built-in token with no session command is UI-only; the host does not dispatch it.
      return { handled: false };
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
      const data = result.data as { queued?: boolean } | undefined;
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
      const path = (result.data as { path?: string } | undefined)?.path;
      return { handled: true, message: `Plan saved to ${path ?? "workspace"}` };
    }
    case "load": {
      const result = await session.dispatch({ type: "plan.load", name: intent.name });
      if (!result.ok) return finish(result);
      const data = result.data as { path?: string; stepCount?: number } | undefined;
      return {
        handled: true,
        message: `Loaded ${data?.path ?? intent.name} (${data?.stepCount ?? 0} steps) — review, then /mode execute`,
      };
    }
    case "list": {
      const result = await session.dispatch({ type: "plan.list" });
      if (!result.ok) return finish(result);
      const files = (result.data as { files?: string[] } | undefined)?.files ?? [];
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
    return { handled: true, message: error instanceof Error ? error.message : String(error) };
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
      message: `Switched to ${switched}, but ${error instanceof Error ? error.message : String(error)}`,
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
