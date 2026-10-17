import {
  parseEffortCommand,
  REASONING_EFFORT_VALUES,
  supportedReasoningEfforts,
  type ReasoningEffort,
} from "@codent/core";

import { useThinkingLine } from "../hooks/use-thinking-line.js";
import { getActiveSession } from "../utils/session-resolve.js";

import { registerBuiltinCommand } from "./utils/registry.js";

/**
 * Resolve the effort values the active model advertises (models.dev
 * `reasoning_options`), falling back to the known set. Core owns both the list and the fallback
 * (`supportedReasoningEfforts`) — the TUI and the ACP host must not offer different values.
 */
function getModelEffortValues(): readonly ReasoningEffort[] {
  const session = getActiveSession();
  return supportedReasoningEfforts(session?.getSnapshot()?.modelInfo);
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
    const displayActions = useThinkingLine.getActions();
    // The `/effort` grammar lives in core: `display` is UI state, not an effort level, and a headless
    // host that re-parsed it would either forward "display" to the model or reject a valid command.
    const intent = parseEffortCommand(args);

    switch (intent.kind) {
      case "display": {
        if (intent.action === "status") {
          return { ok: true, message: `Thinking display: ${displayActions.getEnabled() ? "on" : "off"}` };
        }
        let next: boolean;
        if (intent.action === "on") next = true;
        else if (intent.action === "off") next = false;
        else next = displayActions.toggle();
        displayActions.setEnabled(next);
        return { ok: true, message: `Thinking display: ${next ? "on" : "off"}` };
      }

      case "status": {
        const session = getActiveSession();
        if (!session) return { ok: false, error: "Agent not initialized" };
        const effort = getCurrentEffort();
        const supported = getModelEffortValues();
        const model = session.getSnapshot().modelInfo?.name ?? session.getSnapshot().model;
        return {
          ok: true,
          message:
            `Model: ${model}\n` +
            `Reasoning effort: ${effort ?? "default (unset)"}\n` +
            `Supported: ${supported.join(", ")}\n` +
            `Thinking display: ${displayActions.getEnabled() ? "on" : "off"}`,
        };
      }

      case "clear": {
        const session = getActiveSession();
        if (!session) return { ok: false, error: "Agent not initialized" };
        const result = await session.dispatch({ type: "effort.set", effort: undefined });
        if (!result.ok) return { ok: false, error: result.error };
        return { ok: true, message: "Reasoning effort: model default" };
      }

      case "invalid":
        return {
          ok: false,
          error: `Unknown effort "${intent.value}". Use one of: ${REASONING_EFFORT_VALUES.join(", ")} or "off"/"status".`,
        };

      case "set": {
        const session = getActiveSession();
        if (!session) return { ok: false, error: "Agent not initialized" };
        const supported = getModelEffortValues();
        if (!supported.includes(intent.effort)) {
          return {
            ok: false,
            error: `Model does not support effort "${intent.effort}". Supported: ${supported.join(", ") || "none"}`,
          };
        }
        const result = await session.dispatch({ type: "effort.set", effort: intent.effort });
        if (!result.ok) return { ok: false, error: result.error };
        return { ok: true, message: `Reasoning effort: ${intent.effort}` };
      }
    }
  },
});
