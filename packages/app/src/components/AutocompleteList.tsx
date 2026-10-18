import { Box, Text } from "ink";
import { useMemo } from "react";

import { useAutocomplete } from "../hooks/use-autocomplete.js";
import { COLORS } from "../theme/colors.js";

import { calcScrollOffset, ScrollableList } from "./ScrollableList.js";

import type { AutocompleteSuggestion } from "../hooks/use-autocomplete.js";

const MAX_VISIBLE = 11;

export const AutocompleteList = () => {
  const visible = useAutocomplete((s) => s.visible);
  const suggestions = useAutocomplete((s) => s.suggestions);
  const selectedIndex = useAutocomplete((s) => s.selectedIndex);

  const { scrollOffset, maxLabelWidth } = useMemo(() => {
    if (!visible || suggestions.length === 0) {
      return { scrollOffset: 0, maxLabelWidth: 8 };
    }
    const offset = calcScrollOffset(selectedIndex, suggestions.length, MAX_VISIBLE);
    const start = Math.max(0, Math.min(offset, suggestions.length - MAX_VISIBLE));
    const end = Math.min(start + MAX_VISIBLE, suggestions.length);
    const items = suggestions.slice(start, end);
    const labelWidth = Math.max(...items.map((s) => s.label.length), 8);
    return { scrollOffset: offset, maxLabelWidth: labelWidth };
  }, [visible, suggestions, selectedIndex]);

  if (!visible || suggestions.length === 0) return null;

  const renderItem = (suggestion: AutocompleteSuggestion, index: number) => {
    if (suggestion.separator) {
      return (
        <Text color={COLORS.muted} dimColor wrap="truncate">
          {"─".repeat(36)}
        </Text>
      );
    }
    const isSelected = index === selectedIndex;
    const label = suggestion.label.padEnd(maxLabelWidth + 2);
    const labelColor = suggestion.freeform ? COLORS.muted : COLORS.primary;
    // A submenu row is marked with a chevron so it reads as "opens a level", not "runs".
    const shown = suggestion.hasSubmenu ? `${label}›` : label;

    return (
      <Box flexDirection="row" width="100%">
        <Box width="40%" flexShrink={0} flexGrow={0}>
          <Text
            backgroundColor={isSelected ? COLORS.success : undefined}
            color={isSelected ? "black" : labelColor}
            bold={isSelected}
            dimColor={!isSelected && suggestion.freeform}
            wrap="truncate"
          >
            {shown}
          </Text>
        </Box>
        <Text color={isSelected ? "white" : COLORS.muted} dimColor={!isSelected} wrap="truncate">
          {suggestion.description}
        </Text>
      </Box>
    );
  };

  return (
    <Box flexDirection="column" paddingLeft={2}>
      <ScrollableList
        items={suggestions as AutocompleteSuggestion[]}
        maxVisible={MAX_VISIBLE}
        scrollOffset={scrollOffset}
        renderItem={renderItem}
      />
    </Box>
  );
};
