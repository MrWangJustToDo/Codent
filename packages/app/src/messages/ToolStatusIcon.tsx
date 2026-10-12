import { BUILTIN_TOOL_NAMES } from "@codent/core";
import { Text } from "ink";

import { Spinner } from "../components/Spinner.js";
import { COLORS } from "../theme/colors.js";
import { getToolStatusGlyph } from "../utils/tool-display.js";

import type { UiToolState } from "../utils/tool-part.js";

export interface ToolStatusIconProps {
  state: UiToolState;
  toolName: string;
  /**
   * A `task` run that the step budget cut off. Its part still settles as
   * `output-available` — the run neither errored nor was cancelled — so `state`
   * alone would render a truncated run with the clean-finish check. Only the
   * live `taskPhase` distinguishes the two.
   */
  stoppedByLimit?: boolean;
  /**
   * A run the USER cancelled. The two cancel shapes settle on opposite states — a
   * cancelled `task` as `output-available` (the tool returns a normal result), a
   * cancelled `run_command` as `output-error` (the abort surfaced as a thrown
   * error) — so `state` alone paints the success check on one and the failure
   * cross on the other. Neither is right: the user stopped it. See
   * `isCancelledToolCall` for the two output shapes.
   */
  stoppedByCancel?: boolean;
}

/** Get status icon for tool invocation */
export const ToolStatusIcon = ({
  state,
  toolName,
  stoppedByLimit = false,
  stoppedByCancel = false,
}: ToolStatusIconProps) => {
  // Lifecycle states render a spinner or a question mark rather than a status
  // glyph, so they never reach the glyph table.
  switch (state) {
    case "input-streaming":
    case "input-available":
    case "approval-responded":
      return toolName === BUILTIN_TOOL_NAMES.askUser ? <Text color={COLORS.warning}>?</Text> : <Spinner text="" />;
    case "approval-requested":
      return <Text color={COLORS.warning}>?</Text>;
    default:
      break;
  }

  const glyph = getToolStatusGlyph(state, stoppedByLimit, stoppedByCancel);
  if (!glyph) return null;

  // A cutoff or a user cancel outranks the underlying state: neither failed, but
  // neither may wear the success colour either.
  const color =
    stoppedByLimit || stoppedByCancel ? COLORS.warning : state === "output-available" ? COLORS.success : COLORS.danger;
  return <Text color={color}>{glyph}</Text>;
};
