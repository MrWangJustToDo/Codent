import { parseModeCommand } from "@codent/core";

import { getActiveSession } from "../utils/session-resolve.js";

import { registerBuiltinCommand } from "./utils/registry.js";

import type { CommandOption, CommandResult } from "./utils/types.js";
import type { AgentMode, AgentSession } from "@codent/core";

const PLAN_LOAD_LIMIT = 15;

const MODE_USAGE =
  "Usage: /mode | /mode plan | /mode auto | /mode off | /mode status | /mode execute | /mode done | /mode cancel | /mode save [name] | /mode load <name> | /mode list";

/** `/mode status` — composed from the session snapshot, so it never reports a stale mode. */
function formatModeStatus(session: AgentSession): CommandResult {
  const snapshot = session.getSnapshot();
  const mode: AgentMode = snapshot.mode;

  if (mode === "plan") {
    const state = snapshot.plan;
    const todos = snapshot.todos ?? [];
    let completed = 0;
    for (const item of todos) if (item.status === "completed") completed += 1;
    const displayPhase =
      state.phase === "ready"
        ? "review"
        : state.phase === "executing"
          ? "building"
          : state.phase === "planning"
            ? "planning"
            : state.phase;
    const progress =
      state.phase === "executing" && todos.length > 0
        ? ` (${completed}/${todos.length} todos)`
        : state.steps.length > 0
          ? ` (${state.steps.length} steps)`
          : "";
    const path = state.planFilePath ? ` · ${state.planFilePath}` : "";
    const preserved =
      state.preservedExistingTodos && state.phase === "ready"
        ? " — existing todos kept; /mode execute will replace them"
        : "";
    const next =
      state.phase === "ready"
        ? " — run /mode execute to Build"
        : state.phase === "executing"
          ? " — /mode cancel to pause"
          : state.phase === "retro"
            ? " — complete_plan or /mode done"
            : state.phase === "planning"
              ? " — explore with task/read tools, then create_plan (or ## Plan)"
              : "";
    return { ok: true, message: `Mode: plan (${displayPhase})${progress}${path}${preserved}${next}` };
  }

  if (mode === "auto") return { ok: true, message: "Mode: auto — tools run without approval" };
  return { ok: true, message: "Mode: normal — tools require approval when configured" };
}

registerBuiltinCommand("mode", {
  immediate: false,
  getOptions: async (): Promise<CommandOption[]> => {
    const session = getActiveSession();
    const snap = session?.getSnapshot();
    const mode: AgentMode = snap?.mode ?? "normal";

    if (mode === "normal") {
      return [
        { label: "auto", value: "auto", description: "Enable auto mode — skip tool approvals (YOLO)" },
        {
          label: "plan",
          value: "plan",
          description: "Enter plan mode — explore read-only before building",
          defaultSelected: true,
        },
      ];
    }

    if (mode === "auto") {
      return [
        { label: "off", value: "off", description: "Disable auto mode — back to normal", defaultSelected: true },
        { label: "switch plan", value: "switch plan", description: "Switch to plan mode" },
      ];
    }

    // plan mode — mode switching + remaining plan operations (phase-filtered), grouped by a divider
    const phase = snap?.plan.phase ?? "off";
    const options: CommandOption[] = [
      { label: "off", value: "off", description: "Exit plan mode", defaultSelected: true },
      { label: "switch auto", value: "switch auto", description: "Switch to auto mode (exits plan)" },
      { separator: true, label: "", value: "" },
    ];
    if (phase === "ready") {
      options.push({ label: "execute", value: "execute", description: "Build approved plan (from review)" });
    }
    if (phase === "retro") {
      options.push({ label: "done", value: "done", description: "Finish retro and exit plan mode" });
    }
    if (phase === "executing") {
      options.push({ label: "cancel", value: "cancel", description: "Pause building → review" });
    }
    options.push(
      { label: "status", value: "status", description: "Show phase and progress" },
      { label: "list", value: "list", description: "List saved plans" },
      { label: "save", value: "save", description: "Save/rename current plan (optional name)" }
    );

    if (session && phase !== "executing" && phase !== "retro") {
      try {
        const listed = await session.dispatch({ type: "plan.list" });
        const files = listed.ok ? ((listed.data as { files?: string[] } | undefined)?.files ?? []) : [];
        for (const file of files.slice(0, PLAN_LOAD_LIMIT)) {
          const name = file.replace(/\.md$/i, "");
          options.push({
            label: `load ${name}`,
            value: `load ${name}`,
            description: file,
          });
        }
      } catch {
        // ignore list errors in autocomplete
      }
    }

    return options;
  },
  execute: async (args, ctx) => {
    const session = ctx.getSession();
    if (!session) {
      return { ok: false, error: "Agent not initialized" };
    }

    // The grammar lives in core (`parseModeCommand`): the same `/mode execute` must mean the same thing
    // here and in every other host, and a host that restates it is how ACP ended up treating every
    // subcommand it did not recognise as a toggle.
    const intent = parseModeCommand(args);
    if (!intent) return { ok: false, error: MODE_USAGE };
    const mode: AgentMode = session.getSnapshot().mode;

    /** Single dispatch: core handles mutual exclusivity; message reflects the resulting mode. */
    const applyMode = async (target: AgentMode): Promise<CommandResult> => {
      const result = await session.dispatch({ type: "mode.set", mode: target });
      if (!result.ok) return { ok: false, error: result.error };
      const applied = (result.data as { mode?: AgentMode } | undefined)?.mode ?? target;
      if (applied === "auto") {
        return { ok: true, message: "Auto mode on — tools run without approval" };
      }
      if (applied === "plan") {
        return {
          ok: true,
          message: "Plan mode on — explore read-only (prefer task), then create_plan when ready",
        };
      }
      return {
        ok: true,
        message:
          mode === "plan"
            ? "Plan mode off (plan todos cleared if any)"
            : mode === "auto"
              ? "Auto mode off — tools require approval when configured"
              : "Already in normal mode",
      };
    };

    switch (intent.kind) {
      case "toggle": {
        // Same cycle as Shift+Tab: normal → auto → plan → off
        const result = await session.dispatch({ type: "mode.toggle" });
        if (!result.ok) return { ok: false, error: result.error };
        const applied = (result.data as { mode?: AgentMode } | undefined)?.mode ?? "normal";
        if (applied === "auto") {
          return { ok: true, message: "Auto mode on — tools run without approval" };
        }
        if (applied === "plan") {
          return {
            ok: true,
            message: "Plan mode on — explore read-only (prefer task), then create_plan when ready",
          };
        }
        return { ok: true, message: "Mode off — tools require approval when configured" };
      }

      case "set":
        return applyMode(intent.mode);

      case "status":
        return formatModeStatus(session);

      case "execute": {
        const result = await session.dispatch({ type: "plan.execute" });
        if (!result.ok) return { ok: false, error: result.error ?? "Cannot execute plan" };
        const data = result.data as { queued?: boolean; replacedExistingTodos?: boolean } | undefined;
        const parts = ["Building approved plan…"];
        if (data?.queued) parts.push("(queued — starts after the current run finishes)");
        if (data?.replacedExistingTodos) parts.push("(replaced existing todos with plan steps)");
        return { ok: true, message: parts.join(" ") };
      }

      case "done": {
        const result = await session.dispatch({ type: "plan.complete" });
        if (!result.ok) return { ok: false, error: result.error };
        return { ok: true, message: "Plan complete — plan mode off" };
      }

      case "cancel": {
        const result = await session.dispatch({ type: "plan.cancel" });
        if (!result.ok) return { ok: false, error: result.error || "Not building a plan — nothing to cancel" };
        return { ok: true, message: "Building paused — back to review (read-only). Run /mode execute to Build." };
      }

      case "save": {
        const result = await session.dispatch({ type: "plan.save", nameHint: intent.name });
        if (!result.ok) return { ok: false, error: result.error ?? "Save failed" };
        const path = (result.data as { path?: string } | undefined)?.path;
        return { ok: true, message: `Plan saved to ${path ?? "workspace"}` };
      }

      case "load": {
        const result = await session.dispatch({ type: "plan.load", name: intent.name });
        if (!result.ok) return { ok: false, error: result.error ?? "Load failed" };
        const data = result.data as { path?: string; stepCount?: number } | undefined;
        return {
          ok: true,
          message: `Loaded ${data?.path ?? intent.name} (${data?.stepCount ?? 0} steps) — review. Run /mode execute to Build.`,
        };
      }

      case "list": {
        const result = await session.dispatch({ type: "plan.list" });
        if (!result.ok) return { ok: false, error: result.error };
        const files = (result.data as { files?: string[] } | undefined)?.files ?? [];
        if (files.length === 0) return { ok: true, message: "No saved plans in .agents/plans/" };
        return { ok: true, message: `Saved plans:\n${files.map((file) => `- ${file}`).join("\n")}` };
      }
    }

    return { ok: false, error: MODE_USAGE };
  },
});
