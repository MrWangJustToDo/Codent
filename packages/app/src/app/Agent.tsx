import { ConfigEditorOverlay } from "../components/ConfigEditorOverlay.js";
import { ExitSummary } from "../components/ExitSummary.js";
import { ExtensionPanel } from "../components/ExtensionPanel.js";
import { FullBox } from "../components/FullBox.js";
import { MessageViewWithCompact } from "../components/MessageListWithCompact.js";
import { PlanReadyBanner } from "../components/PlanReadyBanner.js";
import { SessionResumePicker } from "../components/SessionResumePicker.js";
import { SubagentPanel } from "../components/SubagentPanel.js";
import { WorkspacePanel } from "../components/WorkspacePanel.js";
import { useAdapter } from "../context/adapter-context.js";
import { useAgentChat } from "../hooks/use-agent-chat.js";
import { useAgentInputControls } from "../hooks/use-agent-input-controls.js";
import { useAgent } from "../hooks/use-agent.js";
import { useConfigEditor } from "../hooks/use-config-editor.js";
import { useConfig } from "../hooks/use-config.js";
import { useExtensionPanel } from "../hooks/use-extension-panel.js";
import { useExtensionUIBridge } from "../hooks/use-extension-ui.js";
import { useFlattenCacheCleanup } from "../hooks/use-flatten-cache-cleanup.js";
import { useSize } from "../hooks/use-size.js";
import { useStatic } from "../hooks/use-static.js";
import { useSubagentPanel } from "../hooks/use-subagent-panel.js";
import { useWorkspacePanel } from "../hooks/use-workspace-panel.js";
import { Content } from "../layout/Content.js";
import { Footer } from "../layout/Footer.js";
import { Header } from "../layout/Header.js";
import { WelcomePanel } from "../layout/WelcomePanel.js";

import type { AppConfig } from "../adapter/types.js";

// ============================================================================
// Main Agent Component
// ============================================================================
export const Agent = () => {
  const adapter = useAdapter();

  useSize.getActions().useInitTerminalSize();

  const screenWidth = useSize((s) => s.state.screenWidth);

  useStatic.getActions().useInitStdout();

  // Root-level so it outlives the subagent panel: a destroyed agent's full-transcript
  // flatten snapshot is released even if the user already navigated away from its panel.
  useFlattenCacheCleanup();

  // The config store wraps state as DeepReadonly; downstream consumers
  // (useAgentChat → adapter.initialize → createAgentSessionFromConfig) treat it as a
  // mutable AppConfig. The store is the single owner, so a cast is safe here.
  const config = useConfig((s) => s.config) as AppConfig;

  const {
    messages,
    sendMessage,
    steer,
    followUp,
    forceSubmit,
    recallQueuedMessage,
    queuedMessages,
    isLoading,
    isReady,
    status,
    stop,
    addToolApprovalResponse,
    addToolOutput,
    setClientToolWaiting,
    initError,
    initLoading,
    allPendingApproval,
    allPendingAskUser,
    saveSessionFromChat,
    saveError,
  } = useAgentChat(config);

  const subagentPanelView = useSubagentPanel((s) => s.view);
  const subagentPanelOpen = subagentPanelView !== "closed";
  const workspaceView = useWorkspacePanel((s) => s.view);
  const workspaceOpen = workspaceView === "workspace";
  const extensionPanelView = useExtensionPanel((s) => s.view);
  const extensionPanelOpen = extensionPanelView !== "closed";
  const configEditorOpen = useConfigEditor((s) => s.view === "open");

  useExtensionUIBridge();

  const activeSession = useAgent((s) => s.session);
  const showResumePicker = config.resumeSession === "__picker__";

  useAgentInputControls({
    adapter,
    initialPrompt: config.initialPrompt,
    isReady,
    isLoading,
    initLoading,
    messages,
    sendMessage,
    steer,
    followUp,
    forceSubmit,
    recallQueuedMessage,
    queuedMessages,
    stop,
    addToolApprovalResponse,
    addToolOutput,
    setClientToolWaiting,
    allPendingApproval,
    allPendingAskUser,
    saveSessionFromChat,
  });

  // ============================================================================
  // Render
  // ============================================================================

  if (initError) {
    return <WelcomePanel variant="error" screenWidth={screenWidth} errorMessage={initError.message} />;
  }

  if (initLoading) {
    // The splash copy lives in `WelcomePanel`'s `loadingText` default — one place, so the label
    // and the default cannot drift. (A second literal here was how "Initializing sandbox…"
    // survived: the caller's explicit string shadowed the component's default.)
    return <WelcomePanel variant="loading" screenWidth={screenWidth} />;
  }

  if (showResumePicker && activeSession) {
    return <SessionResumePicker session={activeSession} />;
  }

  // `/settings config` — the model-config wizard, over the running app. It is a
  // full-screen swap like the panels below, and `isAnyPanelOpen()` keeps every
  // central keybinding off the keyboard while it is up (the editor owns input).
  if (configEditorOpen) {
    return <ConfigEditorOverlay />;
  }

  return (
    <FullBox flexDirection="column">
      <Header />
      {workspaceOpen ? (
        <WorkspacePanel />
      ) : subagentPanelOpen ? (
        <SubagentPanel />
      ) : extensionPanelOpen ? (
        <ExtensionPanel />
      ) : (
        <>
          <MessageViewWithCompact messages={messages} />
          <Content />
          <PlanReadyBanner />
          <Footer status={status} queuedMessages={queuedMessages} saveError={saveError} />
          {/* Last region of the normal screen, below the footer: the session's outcome, shown
              during the ~200ms between the quit and `process.exit`. */}
          <ExitSummary />
        </>
      )}
    </FullBox>
  );
};
