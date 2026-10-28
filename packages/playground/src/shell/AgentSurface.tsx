import { AdapterProvider, App, CoreEnvProvider, configureEnv, initConfig, initHighlighter } from "@codent/app";
import {
  clearCoreEnv,
  clearModelProvider,
  createDirectModelProvider,
  createRemoteProvider,
  getEnv,
  hasCoreEnv,
  registerCoreEnv,
  registerModelProvider,
  errorMessage,
} from "@codent/core";
import { InkTerminalBox } from "@my-react/react-terminal/web";
import { WebglAddon } from "@xterm/addon-webgl";
import { memo, useCallback, useEffect, useRef, useState } from "react";

import { PlaygroundAgentAdapter } from "../adapters/playground-adapter.js";
import { usePlaygroundConfig } from "../hooks/use-playground-config.js";
import { useShellState } from "../hooks/use-shell-state.js";
import { Button } from "../ui/Button.js";
import { IconRefresh, IconWarning } from "../ui/icons.js";
import { State } from "../ui/State.js";
import { getWebContainerEnv } from "../webcontainer/create-env.js";
import { resolveFetchProxyUrl, setFetchProxyUrl } from "../webcontainer/create-proxy-fetch.js";

import type { AgentAdapter } from "@codent/app";
import type { CoreEnv, ModelProvider } from "@codent/core";

configureEnv({ allowNonBrowserUpdates: true });

/**
 * Owns the agent lifecycle and the terminal.
 *
 * The terminal instance is recreated by `InkTerminalBox` whenever `termOptions`
 * changes, so `fit` is a debounced breakpoint value (see `useTerminalFit`) and
 * must not be derived from raw resize or pane-drag events.
 *
 * `fit` deliberately reports the *wide* metrics on compact viewports so the
 * font size no longer varies with the breakpoint. Crossing the compact boundary
 * relocates this element (pane ⇄ sheet), which unmounts and remounts it, and a
 * font-size change at the same moment would double the churn. A single stable
 * size keeps that relocation the only remount, so the running agent survives it.
 */
export const AgentSurface = memo(() => {
  const model = usePlaygroundConfig((s) => s.model);
  const style = usePlaygroundConfig((s) => s.style);
  const baseURL = usePlaygroundConfig((s) => s.baseURL);
  const apiKey = usePlaygroundConfig((s) => s.apiKey);
  const providerServerUrl = usePlaygroundConfig((s) => s.providerServerUrl);
  const fetchProxyUrl = usePlaygroundConfig((s) => s.fetchProxyUrl);
  const { setBoot, setAgentRestart } = useShellState.getActions();

  const [adapter, setAdapter] = useState<AgentAdapter | null>(null);
  const [coreEnv, setCoreEnv] = useState<CoreEnv | null>(null);
  const adapterRef = useRef<AgentAdapter | null>(null);
  const containerReadyRef = useRef(false);
  const initIdRef = useRef(0);
  const boot = useShellState((s) => s.boot);

  const ensureCoreEnv = useCallback(async (): Promise<CoreEnv> => {
    setFetchProxyUrl(resolveFetchProxyUrl(fetchProxyUrl));

    if (hasCoreEnv()) return getEnv();

    const env = await getWebContainerEnv({ fetchProxyUrl });
    registerCoreEnv(env);
    containerReadyRef.current = true;
    return env;
  }, [fetchProxyUrl]);

  const runBootstrap = useCallback(async () => {
    const currentInitId = ++initIdRef.current;

    try {
      setBoot({ phase: "booting", message: containerReadyRef.current ? "Restarting agent…" : "Booting WebContainer…" });

      if (adapterRef.current) {
        await adapterRef.current.destroy();
        adapterRef.current = null;
        setAdapter(null);
      }

      setBoot({
        phase: "booting",
        message: containerReadyRef.current ? "Restarting agent…" : "Booting WebContainer…",
      });
      const env = await ensureCoreEnv();
      if (currentInitId !== initIdRef.current) return;
      setCoreEnv(env);

      const serverUrl = providerServerUrl.trim();
      const remoteMode = Boolean(serverUrl);
      let provider: ModelProvider;
      if (remoteMode) {
        // Remote mode: keys stay on the provider server; model/style/baseURL/apiKey come from /api/provider/info.
        setBoot({ phase: "booting", message: "Connecting to provider server…" });
        provider = await createRemoteProvider(serverUrl);
      } else {
        provider = createDirectModelProvider({ model, style, baseURL, apiKey });
      }
      registerModelProvider(provider);
      if (currentInitId !== initIdRef.current) return;

      setBoot({ phase: "booting", message: "Initializing agent…" });
      // Remote mode ignores local model/style/baseURL/apiKey (server is the single source of truth),
      // so only pass them in direct mode — otherwise the UI config would show the wrong model.
      await initConfig(remoteMode ? { model: "", style, baseURL: "", apiKey: "" } : { model, style, baseURL, apiKey });
      if (currentInitId !== initIdRef.current) return;

      await initHighlighter();
      if (currentInitId !== initIdRef.current) return;

      const playground = new PlaygroundAgentAdapter({ env, provider });

      adapterRef.current = playground;
      setAdapter(playground);
      setBoot({ phase: "ready", message: "Ready" });
    } catch (err) {
      if (currentInitId !== initIdRef.current) return;
      const message = errorMessage(err);
      setBoot({ phase: "error", message: "Initialization failed", error: message });
    }
  }, [model, style, baseURL, apiKey, providerServerUrl, fetchProxyUrl, ensureCoreEnv, setBoot]);

  useEffect(() => {
    setAgentRestart(() => () => void runBootstrap());
    return () => setAgentRestart(null);
  }, [runBootstrap, setAgentRestart]);

  useEffect(() => {
    void runBootstrap();
    return () => {
      if (adapterRef.current) {
        void adapterRef.current.destroy();
        adapterRef.current = null;
      }
      clearModelProvider();
      clearCoreEnv();
    };
  }, [runBootstrap]);

  if (boot.phase === "error") {
    return (
      <div className="workarea__state">
        <State
          icon={<IconWarning size={19} />}
          title="Could not start the playground"
          hint={boot.error}
          action={
            <Button variant="primary" icon={<IconRefresh size={13} />} onClick={() => void runBootstrap()}>
              Retry
            </Button>
          }
        />
      </div>
    );
  }

  if (!adapter || !coreEnv) {
    return (
      <div className="workarea__state">
        <State loading title={boot.message} hint="Preparing the in-browser workspace and agent runtime." />
      </div>
    );
  }

  return (
    <InkTerminalBox
      className="surface-terminal"
      style={{ height: "100%" }}
      termOptions={{ fontSize: 14, letterSpacing: 0, lineHeight: 1.2 }}
      inkRenderOptions={{ exitOnCtrlC: false }}
      onReady={(api) => {
        // Optional GPU acceleration. `activate()` throws on a host without WebGL2 (headless
        // Chrome, a blocked/blacklisted driver, software-rendering VMs); xterm falls back to
        // its DOM renderer, so the unhandled rejection is noise rather than a failure.
        try {
          api.term.loadAddon(new WebglAddon());
        } catch {
          // DOM renderer fallback — nothing to do.
        }
      }}
    >
      <CoreEnvProvider value={coreEnv}>
        <AdapterProvider value={adapter}>
          <App />
        </AdapterProvider>
      </CoreEnvProvider>
    </InkTerminalBox>
  );
});

AgentSurface.displayName = "AgentSurface";
