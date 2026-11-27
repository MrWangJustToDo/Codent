import { Box, Text } from "ink";

import { COLORS } from "../theme/colors.js";

import type { TodoItem, TodoStatus } from "@codent/core";

// ============================================================================
// Visual constants
// ============================================================================

/**
 * Status → palette color, resolved per render.
 *
 * Deliberately a function: a module-level `Record<TodoStatus, string>` captures whatever palette
 * was installed when this module was first imported, so `applyColorPalette` (which reassigns the
 * shared `COLORS` object in place) could never repaint a todo row — a `claude`-themed session kept
 * rendering the `gemini` status colors. Anything that reads `COLORS` must read it at render time.
 *
 * `in_progress` is `primary` ("active state"), not `warning` ("waiting, approval needed"): the amber
 * is what the transcript already uses for an `ask_user` question and a pending approval, so reusing
 * it for work in flight made "the agent is working" and "the agent is waiting for you" the same
 * color.
 */
const statusColor = (status: TodoStatus): string => {
  switch (status) {
    case "in_progress":
      return COLORS.primary;
    case "completed":
      return COLORS.success;
    default:
      return COLORS.muted;
  }
};

const STATUS_ICONS: Record<TodoStatus, string> = {
  pending: "[ ]",
  in_progress: "[>]",
  completed: "[✓]",
};

// ============================================================================
// Types
// ============================================================================

export interface TodoToolOutputViewProps {
  items: TodoItem[];
  /** Explicit marker from todo tool output (`source=plan`). */
  source?: "plan" | "agent" | null;
}

// ============================================================================
// Sub-components
// ============================================================================

const TodoRow = ({ item, stepIndex, showStep }: { item: TodoItem; stepIndex: number; showStep: boolean }) => {
  const icon = STATUS_ICONS[item.status];
  const color = statusColor(item.status);

  return (
    <Box flexDirection="row" gap={1}>
      <Box flexShrink={0}>
        <Text color={color}>{icon}</Text>
      </Box>
      {showStep && (
        <Box flexShrink={0}>
          <Text color={COLORS.muted} dimColor>
            {stepIndex}.
          </Text>
        </Box>
      )}
      <Text color={color} wrap="wrap">
        {item.content}
      </Text>
    </Box>
  );
};

// ============================================================================
// Main component
// ============================================================================

function isPlanTodoSource(source?: string | null): boolean {
  // Ownership is the `source` marker only. Older transcripts predate the marker, but
  // falling back to the title made any agent list named "Plan" render as plan steps —
  // and a persisted `todoPlanBound` then kept that rendering for every later list.
  return source === "plan";
}

/**
 * Rich todo list renderer for the `todo` tool output.
 *
 * Plan-sourced lists (`source=plan`) get step numbers.
 *
 * Priority is deliberately NOT rendered: it is the agent's scheduling input (and the todo tool's
 * model-facing formatter carries it), not a fact the user needs beside every row. Status already
 * owns the row's colour, so a `[HIGH]` tag only competed with it for attention.
 */
export const TodoToolOutputView = ({ items, source }: TodoToolOutputViewProps) => {
  if (items.length === 0) return null;

  const showStep = isPlanTodoSource(source);
  const completed = items.filter((i) => i.status === "completed").length;

  return (
    <Box flexDirection="column" paddingLeft={2} gap={0}>
      {showStep && (
        <Text color={COLORS.muted} dimColor>
          Plan steps · {completed}/{items.length}
        </Text>
      )}
      {items.map((item, index) => (
        <TodoRow key={item.id} item={item} stepIndex={index + 1} showStep={showStep} />
      ))}
    </Box>
  );
};
