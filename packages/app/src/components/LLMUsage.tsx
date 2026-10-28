import { Box, Text } from "ink";

import { useAgentUsage } from "../hooks/use-agent-usage";
import { COLORS } from "../theme/colors.js";
import { formatContextUsage } from "../utils/format-usage.js";
import { formatCost } from "../utils/format.js";

import { AnimateNumber } from "./AnimateNumber";

/**
 * Footer usage: lifetime in/out (billing) · context fill · cost.
 * Context % is the real window fill (uncached + cached prompt) over tokenLimit —
 * `window.inputTokens` alone under-reports on an exclusive-cache upstream.
 *
 * The in/out pair is the billed prompt against the output, not `total.inputTokens`: on an
 * exclusive upstream that field is the cache-miss part alone, so the footer read `523↓`
 * where `50.63M↓` were billed.
 */
export const LLMUsage = () => {
  const { usage } = useAgentUsage();

  if (!usage) return null;

  const contextLabel = formatContextUsage({
    contextFillTokens: usage.contextFillTokens,
    tokenLimit: usage.tokenLimit,
    percent: usage.percent,
  });

  return (
    <Box gap={1}>
      <Text color={COLORS.muted} dimColor wrap="truncate">
        <AnimateNumber number={usage.billedInputTokens} />
        ↓/
        <AnimateNumber number={usage.total.outputTokens} />↑{contextLabel ? ` · ${contextLabel}` : ""}
      </Text>
      {usage.cost > 0 && (
        <Text color={COLORS.warning} dimColor wrap="truncate">
          {formatCost(usage.cost)}
        </Text>
      )}
    </Box>
  );
};
