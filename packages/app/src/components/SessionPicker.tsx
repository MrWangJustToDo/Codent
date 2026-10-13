import { Box, Text, useInput } from "ink";
import { useMemo, useState } from "react";

import { useSize } from "../hooks/use-size.js";
import { COLORS } from "../theme/colors.js";
import { listNavHint } from "../utils/keyboard-labels.js";

import { calcScrollOffset, ScrollableList } from "./ScrollableList.js";

import type { SessionListItem } from "../utils/session-list-item.js";

/**
 * Rows shown at once. The window follows the cursor (`calcScrollOffset`), so this caps the
 * picker's height without capping how far the user can walk — a hard `slice(0, N)` is what let
 * the cursor leave the drawn set and made the arrows look dead.
 */
export const MAX_VISIBLE_SESSIONS = 10;

/** Reserve for the `(model, date)` meta so a long title truncates instead of pushing it out. */
const META_WIDTH_RATIO = 0.45;
/** Never let the meta eat the whole row on a narrow terminal. */
const MIN_TITLE_WIDTH = 16;

interface SessionPickerProps {
  sessions: SessionListItem[];
  onSelect: (session: SessionListItem) => void;
  onCancel: () => void;
}

export const SessionPicker = ({ sessions, onSelect, onCancel }: SessionPickerProps) => {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const screenWidth = useSize((s) => s.state.screenWidth);

  useInput((input, key) => {
    if (key.upArrow) {
      setSelectedIndex((i) => Math.max(0, i - 1));
    } else if (key.downArrow) {
      setSelectedIndex((i) => Math.min(sessions.length - 1, i + 1));
    } else if (key.return) {
      onSelect(sessions[selectedIndex]!);
    } else if (key.escape || input === "q") {
      onCancel();
    }
  });

  const scrollOffset = useMemo(
    () => calcScrollOffset(selectedIndex, sessions.length, MAX_VISIBLE_SESSIONS),
    [selectedIndex, sessions.length]
  );

  /**
   * Row split. The meta is the part that should survive — a title is recognisable from its
   * opening words, and a model name cut mid-token is not — so the title is the flexible side
   * and the meta is a fixed-width right column, both single-line and ellipsised (`truncate-end`).
   * This is the split `AutocompleteList` already uses.
   *
   * `screenWidth` is 0 until the host initialises `useSize` (the real app does it in `Agent`),
   * and a split computed from 0 would ellipsise every column down to a bare `…`. Fall back to a
   * nominal 80-column width instead; the hint after the title means it is initialised in practice.
   */
  const { titleWidth, metaWidth } = useMemo(() => {
    const width = screenWidth > 0 ? screenWidth : 80;
    const inner = Math.max(1, width - 4); // padding={1} both sides + the cursor column
    const meta = Math.min(Math.max(Math.floor(inner * META_WIDTH_RATIO), 0), Math.max(inner - MIN_TITLE_WIDTH, 0));
    return { titleWidth: Math.max(inner - meta, 1), metaWidth: meta };
  }, [screenWidth]);

  if (sessions.length === 0) {
    return (
      <Box flexDirection="column" padding={1}>
        <Text color={COLORS.warning}>No sessions found. Starting a new session.</Text>
      </Box>
    );
  }

  const renderItem = (session: SessionListItem, index: number) => {
    const isSelected = index === selectedIndex;
    const date = new Date(session.updatedAt).toLocaleString();
    return (
      <Box flexDirection="row" width="100%">
        <Box width={titleWidth + 2} flexShrink={0} flexGrow={0}>
          <Text color={isSelected ? COLORS.primary : undefined} bold={isSelected} wrap="truncate-end">
            {isSelected ? "❯ " : "  "}
            {session.name}
          </Text>
        </Box>
        <Box width={metaWidth} flexShrink={0} flexGrow={0}>
          <Text dimColor wrap="truncate-end">
            ({session.model}, {date})
          </Text>
        </Box>
      </Box>
    );
  };

  return (
    <Box flexDirection="column" padding={1}>
      <Box marginBottom={1}>
        <Text bold color={COLORS.primary}>
          Resume Session
        </Text>
        <Text dimColor> {listNavHint("select", "cancel")}</Text>
      </Box>

      <ScrollableList
        items={sessions}
        maxVisible={MAX_VISIBLE_SESSIONS}
        scrollOffset={scrollOffset}
        renderItem={renderItem}
      />
    </Box>
  );
};
