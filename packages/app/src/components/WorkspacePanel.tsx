import { useApp } from "ink";
import { useEffect } from "react";

import { useWorkspacePanel } from "../hooks/use-workspace-panel.js";
import { setAlternateScreenActive, setAlternateScrollTranslation } from "../utils/alternate-screen.js";

import { PanelOverlay } from "./PanelOverlay.js";
import { WorkspaceFileMode } from "./WorkspaceFileMode.js";

export const WorkspacePanel = () => {
  const view = useWorkspacePanel((s) => s.view);
  const { setOptions } = useApp();

  // The browser is the one screen that owns the whole viewport: its tree/preview size
  // themselves to `screenHeight`, and while it is up the chat must not share the terminal's
  // scrollback with it. The alternate screen gives the panel a fixed viewport; leaving it makes
  // the renderer re-render the primary screen, which puts the chat back exactly where it was.
  //
  // A failure here is not fatal — without the switch the panel still renders (it did before),
  // it just shares the scrollback — so no error handling wraps the toggle.
  useEffect(() => {
    setOptions({ isAlternateBufferEnabled: true });
    setAlternateScreenActive(true);
    setAlternateScrollTranslation(false);
    return () => {
      setAlternateScrollTranslation(true);
      setAlternateScreenActive(false);
      setOptions({ isAlternateBufferEnabled: false });
    };
  }, [setOptions]);

  return (
    <PanelOverlay open={view === "workspace"}>
      <WorkspaceFileMode />
    </PanelOverlay>
  );
};
