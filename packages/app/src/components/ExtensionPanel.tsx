import { Box, Text, useInput } from "ink";
import { useEffect, useMemo, useState } from "react";
import { toRaw } from "reactivity-store";

import { useAgent } from "../hooks/use-agent.js";
import { useExtensionPanel } from "../hooks/use-extension-panel.js";
import { COLORS } from "../theme/colors.js";
import { listNavHint, pressEscToReturnHint } from "../utils/keyboard-labels.js";

import { PanelOverlay } from "./PanelOverlay.js";

import type { ExtensionInfo } from "@codent/core";

const ExtensionPanelList = ({
  infos,
  onToggle,
  onClose,
}: {
  infos: ExtensionInfo[];
  onToggle: (id: string) => void;
  onClose: () => void;
}) => {
  const [selectedIndex, setSelectedIndex] = useState(0);

  useInput((input, key) => {
    if (key.upArrow) {
      setSelectedIndex((i) => Math.max(0, i - 1));
      return;
    }
    if (key.downArrow) {
      setSelectedIndex((i) => Math.min(infos.length - 1, i + 1));
      return;
    }
    if ((key.return || input === " ") && infos[selectedIndex]) {
      onToggle(infos[selectedIndex]!.id);
      return;
    }
    if (key.escape) {
      onClose();
    }
  });

  if (infos.length === 0) {
    return (
      <Box flexDirection="column" paddingX={1} paddingY={1}>
        <Text bold color={COLORS.primary}>
          Extensions
        </Text>
        <Text color={COLORS.muted} dimColor>
          No extensions loaded.
        </Text>
        <Text color={COLORS.muted} dimColor>
          {pressEscToReturnHint()}
        </Text>
      </Box>
    );
  }

  const enabledCount = infos.filter((i) => i.enabled).length;

  return (
    <Box flexDirection="column" paddingX={1} paddingY={1}>
      <Box marginBottom={1}>
        <Text bold color={COLORS.primary}>
          Extensions
        </Text>
        <Text dimColor>
          {" "}
          ({enabledCount}/{infos.length} enabled)
        </Text>
        <Text dimColor> {listNavHint("toggle")}</Text>
      </Box>
      {infos.map((info, i) => {
        const isSelected = i === selectedIndex;
        const icon = info.enabled ? "✓" : "○";
        const iconColor = isSelected ? COLORS.primary : info.enabled ? COLORS.success : COLORS.muted;
        const detail = isSelected ? (
          <Box flexDirection="column" paddingLeft={3} marginBottom={1}>
            {info.description ? (
              <Text color={COLORS.muted} dimColor>
                {info.description.length > 80 ? `${info.description.slice(0, 80)}…` : info.description}
              </Text>
            ) : null}
            <Text color={COLORS.muted} dimColor>
              tools: {info.tools.length} · commands: {info.commands.length} · order: {info.order}
              {info.declaredOrder === undefined ? " (default)" : ""}
              {info.state === "inactive" ? " · disabled" : ""}
            </Text>
          </Box>
        ) : null;
        return (
          <Box key={info.id} flexDirection="column">
            <Box>
              <Text color={isSelected ? COLORS.primary : iconColor} bold={isSelected}>
                {isSelected ? "❯ " : "  "}
                {icon} {info.name}
              </Text>
              <Text color={COLORS.muted} dimColor>
                {" "}
                v{info.version}
                {info.state === "error" && info.error ? ` · ${info.error}` : ""}
              </Text>
            </Box>
            {detail}
          </Box>
        );
      })}
      <Box marginTop={1}>
        <Text color={COLORS.muted} dimColor>
          {pressEscToReturnHint()}
        </Text>
      </Box>
    </Box>
  );
};

/** Full-screen overlay for inspecting and toggling extensions. */
export const ExtensionPanel = () => {
  const view = useExtensionPanel((s) => s.view);
  const revision = useExtensionPanel((s) => s.revision);
  const { close, refresh } = useExtensionPanel.getActions();
  const session = toRaw(useAgent((s) => s.session));
  const [tick, setTick] = useState(0);

  useEffect(() => {
    setTick((n) => n + 1);
  }, [view, revision, session]);

  // Remote sessions only refresh `snapshot.extensions` via the protocol-level
  // `extensions` channel (no live getSnapshot()) — re-read the panel when it
  // arrives so toggles from any host propagate here. Local sessions re-read
  // live, so this is a harmless extra refresh.
  useEffect(() => {
    if (!session) return;
    return session.subscribe(
      (event) => {
        if (event.channel === "extensions") refresh();
      },
      { channels: ["extensions"] }
    );
  }, [session, refresh]);

  const infos = useMemo(() => {
    void tick;
    void view;
    void revision;
    return session?.getSnapshot().extensions.extensions ?? [];
  }, [session, view, revision, tick]);

  const handleToggle = async (id: string) => {
    if (!session) return;
    const info = session.getSnapshot().extensions.extensions.find((i) => i.id === id);
    if (!info) return;
    await session.dispatch({ type: "extension.toggle", id, enabled: !info.enabled });
    refresh();
  };

  return (
    <PanelOverlay open={view !== "closed"}>
      <ExtensionPanelList infos={infos} onToggle={handleToggle} onClose={close} />
    </PanelOverlay>
  );
};
