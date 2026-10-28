import { AdapterProvider, App, CoreEnvProvider, configureEnv, initConfig, initHighlighter } from "@codent/app";
import {
  clearCoreEnv,
  clearModelProvider,
  createDirectModelProvider,
  registerCoreEnv,
  registerModelProvider,
} from "@codent/core";
import { createRemoteEnv, createRemoteProvider } from "@codent/server/client";
import { InkTerminalBox } from "@my-react/react-terminal/web";
import { useCallback, useEffect, useRef, useState } from "react";

import { ExtensionAgentAdapter } from "@/adapters/extension-adapter";
import { ConnectionGuard } from "@/components/ConnectionGuard";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { useServerConfig } from "@/hooks/useServerConfig";

import type { AgentAdapter } from "@codent/app";
import type { CoreEnv, ModelProvider } from "@codent/core";

configureEnv({ allowNonBrowserUpdates: true });

const AgentBootstrap = () => {
  const url = useServerConfig((s) => s.url);
  const model = useServerConfig((s) => s.model);
  const style = useServerConfig((s) => s.style);
  const baseURL = useServerConfig((s) => s.baseURL);
  const apiKey = useServerConfig((s) => s.apiKey);

  const [adapter, setAdapter] = useState<AgentAdapter | null>(null);
  const [coreEnv, setCoreEnv] = useState<CoreEnv | null>(null);
  const [error, setError] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const adapterRef = useRef<AgentAdapter | null>(null);
  const initIdRef = useRef(0);

  const runBootstrap = useCallback(async () => {
    const currentInitId = ++initIdRef.current;

    try {
      setLoading(true);
      setError("");

      if (adapterRef.current) {
        await adapterRef.current.destroy();
        adapterRef.current = null;
        setAdapter(null);
      }
      setCoreEnv(null);

      clearModelProvider();
      clearCoreEnv();

      const env = await createRemoteEnv(url);
      if (currentInitId !== initIdRef.current) return;
      registerCoreEnv(env);
      setCoreEnv(env);

      // Provider plane: local keys when apiKey is set; otherwise remote provider on the same host.
      const provider: ModelProvider = apiKey.trim()
        ? createDirectModelProvider({ model, style, baseURL, apiKey })
        : await createRemoteProvider(url);
      registerModelProvider(provider);
      if (currentInitId !== initIdRef.current) return;

      await initConfig({
        model,
        style,
        baseURL,
        apiKey,
      });
      if (currentInitId !== initIdRef.current) return;

      await initHighlighter();
      if (currentInitId !== initIdRef.current) return;

      const ext = new ExtensionAgentAdapter({ env, provider });

      adapterRef.current = ext;
      setAdapter(ext);
    } catch (err) {
      if (currentInitId !== initIdRef.current) return;
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (currentInitId === initIdRef.current) {
        setLoading(false);
      }
    }
  }, [url, model, style, baseURL, apiKey]);

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

  if (error) {
    return (
      <div className="flex h-full flex-col items-center justify-center bg-[#1e1e1e] p-8 text-[#d4d4d4]">
        <div className="flex max-w-sm flex-col items-center gap-4">
          <div className="flex h-12 w-12 items-center justify-center rounded-full bg-red-500/10">
            <svg
              width="22"
              height="22"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="text-red-400"
            >
              <circle cx="12" cy="12" r="10" />
              <line x1="15" y1="9" x2="9" y2="15" />
              <line x1="9" y1="9" x2="15" y2="15" />
            </svg>
          </div>
          <div className="text-center">
            <h2 className="text-sm font-medium text-[#e0e0e0]">Initialization Error</h2>
            <p className="mt-1 text-xs leading-relaxed text-[#888]">{error}</p>
          </div>
          <button
            onClick={runBootstrap}
            className="cursor-pointer rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white transition-all hover:bg-blue-500 active:scale-[0.98] active:bg-blue-700"
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  if (loading || !adapter || !coreEnv) {
    return (
      <div className="flex h-full items-center justify-center gap-2.5 bg-[#1e1e1e] text-sm text-[#888]">
        <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-[#444] border-t-[#888]" />
        Initializing agent...
      </div>
    );
  }

  return (
    <InkTerminalBox style={{ height: "100%" }} inkRenderOptions={{ exitOnCtrlC: false }}>
      <CoreEnvProvider value={coreEnv}>
        <AdapterProvider value={adapter}>
          <App />
        </AdapterProvider>
      </CoreEnvProvider>
    </InkTerminalBox>
  );
};

export const SidepanelApp = () => {
  return (
    <div className="h-screen bg-[#1e1e1e] text-[#d4d4d4]">
      <ErrorBoundary>
        <ConnectionGuard>
          <AgentBootstrap />
        </ConnectionGuard>
      </ErrorBoundary>
    </div>
  );
};
