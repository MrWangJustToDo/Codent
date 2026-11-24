import { Box, Text } from "ink";
import { useEffect } from "react";

import { useAgent } from "../hooks/use-agent.js";
import { COLORS } from "../theme/colors.js";

import { FullBox } from "./FullBox.js";

/**
 * The session's outcome, rendered below whichever screen is up for the moment between `/quit` (or
 * Ctrl+C) and the process actually going away.
 *
 * Renders lines captured at exit time rather than reading the session here: the exit path
 * destroys the session before `process.exit` lands, so by the time this paints there may be no
 * snapshot left to read. `exitWithSummary` builds the lines while the session is still live.
 *
 * Mounted once, by `App`, as the last region after whichever screen is up, because this is the one
 * placement the layout can get right: the summary becomes the frame's last row region, so it lands
 * below the footer whatever the screen, and the renderer's own scrollback math places it. A host
 * has no such knowledge — the cursor left behind after `unmount` is the input caret, mid-frame —
 * which is why a host that printed the lines itself wrote them over the footer it had just painted.
 * The host prints only as the fallback for a frame that will not reach the user (see
 * `AgentAdapter.exit`).
 *
 * The top border is what separates it from the footer above — the footer ends with its own
 * `borderTop` rule, so a second one reads as "a new region of the same screen" rather than as
 * more footer. Full width via {@link FullBox}, matching that rule.
 *
 * Ink owns this frame like any other — the exit path must not write to stdout directly, because
 * Ink tracks the terminal row by row and an external write makes it skip every row whose content
 * did not change (see `PanelOverlay`). A host that relies on this row lets it paint before it
 * releases the renderer, the same arrangement `Help` uses before it exits.
 */
export const ExitSummary = () => {
  const lines = useAgent((s) => s.exitSummaryLines);
  const hasLines = Boolean(lines && lines.length > 0);

  // Commit-time handshake. This runs after the rows below are in the tree, so from here on every
  // painted frame carries them; the host's exit path waits for that frame before it releases the
  // renderer, and only prints the lines itself when this never ran (no screen to paint them on).
  useEffect(() => {
    if (hasLines) useAgent.getActions().markExitSummaryCommitted();
  }, [hasLines]);

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
