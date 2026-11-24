import { Box } from "ink";

import { ExitSummary } from "../components/ExitSummary.js";
import { Help } from "../components/Help.js";
import { useConfig } from "../hooks/use-config.js";
import { useTheme } from "../hooks/use-theme.js";

import { Agent } from "./Agent.js";

export const App = () => {
  // Subscribe so /settings palette mutations re-render the tree.
  useTheme((s) => s.theme);

  const helpRequested = useConfig((s) => s.helpRequested);

  if (helpRequested) {
    return (
      <Box flexDirection="column">
        <Help />
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      <Agent />
      {/* Below every screen, not just the chat: an exit from the resume picker, the config
          wizard or a panel must show the session's outcome too. Rendering nothing until the
          exit path stashes the lines keeps it free while the app is running. */}
      <ExitSummary />
    </Box>
  );
};
