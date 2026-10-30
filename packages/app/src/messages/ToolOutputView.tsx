import { BUILTIN_TOOL_NAMES, splitStreamingLines } from "@codent/core";
import { Box, Text } from "ink";

import { HalfLinePaddedBox } from "../components/HalfLinePaddedBox.js";
import { useTranscriptDisplayMode } from "../context/transcript-display-context.js";
import { useSize } from "../hooks";
import { BG, COLORS } from "../theme/colors.js";
import { formatToolOutput } from "../utils/format";
import { hasDetailedOutputBlock, keepsCompactRow } from "../utils/tool-display.js";
import { isCancelledToolCall } from "../utils/tool-part.js";
import { isBuiltinTool, resolveToolPresentation } from "../utils/tool-presentation.js";

import { TodoToolOutputView } from "./TodoToolOutputView.js";

import type { UiToolState } from "../utils/tool-part.js";
import type { TodoItem } from "@codent/core";
import type { ToolCallPart } from "@tanstack/ai";

/** Max chars kept for a compact single-line result block. */
const COMPACT_LINE_MAX = 200;

/** Compact keeps one curated line (the `present.text` contract) instead of the full block. */
function clampCompactLine(line: string): string {
  return line.length > COMPACT_LINE_MAX ? `${line.slice(0, COMPACT_LINE_MAX - 1)}…` : line;
}

export const ToolOutputView = ({ part, uiState }: { part: ToolCallPart; uiState: UiToolState }) => {
  const mode = useTranscriptDisplayMode();
  const screenWidth = useSize((s) => s.state.screenWidth);
  const toolName = part.name;

  if (uiState !== "output-available" && uiState !== "output-error") return null;

  if (mode === "compact" && !keepsCompactRow(toolName)) {
    return null;
  }

  // Rich block background: message container paddingX=1 + tool column
  // paddingLeft=2 → width compensates so the right edge aligns with user
  // message boxes (screenWidth - 2).
  const boxWidth = Math.max(screenWidth - 4, 1);

  // A built-in-only renderer reads the built-in's output schema; a tool that merely SHADOWS the
  // name may have a different shape, so it falls through to the generic body.
  if (isBuiltinTool(toolName) && toolName === BUILTIN_TOOL_NAMES.todo) {
    const output = part.output as { items?: TodoItem[]; title?: string; source?: "plan" | "agent" };
    if (!output.items) return null;
    return (
      <HalfLinePaddedBox backgroundColor={BG.toolResult} width={boxWidth}>
        <TodoToolOutputView items={output.items} source={output.source} />
      </HalfLinePaddedBox>
    );
  }

  if (isBuiltinTool(toolName) && toolName === BUILTIN_TOOL_NAMES.askUser && uiState === "output-error") {
    return null;
  }

  const isDetailed = hasDetailedOutputBlock(toolName);
  // Core renders the result text once, at completion, and ships it with the part. Hosts
  // must not need the tool registry in their own process (remote session, extension
  // hosts) — the local formatter stays only as the fallback for older parts.
  const display = (part as ToolCallPart & { display?: { text?: string } }).display;
  // The built-in formatter is keyed by NAME: for a tool that merely shadows one it would read a
  // schema that never produced this output. Non-built-ins render what core attached (nothing when
  // they declared no renderer), which is also the rule for unknown names inside `formatToolOutput`.
  const output = display?.text ?? (isBuiltinTool(toolName) ? formatToolOutput(part.output, toolName) : "");

  // Error outputs carry `{ error }` (no formattable body) — the message is
  // rendered by ToolCallPartView, so skip the otherwise-empty result block.
  if (uiState === "output-error" && !output.trim()) return null;

  // Extension (and other) tools: show the default block only when the tool rendered
  // non-empty text (`present.text`, in-process or precomputed into the payload).
  if (!isDetailed) {
    const hasRenderer = Boolean(display?.text) || Boolean(resolveToolPresentation(toolName)?.text);
    if (!hasRenderer || !output.trim()) return null;
  }

  const hasCanceld = isCancelledToolCall(part);

  const outputLines = splitStreamingLines(output);
  // Structured tools (row-keeping, no result renderer) keep their full block in both
  // modes; anything else allowed to render in compact is one clamped line.
  const structured = keepsCompactRow(toolName) && !resolveToolPresentation(toolName)?.text;
  const lines = mode === "compact" && !structured ? [clampCompactLine(outputLines[0] ?? "")] : outputLines;
  // A cancelled command carries `success: false`, so the old check painted its output block in
  // the failure color while the header showed a neutral ⚠ — one row, two verdicts. It did not
  // fail; it was stopped. The muted/dim treatment is the same "neither succeeded nor failed"
  // choice the glyph makes, and it survives the part being rewritten (the synthetic cancel
  // payload and the tool's own catch both leave `success: false`).
  const failed =
    isBuiltinTool(toolName) &&
    toolName === BUILTIN_TOOL_NAMES.runCommand &&
    (part.output as { success?: boolean } | undefined)?.success === false &&
    !hasCanceld;
  const lineColor = failed ? COLORS.danger : COLORS.muted;

  return (
    <HalfLinePaddedBox backgroundColor={BG.toolResult} width={boxWidth}>
      <Box flexDirection="column" paddingLeft={2}>
        {lines.map((line, i) => (
          // `truncate-end`, NOT the default `wrap`: the formatters above budget by LOGICAL line
          // (`formatRunCommandOutput` keeps three stdout / three stderr lines), but a wrapping
          // Text spends one PHYSICAL row per `width` columns. A 400-char compiler diagnostic or
          // a line of minified JS therefore cost four rows against a three-line budget — five
          // logical lines measured 17 rendered rows at 114 columns. Truncating each line makes
          // the budget real: one logical line is one row, always.
          <Text key={i} color={lineColor} dimColor={!failed} wrap="truncate-end">
            {line.length > 0 ? line : " "}
          </Text>
        ))}
      </Box>
    </HalfLinePaddedBox>
  );
};
