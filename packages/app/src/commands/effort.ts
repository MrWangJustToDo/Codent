import { useThinkingLine } from "../hooks/use-thinking-line.js";
import { getActiveSession } from "../utils/session-resolve.js";

import { registerBuiltinCommand } from "./utils/registry.js";

import type { ReasoningEffort } from "@codent/core";

const EFFORT_VALUES: readonly ReasoningEffort[] = ["none", "low", "medium", "high", "xhigh", "max", "minimal"];

function isEffort(value: string): value is ReasoningEffort {
  return (EFFORT_VALUES as readonly string[]).includes(value);
}

/**
 * Resolve the effort values the active model advertises (models.dev
 * `reasoning_options`), falling back to the known set.
 */
function getModelEffortValues(): readonly ReasoningEffort[] {
  const session = getActiveSession();
  const modelInfo = session?.getSnapshot()?.modelInfo;
  const values = modelInfo?.reasoningConfig?.effortValues;
  return values && values.length > 0 ? values : EFFORT_VALUES;
}

function getCurrentEffort(): ReasoningEffort | undefined {
  const session = getActiveSession();
  return session?.getSnapshot()?.reasoningEffort ?? undefined;
}

registerBuiltinCommand("effort", {
  immediate: false,
  getOptions: () => {
    const display = useThinkingLine.getActions().getEnabled();
    const effort = getCurrentEffort();
    const modelEffortValues = getModelEffortValues();

    const options = [
      {
        label: "display",
        value: "display",
        description: `Toggle thinking display in footer (current: ${display ? "on" : "off"})`,
      },
      {
        label: "off",
        value: "off",
        description: effort === undefined ? "current (use model default)" : "Use model default reasoning effort",
      },
    ];

    for (const v of modelEffortValues) {
      options.push({
        label: v,
        value: v,
        description: v === effort ? "current" : `Set reasoning effort to ${v}`,
      });
    }
    return options;
  },
  execute: async (args) => {
    const trimmed = args.trim().toLowerCase();
    const displayActions = useThinkingLine.getActions();

    // Display toggle (kept from the old /thinking command).
    if (
      trimmed === "display" ||
      trimmed === "display on" ||
      trimmed === "display off" ||
      trimmed === "display toggle"
    ) {
      const sub = trimmed.split(/\s+/)[1] ?? "toggle";
      let next: boolean;
      if (sub === "on") next = true;
      else if (sub === "off") next = false;
      else next = displayActions.toggle();
      displayActions.setEnabled(next);
      return { ok: true, message: `Thinking display: ${next ? "on" : "off"}` };
    }

    if (trimmed === "display?") {
      return { ok: true, message: `Thinking display: ${displayActions.getEnabled() ? "on" : "off"}` };
    }

    const session = getActiveSession();
    if (!session) {
      return { ok: false, error: "Agent not initialized" };
    }

    if (trimmed === "" || trimmed === "status") {
      const effort = getCurrentEffort();
      const supported = getModelEffortValues();
      const display = displayActions.getEnabled();
      const model = session.getSnapshot().modelInfo?.name ?? session.getSnapshot().model;
      return {
        ok: true,
        message:
          `Model: ${model}\n` +
          `Reasoning effort: ${effort ?? "default (unset)"}\n` +
          `Supported: ${supported.join(", ")}\n` +
          `Thinking display: ${display ? "on" : "off"}`,
      };
    }

    // off = clear to model default
    if (trimmed === "off") {
      const result = await session.dispatch({ type: "effort.set", effort: undefined });
      if (!result.ok) return { ok: false, error: result.error };
      return { ok: true, message: "Reasoning effort: model default" };
    }

    if (!isEffort(trimmed)) {
      return {
        ok: false,
        error: `Unknown effort "${trimmed}". Use one of: ${EFFORT_VALUES.join(", ")} or "off"/"status".`,
      };
    }

    const supported = getModelEffortValues();
    if (!supported.includes(trimmed)) {
      return {
        ok: false,
        error: `Model does not support effort "${trimmed}". Supported: ${supported.join(", ") || "none"}`,
      };
    }

    const result = await session.dispatch({ type: "effort.set", effort: trimmed });
    if (!result.ok) return { ok: false, error: result.error };
    return { ok: true, message: `Reasoning effort: ${trimmed}` };
  },
});
