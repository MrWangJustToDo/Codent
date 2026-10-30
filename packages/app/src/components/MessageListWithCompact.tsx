import { memo, useMemo } from "react";

import { useAgentStatus } from "../hooks/use-agent-status";
import { useCompactSummaryText } from "../hooks/use-compact-summary-text";
import { formatCompactionSummaryContent } from "../utils/compaction-summary.js";

import { MessageList } from "./MessageList";

import type { UIMessage } from "@tanstack/ai";

export const MessageViewWithCompact = memo(({ messages }: { messages: UIMessage[] }) => {
  const status = useAgentStatus((s) => s.status);

  const isCompacting = status === "compacting";

  const { text: compactSummaryText } = useCompactSummaryText({ enabled: isCompacting });

  const displayMessages = useMemo(() => {
    if (!isCompacting || !compactSummaryText) return messages;
    // Inject a synthetic user message to render the streaming compact summary
    // identically to the final checkpoint: wrapped with the same markers so it
    // matches isCompactionSummaryUIMessage and renders as CompactionSummaryView
    // (previously a leading phase label broke the startsWith match and the
    // streaming phase was misrendered as a plain user message).
    const synthetic: UIMessage = {
      id: "compact-streaming",
      role: "user",
      parts: [{ type: "text", content: formatCompactionSummaryContent(compactSummaryText) }],
    };
    return [...messages, synthetic];
  }, [messages, isCompacting, compactSummaryText]);

  return <MessageList messages={displayMessages} />;
});

MessageViewWithCompact.displayName = "MessageViewWithCompact";
