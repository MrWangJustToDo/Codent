import { Box, Text } from "ink";

import { AutocompleteList } from "../components/AutocompleteList.js";
import { CommandOutput } from "../components/CommandOutput.js";
import { FullBox } from "../components/FullBox.js";
import { SelectList } from "../components/SelectList.js";
import { useInputMode } from "../hooks/use-input-mode.js";
import { useSelect } from "../hooks/use-select.js";
import { useThinkingLine } from "../hooks/use-thinking-line.js";
import { BG, COLORS } from "../theme/colors.js";
import { isAgentBusyStatus } from "../utils/agent-status.js";
import { nextQueuedPreview } from "../utils/queue-preview.js";

import { FooterContextBar } from "./FooterContextBar.js";
import { FooterExtensionSurface } from "./FooterExtensionSurface.js";
import { FooterInput } from "./FooterInput.js";
import { FooterStatusBar } from "./FooterStatusBar.js";

import type { AgentStatus, QueuedMessagesSnapshot } from "@codent/core";

export const Footer = ({
  status,
  queuedMessages,
  saveError,
}: {
  status: AgentStatus;
  queuedMessages?: QueuedMessagesSnapshot;
  /** Last session persistence failure (empty when none). */
  saveError?: string;
}) => {
  const { mode, denyMode, freeformContext } = useInputMode((s) => ({
    mode: s.mode,
    denyMode: s.denyMode,
    freeformContext: s.freeformContext,
  }));

  const isPendingApproval = mode === "approval";

  const displayStatus: AgentStatus = status;

  const { isMultiSelect, cursorOnFreeform } = useSelect((s) => {
    const freeformIdx = s.freeformEnabled ? s.options.length - 1 : -1;
    return {
      isMultiSelect: s.multiSelect,
      cursorOnFreeform: freeformIdx !== -1 && s.selectedIndex === freeformIdx,
    };
  });

  const showFreeformInput = denyMode;
  const showSelectList = mode === "select";
  const freeformLabel = freeformContext === "deny" ? "Deny reason > " : "Answer > ";
  // Allow typing while the agent runs so users can queue follow-up / force-submit.
  const isInputEnabled = mode === "normal" || mode === "approval" || denyMode || mode === "select";
  const isAgentBusy = isAgentBusyStatus(displayStatus);
  const steerCount = queuedMessages?.steer.length ?? 0;
  const followUpCount = queuedMessages?.followUp.length ?? 0;
  // The snapshot carries the CONTENT; the counts alone cannot tell a user what they queued.
  const queuePreview = nextQueuedPreview(queuedMessages);

  const thinkingEnabled = useThinkingLine((s) => s.enabled);
  const thinkingContent = useThinkingLine((s) => s.content);

  return (
    <FullBox flexDirection="column" flexGrow={1} flexShrink={0} paddingY={1}>
      {/* Thinking line — above the border, outside the footer panel */}
      {thinkingEnabled && thinkingContent && (
        <Box paddingX={1}>
          <Text color={COLORS.muted} dimColor wrap="truncate-end">
            {thinkingContent}
          </Text>
        </Box>
      )}

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

      <FooterContextBar
        status={displayStatus}
        isPendingApproval={isPendingApproval}
        showFreeformInput={showFreeformInput}
        showSelectList={showSelectList}
        isMultiSelect={isMultiSelect}
        cursorOnFreeform={cursorOnFreeform}
        isAgentBusy={isAgentBusy}
        steerCount={steerCount}
        followUpCount={followUpCount}
        queuePreview={queuePreview}
        saveError={saveError}
      />

      <FooterInput
        showFreeformInput={showFreeformInput}
        freeformLabel={freeformLabel}
        isInputEnabled={isInputEnabled}
        showSelectList={showSelectList}
      />

      {/* Command output panel (e.g. /help, /mcp) */}
      <CommandOutput />

      {/* Select list (ask_user options) */}
      {showSelectList && <SelectList />}

      {/* Autocomplete suggestions (idle typing) */}
      {!showSelectList && isInputEnabled && <AutocompleteList />}

      {/* Bottom status bar — mode, usage, model */}
      <FooterStatusBar />

      {/* Extension render surface — bottom-most region of the footer */}
      <FooterExtensionSurface />
    </FullBox>
  );
};
