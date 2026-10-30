import { Box } from "ink";

import { ExtensionRenderSurface } from "../components/ExtensionRenderSurface.js";
import { useExtensionUI } from "../hooks/use-extension-ui.js";
import { BG } from "../theme/colors.js";

/**
 * Extension render surface for the `footer` region — one slot per key, sorted so
 * ordering is deterministic regardless of publish order. Rendered above the
 * footer border and visible in every agent status.
 */
export const FooterExtensionSurface = () => {
  const slots = useExtensionUI((s) => s.surfaces.footer);

  const keys = slots ? Object.keys(slots).sort() : [];
  if (keys.length === 0) return null;

  return (
    <>
      <Box
        borderLeft={false}
        borderRight={false}
        borderBottom={false}
        borderTop
        borderTopColor={BG.border}
        borderStyle="single"
        borderTopDimColor
        width="full"
      />
      <Box flexDirection="column" paddingX={1}>
        {keys.map((key) => (
          <ExtensionRenderSurface key={key} payload={slots![key]} />
        ))}
      </Box>
    </>
  );
};
