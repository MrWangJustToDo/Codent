import { Box, Text } from "ink";

import { useAgent } from "../hooks/use-agent.js";
import { COLORS } from "../theme/colors.js";

import { FullBox } from "./FullBox.js";

/**
 * The session's outcome, appended below the footer for the moment between `/quit` (or Ctrl+C)
 * and the process actually going away.
 *
 * Renders lines captured at exit time rather than reading the session here: the exit path
 * destroys the session before `process.exit` lands, so by the time this paints there may be no
 * snapshot left to read. `exitWithSummary` builds the lines while the session is still live.
 *
 * Only the hosts that do NOT print the report themselves render this — the host's
 * `printsExitReport` decides (see `exitWithSummary`), because a host that prints after releasing the
 * renderer would otherwise show the block twice: the last frame outlives the unmount.
 *
 * The top border is what separates it from the footer above — the footer ends with its own
 * `borderTop` rule, so a second one reads as "a new region of the same screen" rather than as
 * more footer. Full width via {@link FullBox}, matching that rule.
 *
 * Ink owns this frame like any other — the exit path must not write to stdout directly, because
 * Ink tracks the terminal row by row and an external write makes it skip every row whose content
 * did not change (see `PanelOverlay`). A host that relies on this row defers `process.exit` by a
 * frame, the same arrangement `Help` uses.
 */
export const ExitSummary = () => {
  const lines = useAgent((s) => s.exitSummaryLines);
  if (!lines || lines.length === 0) return null;

  return (
    <FullBox flexDirection="column" flexShrink={0} paddingBottom={1}>
      <Box
        borderLeft={false}
        borderRight={false}
        borderBottom={false}
        borderTop
        borderTopColor={COLORS.muted}
        borderStyle="single"
        width="full"
      />

      <Box flexDirection="column" paddingX={2} marginTop={1}>
        {lines.map((line, index) =>
          // A blank line separates the summary's groups; render it as a real row so the
          // rhythm matches the text rows and the whole block stays one flat column.
          line === "" ? <Text key={index}> </Text> : <Text key={index}>{line}</Text>
        )}
      </Box>
    </FullBox>
  );
};
