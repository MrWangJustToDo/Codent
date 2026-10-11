/**
 * Slash-command handling for the ACP host.
 *
 * ACP has no explicit "invoke command" method: a client sends `/name args` as an
 * ordinary prompt. We parse that, dispatch the matching `AgentSessionCommand`
 * (built-in) or `extension.invokeCommand` (extension), and return any text the
 * command produced.
 */

import { findBuiltinCommand, listAdvertisableCommands } from "@codent/core";

import type { AcpCommands } from "./types.js";
import type { AgentSession, AgentSessionSnapshot } from "@codent/core";

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
}

/**
 * Dispatch a parsed slash command. A built-in token is reserved (extension
 * commands are only reachable when no built-in matches).
 */
export async function dispatchSlashCommand(
  session: AgentSession,
  snapshot: AgentSessionSnapshot,
  parsed: ParsedCommand
): Promise<SlashResult> {
  const extensionNames = new Set(snapshot.extensions.extensions.flatMap((e) => e.commands.map((c) => c.name)));

  if (!findBuiltinCommand(parsed.name) && extensionNames.has(parsed.name)) {
    const result = await session.dispatch({ type: "extension.invokeCommand", name: parsed.name, args: parsed.args });
    const data = result.ok ? (result.data as { message?: string } | undefined) : undefined;
    return { handled: true, message: data?.message };
  }

  switch (parsed.name) {
    case "clear":
      await session.dispatch({ type: "session.new" });
      return { handled: true };
    case "compact":
      return finish(await session.dispatch({ type: "compact", focus: parsed.raw || undefined }));
    case "rename": {
      const result = parsed.raw
        ? await session.dispatch({ type: "rename", name: parsed.raw })
        : await session.dispatch({ type: "rename.generate" });
      return finish(result);
    }
    case "resume": {
      if (!parsed.args[0]) return { handled: true, message: "Usage: /resume <session-id>" };
      return finish(await session.dispatch({ type: "session.resume", sessionId: parsed.args[0] }));
    }
    case "clone":
      await session.dispatch({ type: "session.clone", ...(parsed.raw ? { name: parsed.raw } : {}) });
      return { handled: true };
    case "mode": {
      const mode = mapModeArg(parsed.args[0]);
      if (mode === "toggle") await session.dispatch({ type: "mode.toggle" });
      else await session.dispatch({ type: "mode.set", mode });
      return { handled: true };
    }
    case "effort": {
      const effort = parsed.args[0] === "off" ? undefined : (parsed.args[0] as never);
      await session.dispatch({ type: "effort.set", effort });
      return { handled: true };
    }
    case "usage":
      return finish(await session.dispatch({ type: "usage.history" }));
    default:
      return { handled: false };
  }
}

function finish(result: { ok: boolean; data?: unknown; error?: string }): SlashResult {
  if (!result.ok) return { handled: true, message: result.error ?? "command failed" };
  const data = result.data as { message?: string } | undefined;
  return { handled: true, message: data?.message };
}

function mapModeArg(arg: string | undefined): "normal" | "auto" | "plan" | "toggle" {
  if (arg === "plan") return "plan";
  if (arg === "auto") return "auto";
  if (arg === "off" || arg === "normal") return "normal";
  return "toggle";
}
