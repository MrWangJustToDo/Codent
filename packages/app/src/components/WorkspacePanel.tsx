import { useWorkspacePanel } from "../hooks/use-workspace-panel.js";

import { PanelOverlay } from "./PanelOverlay.js";
import { WorkspaceFileMode } from "./WorkspaceFileMode.js";

export const WorkspacePanel = () => {
  const view = useWorkspacePanel((s) => s.view);

  return (
    <PanelOverlay open={view === "workspace"}>
      <WorkspaceFileMode />
    </PanelOverlay>
  );
};
