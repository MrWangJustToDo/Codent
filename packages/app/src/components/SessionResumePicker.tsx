/**
 * Post-bootstrap resume picker via Session `session.list` / `session.resume`
 * (no SessionStore / ManagedAgent).
 */

import { Box, Text } from "ink";
import { useEffect, useState } from "react";

import { bumpAgentUsage } from "../hooks/use-agent-usage.js";
import { useConfig } from "../hooks/use-config.js";
import { useDynamic } from "../hooks/use-dynamic.js";
import { COLORS } from "../theme/colors.js";

import { SessionPicker } from "./SessionPicker.js";
import { Spinner } from "./Spinner.js";

import type { SessionListItem } from "../utils/session-list-item.js";
import type { AgentSession } from "@codent/core";

interface SessionResumePickerProps {
  session: AgentSession;
}

export const SessionResumePicker = ({ session }: SessionResumePickerProps) => {
  const [sessions, setSessions] = useState<SessionListItem[] | null>(null);
  const [loadError, setLoadError] = useState("");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const listed = await session.dispatch({ type: "session.list" });
        if (cancelled) return;
        if (!listed.ok) {
          setLoadError(listed.error);
          useConfig.getActions().setConfig("resumeSession", "");
          return;
        }
        const rows =
          (listed.data as { sessions?: SessionListItem[] } | undefined)?.sessions
            ?.slice()
            .sort((a, b) => b.updatedAt - a.updatedAt) ?? [];
        if (rows.length === 0) {
          useConfig.getActions().setConfig("resumeSession", "");
          return;
        }
        setSessions(rows);
      } catch (err) {
        if (cancelled) return;
        setLoadError(err instanceof Error ? err.message : String(err));
        useConfig.getActions().setConfig("resumeSession", "");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [session]);

  if (loadError) {
    return (
      <Box padding={1}>
        <Text color={COLORS.danger}>Error loading sessions: {loadError}</Text>
      </Box>
    );
  }

  if (!sessions) {
    return (
      <Box padding={1}>
        <Spinner text="Loading sessions..." />
      </Box>
    );
  }

  return (
    <SessionPicker
      sessions={sessions}
      onSelect={async (item) => {
        const result = await session.dispatch({ type: "session.resume", sessionId: item.id });
        if (!result.ok) {
          setLoadError(result.error);
          return;
        }
        // The core session emits the restored transcript through `messages`.
        bumpAgentUsage();
        setTimeout(() => {
          useDynamic.getActions().setDynamicKey(Date.now());
        }, 200);
        useConfig.getActions().setConfig("resumeSession", "");
      }}
      onCancel={() => {
        useConfig.getActions().setConfig("resumeSession", "");
      }}
    />
  );
};
