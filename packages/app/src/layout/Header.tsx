import { StaticRender } from "ink";
import { useEffect, useMemo } from "react";

import { useConfig } from "../hooks/use-config";
import { useSize } from "../hooks/use-size.js";
import { useStatic } from "../hooks/use-static";
import { useTheme } from "../hooks/use-theme";
import { useWorkspaceInfo } from "../hooks/use-workspace-info";

import { WelcomePanel } from "./WelcomePanel.js";

/** Remote planes active for this session (rendered as a badge under the logo title). */
export function remotePlanesFromConfig(remoteEnv?: string, remoteProvider?: string, remoteSession?: string): string[] {
  return [
    ...(remoteEnv ? ["remote-env"] : []),
    ...(remoteProvider ? ["remote-provider"] : []),
    ...(remoteSession ? ["remote-session"] : []),
  ];
}

// ============================================================================
// Header Component
// ============================================================================

/**
 * Side-effect-only renderer: builds the welcome panel and pushes it into Ink's
 * static output so it is written once at the top of the scrollback.
 */
export const Header = () => {
  const screenWidth = useSize((s) => s.state.screenWidth);
  const { git, path: workspacePath } = useWorkspaceInfo((s) => s.workspaceInfo);
  const remoteEnv = useConfig((s) => s.config.remoteEnv);
  const remoteProvider = useConfig((s) => s.config.remoteProvider);
  const remoteSession = useConfig((s) => s.config.remoteSession);

  const width = screenWidth;

  const theme = useTheme((s) => s.theme);

  const remotePlanes = useMemo(
    () => remotePlanesFromConfig(remoteEnv, remoteProvider, remoteSession),
    [remoteEnv, remoteProvider, remoteSession]
  );

  const headerKey = `${workspacePath}|${remotePlanes}|${Boolean(git)}`;

  useEffect(() => {
    if (!workspacePath) return;
    useStatic.getActions().setStaticHeader(
      <StaticRender
        key="header"
        width={width}
        deps={[headerKey, width, theme]}
        onRender={() => useStatic.getActions().setStaticHeaderReady(true)}
      >
        {() => (
          <WelcomePanel
            variant="ready"
            screenWidth={screenWidth}
            git={git || null}
            workspacePath={workspacePath}
            remotePlanes={remotePlanes}
          />
        )}
      </StaticRender>
    );
  }, [git, workspacePath, screenWidth, remotePlanes, width, headerKey, theme]);

  return null;
};
