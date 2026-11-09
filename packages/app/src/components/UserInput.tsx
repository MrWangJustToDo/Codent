import { Box } from "ink";
import { useEffect, useState } from "react";

import { useAgentStatus } from "../hooks/use-agent-status.js";
import { useUserInput } from "../hooks/use-user-input.js";
import { isAgentBusyStatus } from "../utils/agent-status.js";
import { HINT_ROTATE_INTERVAL_MS, currentInputHint, nextInputHint } from "../utils/input-hints.js";

import { MultiLineInput } from "./MultiLineInput.js";

export const UserInput = () => {
  const value = useUserInput((s) => s.value);
  const cursorPosition = useUserInput((s) => s.cursorPosition);
  const selectAll = useUserInput((s) => s.selectAll);
  const pendingPastes = useUserInput((s) => s.pendingPastes);
  const expandedPasteIndex = useUserInput((s) => s.expandedPasteIndex);

  // No hint while the agent is busy: the empty input is then a queue/steer box,
  // and a rotating tip there competes with the live run status in the footer.
  const showHint = !isAgentBusyStatus(useAgentStatus((s) => s.status));

  const [hint, setHint] = useState(currentInputHint);

  // Rotate the placeholder hint while the input is empty and idle; pause once the
  // user starts typing so the hint never churns under the cursor, and while the
  // hint is hidden so the deck does not advance behind a blank placeholder. The
  // deck itself lives in utils/input-hints.js, so a remount keeps the current hint.
  useEffect(() => {
    if (value || !showHint) return;
    const id = setInterval(() => {
      setHint(nextInputHint());
    }, HINT_ROTATE_INTERVAL_MS);
    return () => clearInterval(id);
  }, [value, showHint]);

  return (
    <Box flexDirection="column">
      <MultiLineInput
        value={value}
        placeholder={showHint ? hint : ""}
        cursorPosition={cursorPosition}
        selectAll={selectAll}
        pendingPastes={pendingPastes}
        expandedPasteIndex={expandedPasteIndex}
      />
    </Box>
  );
};
