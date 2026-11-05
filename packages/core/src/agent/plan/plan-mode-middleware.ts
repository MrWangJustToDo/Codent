import { defineMiddleware } from "../../runtime-types/middleware-phase.js";

import { getPlanModeToolBlockReason } from "./plan-tools.js";

import type { ModeState } from "../mode/mode-state.js";
import type { ToolRunContext } from "../runner/run-context.js";
import type { ToolPresentation } from "../tools/presentation/types.js";
import type { ChatMiddleware } from "@tanstack/ai";

export interface PlanModeMiddlewareDeps {
  getModeState: () => ModeState | null;
  resolveToolPresentation?: (name: string) => ToolPresentation | undefined;
  /** Whether the live tool is the built-in (see `ExtensionsMiddlewareDeps.isBuiltinTool`). */
  isBuiltinTool?: (name: string) => boolean;
}

/** Skip forbidden / unsafe tools while plan mode restricts tooling. */
export function createPlanModeMiddleware(deps: PlanModeMiddlewareDeps): ChatMiddleware<ToolRunContext> {
  return defineMiddleware("tools", {
    name: "plan-mode",
    onBeforeToolCall: async (_ctx, hookCtx) => {
      const modeState = deps.getModeState();
      const reason = getPlanModeToolBlockReason(
        modeState,
        hookCtx.toolName,
        hookCtx.args,
        deps.resolveToolPresentation,
        deps.isBuiltinTool
      );
      if (!reason) return;
      return {
        type: "skip",
        // The shared denial marker, not a bare `{ error }`: `getUiToolState` reads no `success`
        // from the bare shape, so a plan-blocked tool rendered as a GREEN success with no body,
        // while an extension refusal with the marker renders as denied. One refusal, one look.
        result: {
          success: false,
          cancelled: false,
          denied: true,
          error: reason,
        },
      };
    },
  });
}
