import { getActiveSession } from "../utils/session-resolve.js";
import { isPendingToolApproval, isToolCallPart } from "../utils/tool-part.js";

import { registerBuiltinCommand } from "./utils/registry.js";

import type { CommandOption, CommandResult } from "./utils/types.js";
import type { AgentMode } from "@codent/core";

const PLAN_LOAD_LIMIT = 15;

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

    const trimmed = args.trim();
    const [headRaw = "", secondRaw = ""] = trimmed.toLowerCase().split(/\s+/);
    const head = headRaw;
    const second = secondRaw;
    const nameArg = trimmed.split(/\s+/).slice(1).join(" ").trim();
    const mode: AgentMode = session.getSnapshot().mode;

    const approveAllPending = async () => {
      if (!ctx.addToolApprovalResponse || !ctx.getMessages) return;
      const messages = ctx.getMessages();
      for (const msg of messages) {
        if (msg.role !== "assistant") continue;
        for (const part of msg.parts) {
          if (!isToolCallPart(part)) continue;
          if (!isPendingToolApproval(part)) continue;
          const approvalId = part.approval?.id;
          if (!approvalId) continue;
          await ctx.addToolApprovalResponse({ id: approvalId, approved: true });
        }
      }
    };

    /** Single dispatch: core handles mutual exclusivity; message reflects the resulting mode. */
    const applyMode = async (target: AgentMode): Promise<CommandResult> => {
      const result = await session.dispatch({ type: "mode.set", mode: target });
      if (!result.ok) return { ok: false, error: result.error };
      const applied = (result.data as { mode?: AgentMode } | undefined)?.mode ?? target;
      if (applied === "auto") {
        await approveAllPending();
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

    if (head === "" || head === "toggle") {
      // Same cycle as Shift+Tab: normal → auto → plan → off
      const result = await session.dispatch({ type: "mode.toggle" });
      if (!result.ok) return { ok: false, error: result.error };
      const applied = (result.data as { mode?: AgentMode } | undefined)?.mode ?? "normal";
      if (applied === "auto") {
        await approveAllPending();
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

    if (head === "plan") return applyMode(second === "off" ? "normal" : "plan");
    if (head === "auto") return applyMode(second === "off" ? "normal" : "auto");

    if (head === "switch") {
      if (second === "plan") return applyMode("plan");
      if (second === "auto") return applyMode("auto");
      return { ok: false, error: "Usage: /mode switch plan | /mode switch auto" };
    }

    if (head === "off") return applyMode("normal");

    if (head === "status") {
      if (mode === "plan") {
        const state = session.getSnapshot().plan;
        // Todo progress straight from the session snapshot (no store projection).
        const todos = session.getSnapshot().todos ?? [];
        let completed = 0;
        for (const item of todos) if (item.status === "completed") completed += 1;
        const stats = { total: todos.length, completed };
        const displayPhase =
          state.phase === "ready"
            ? "review"
            : state.phase === "executing"
              ? "building"
              : state.phase === "planning"
                ? "planning"
                : state.phase;
        const progress =
          state.phase === "executing" && stats.total > 0
            ? ` (${stats.completed}/${stats.total} todos)`
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
        return {
          ok: true,
          message: `Mode: plan (${displayPhase})${progress}${path}${preserved}${next}`,
        };
      }
      if (mode === "auto") return { ok: true, message: "Mode: auto — tools run without approval" };
      return { ok: true, message: "Mode: normal — tools require approval when configured" };
    }

    if (head === "execute" || head === "run" || head === "build") {
      const result = await session.dispatch({ type: "plan.execute" });
      if (!result.ok) return { ok: false, error: result.error ?? "Cannot execute plan" };
      const data = result.data as { queued?: boolean; replacedExistingTodos?: boolean } | undefined;
      const parts = ["Building approved plan…"];
      if (data?.queued) parts.push("(queued — starts after the current run finishes)");
      if (data?.replacedExistingTodos) parts.push("(replaced existing todos with plan steps)");
      return { ok: true, message: parts.join(" ") };
    }

    if (head === "done" || head === "complete") {
      const result = await session.dispatch({ type: "plan.complete" });
      if (!result.ok) return { ok: false, error: result.error };
      return { ok: true, message: "Plan complete — plan mode off" };
    }

    if (head === "cancel") {
      const result = await session.dispatch({ type: "plan.cancel" });
      if (!result.ok) return { ok: false, error: result.error || "Not building a plan — nothing to cancel" };
      return { ok: true, message: "Building paused — back to review (read-only). Run /mode execute to Build." };
    }

    if (head === "save") {
      const saveName = nameArg || undefined;
      const result = await session.dispatch({ type: "plan.save", nameHint: saveName });
      if (!result.ok) return { ok: false, error: result.error ?? "Save failed" };
      const path = (result.data as { path?: string } | undefined)?.path;
      return { ok: true, message: `Plan saved to ${path ?? "workspace"}` };
    }

    if (head === "load") {
      if (!nameArg) return { ok: false, error: "Usage: /mode load <name>" };
      const result = await session.dispatch({ type: "plan.load", name: nameArg });
      if (!result.ok) return { ok: false, error: result.error ?? "Load failed" };
      const data = result.data as { path?: string; stepCount?: number } | undefined;
      return {
        ok: true,
        message: `Loaded ${data?.path ?? nameArg} (${data?.stepCount ?? 0} steps) — review. Run /mode execute to Build.`,
      };
    }

    if (head === "list") {
      const result = await session.dispatch({ type: "plan.list" });
      if (!result.ok) return { ok: false, error: result.error };
      const files = (result.data as { files?: string[] } | undefined)?.files ?? [];
      if (files.length === 0) return { ok: true, message: "No saved plans in .agents/plans/" };
      return { ok: true, message: `Saved plans:\n${files.map((f) => `- ${f}`).join("\n")}` };
    }

    return {
      ok: false,
      error:
        "Usage: /mode | /mode plan | /mode auto | /mode off | /mode status | /mode execute | /mode done | /mode cancel | /mode save [name] | /mode load <name> | /mode list",
    };
  },
});
