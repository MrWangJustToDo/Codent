import { Box, Text } from "ink";
import { useEffect, useState } from "react";
import { toRaw } from "reactivity-store";

import { Spinner } from "../components/Spinner.js";
import { useAgent } from "../hooks/use-agent.js";
import { useRetryTicker } from "../hooks/use-retry-ticker.js";
import { useSize } from "../hooks/use-size.js";
import { useUserInput } from "../hooks/use-user-input.js";
import { COLORS } from "../theme/colors.js";
import { formatDuration } from "../utils/format.js";
import { approvalKeysHint, busyQueueHint, freeformSubmitHint, selectListHint } from "../utils/keyboard-labels.js";
import { formatRetryStatus } from "../utils/retry-status.js";

import type { AgentRetryState, AgentStatus } from "@codent/core";

/**
 * Live LLM-retry visibility — single compact line (attempt counts + wait). The ticker
 * turns the scheduled backoff into a real countdown and flips the line to its in-flight
 * marker once the wait elapses, so "counting down" never reads as "request pending".
 */
const RetryStatus = ({ retry }: { retry: AgentRetryState }) => {
  const now = useRetryTicker(retry);
  return <Spinner text={formatRetryStatus(retry, now)} />;
};

/**
 * Context info bar above the input — shows status, shortcuts, queue counts and
 * inline errors. Subscribes to the session `state` channel so duration / retry /
 * error from the live snapshot stay fresh.
 */
export const FooterContextBar = ({
  status,
  isPendingApproval,
  showFreeformInput,
  showSelectList,
  isMultiSelect,
  cursorOnFreeform,
  isAgentBusy,
  steerCount,
  followUpCount,
  queuePreview,
  saveError,
}: {
  status: AgentStatus;
  isPendingApproval: boolean;
  showFreeformInput: boolean;
  showSelectList: boolean;
  isMultiSelect: boolean;
  cursorOnFreeform: boolean;
  isAgentBusy: boolean;
  steerCount: number;
  followUpCount: number;
  /** Head of the queue (see `utils/queue-preview`), or null when nothing is queued. */
  queuePreview?: string | null;
  saveError?: string;
}) => {
  // Prefer session snapshot for duration / error (no ManagedAgent).
  const session = toRaw(useAgent((s) => s.session));
  const [agentTick, setAgentTick] = useState(0);
  useEffect(() => {
    if (!session) return;
    return session.subscribe(
      () => {
        setAgentTick((n) => n + 1);
      },
      { channels: ["state"] }
    );
  }, [session]);
  const snap = agentTick >= 0 ? session?.getSnapshot() : undefined;
  const lastRunDurationMs = snap?.lastStreamDurationMs || 0;
  const _error = snap?.error || "";
  const retry = snap?.retry;

  // The queued line shares this row with the status text and must stay on ONE line: shrink the
  // preview to the room left instead of letting the row overflow / wrap.
  const screenWidth = useSize((s) => s.state.screenWidth);
  const queuePreviewMax = screenWidth > 0 ? Math.max(12, screenWidth - 52) : 28;

  const inputError = useUserInput((s) => s.inputError);
  const inputFeedback = useUserInput((s) => s.inputFeedback);

  const error = _error || inputError;

  const showSaveError = saveError && status !== "error" && status !== "aborted" && status !== "completed";

  return (
    <Box flexDirection="column" paddingX={1} gap={0}>
      <Box gap={2}>
        <Box gap={2} flexShrink={0}>
          {/* Status indicator */}
          {status === "running" && (!retry || retry.strategy === "reactive_compact") && <Spinner text="Running..." />}
          {status === "thinking" && (!retry || retry.strategy === "reactive_compact") && <Spinner text="Thinking..." />}
          {status === "responding" && (!retry || retry.strategy === "reactive_compact") && (
            <Spinner text="Responding..." />
          )}
          {status === "awaiting_user" && (
            <Text color={COLORS.primary} bold>
              Waiting
            </Text>
          )}
          {status === "compacting" && <Spinner text="Compacting..." />}
          {status === "completed" && (
            <Text color={COLORS.success}>
              {`Completed${lastRunDurationMs > 0 ? ` in ${formatDuration(lastRunDurationMs)}` : ""}`}
            </Text>
          )}
          {status === "aborted" && (
            <Text color={COLORS.muted} dimColor>
              Aborted
            </Text>
          )}
          {status === "waiting" && (
            <Text color={COLORS.warning} bold>
              Waiting
            </Text>
          )}
          {status === "idle" && (
            <Text color={COLORS.muted} dimColor>
              Ready
            </Text>
          )}
          {status === "error" && <Text color={COLORS.danger}>{error}</Text>}

          {/* LLM retry visibility — attempt counts + triggering error. Hidden for
              terminal statuses and for the interactive pauses (a stale retry must
              never render over an approval prompt / ask_user question). */}
          {retry &&
            status !== "error" &&
            status !== "aborted" &&
            status !== "completed" &&
            status !== "idle" &&
            status !== "waiting" &&
            status !== "awaiting_user" && <RetryStatus retry={retry} />}

          {inputFeedback && status !== "error" && (
            <Text
              color={
                inputFeedback.level === "error"
                  ? COLORS.danger
                  : inputFeedback.level === "success"
                    ? COLORS.success
                    : COLORS.primary
              }
              dimColor={inputFeedback.level === "info"}
            >
              {inputFeedback.message}
            </Text>
          )}

          {showSaveError && <Text color={COLORS.warning}>Save failed: {saveError}</Text>}

          {/* Contextual shortcuts */}
          {isAgentBusy && !isPendingApproval && !showFreeformInput && !showSelectList && (
            <Text color={COLORS.muted} dimColor wrap="truncate-end">
              {busyQueueHint(steerCount, followUpCount, queuePreview, { previewMax: queuePreviewMax })}
            </Text>
          )}
          {(steerCount > 0 || followUpCount > 0) && !isAgentBusy && !isPendingApproval && (
            <Text color={COLORS.primary} dimColor wrap="truncate-end">
              {queuePreview
                ? `Queued (${steerCount + followUpCount}): "${queuePreview}"`
                : `Queued: ${steerCount > 0 ? `${steerCount} steer` : ""}${
                    steerCount > 0 && followUpCount > 0 ? ", " : ""
                  }${followUpCount > 0 ? `${followUpCount} follow-up` : ""}`}
            </Text>
          )}
          {isPendingApproval && !showFreeformInput && (
            <Text color={COLORS.warning} dimColor>
              {approvalKeysHint()}
            </Text>
          )}
          {showFreeformInput && (
            <Text color={COLORS.warning} dimColor>
              {freeformSubmitHint()}
            </Text>
          )}
          {showSelectList && (
            <Text color={COLORS.primary} dimColor>
              {selectListHint({ multiSelect: isMultiSelect, cursorOnFreeform })}
            </Text>
          )}
        </Box>
      </Box>
    </Box>
  );
};
