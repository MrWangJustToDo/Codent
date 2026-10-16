#!/usr/bin/env node
import {
  AdapterProvider,
  App,
  ConfigEditor,
  CoreEnvProvider,
  initConfig,
  initHighlighter,
  configureEnv,
  useConfig,
  useSize,
  useWorkspaceInfo,
} from "@codent/app";
import {
  createDirectModelProvider,
  createRemoteProvider,
  installAgentLogProcessGuards,
  loadModelsConfigFromFile,
  parseModelsConfig,
  registerCoreEnv,
  registerModelProvider,
  saveModelsConfig,
} from "@codent/core";
import { createNodeEnv } from "@codent/node";
import { config as loadEnv } from "dotenv";
import { render } from "ink";
import { useEffect, useState } from "react";

import { isAcpRequested, runAcpCommand } from "./acp-command.js";
import { cliVersion, isHelpRequested, isVersionRequested, parseCliArgs } from "./args.js";
import { readClipboardImage } from "./clipboard.js";
import { LocalAgentAdapter } from "./local-adapter.js";
import { TerminalTitle } from "./terminal-title.js";

import type { CoreEnv, ModelProvider } from "@codent/core";

// ============================================================================
// codent — local-only release host (remote-provider plane)
// ============================================================================
//
// Boot sequence (local CoreEnv, local or remote provider):
//   loadEnv → parseCliArgs → registerCoreEnv(createNodeEnv)
//           → registerModelProvider(direct | remote) → initConfig → render(App)
//
// The CoreEnv is always the local Node.js workspace. The model provider may be
// direct (flags / `.env`) or remote (`--remote-provider` / REMOTE_PROVIDER), in
// which case the provider server holds the LLM keys and the workspace stays on
// the local filesystem. `@codent/app` / `core` / `node` are inlined by tsdown,
// so the published package has no `@codent/*` runtime dependency.

const argv = process.argv.slice(2);

if (isVersionRequested(argv)) {
  console.log(cliVersion());
  process.exit(0);
}

loadEnv({ quiet: true });

// Land buffered agent-log entries (and any fatal error) on disk even when the
// process crashes or is hard-exited before the 250 ms batch flush fires.
installAgentLogProcessGuards();

// `codent acp` — headless Agent Client Protocol server. Intercepted before the
// TUI boots: stdout must carry only JSON-RPC frames (never a rendered transcript).
// Flags after the subcommand configure the model directly (`codent acp --model …`).
if (isAcpRequested(argv)) {
  const acpConfig = parseCliArgs(argv.slice(1));
  await runAcpCommand(
    acpConfig.modelExplicit || acpConfig.remoteProvider
      ? {
          model: acpConfig.model,
          style: acpConfig.style,
          baseURL: acpConfig.baseURL,
          apiKey: acpConfig.apiKey,
          ...(acpConfig.remoteProvider ? { remoteProvider: acpConfig.remoteProvider } : {}),
        }
      : undefined,
    // `--client-env` opts into borrowing the client's fs/terminal per session.
    { clientEnv: argv.includes("--client-env") }
  );
}

const appConfig = parseCliArgs(argv);

// Cosmetic host identity. Purely display: help screen + OSC-0 terminal title.
appConfig.productName = "codent";
appConfig.remotePlanes = false;
appConfig.acp = true;

if (isHelpRequested(argv)) {
  useConfig.getActions().setHelpRequested(true);
}

// CoreEnv plane — local Node.js workspace (fs / shell / OS sandbox).
const useOsSandbox = (process.env.SANDBOX_ENV || "local") !== "native";
const coreEnv: CoreEnv = createNodeEnv({ rootPath: process.cwd(), sandbox: useOsSandbox });
registerCoreEnv(coreEnv);

// Provider plane — local LLM keys from flags / `.env`, or remote keys held on
// a `--remote-provider` server (orthogonal to the local CoreEnv).
const modelProvider: ModelProvider = appConfig.remoteProvider
  ? await createRemoteProvider(appConfig.remoteProvider)
  : createDirectModelProvider({
      model: appConfig.model,
      style: appConfig.style,
      baseURL: appConfig.baseURL,
      apiKey: appConfig.apiKey,
    });
registerModelProvider(modelProvider);

configureEnv({ allowNonBrowserUpdates: true });

// First-run config detection: if no `.agents/config/models.json` exists, the
// user passed no explicit model flags, and there is no remote provider to
// supply MODEL, enter the config editor before initializing the session. The
// editor writes a config via the same file source the unified pipeline reads,
// so startup continues through the exact same load path as an existing config.
const helpRequested = isHelpRequested(process.argv.slice(2));
const needsConfigEditor =
  !helpRequested && !appConfig.remoteProvider && !appConfig.modelExplicit && !(await loadModelsConfigFromFile());

if (!needsConfigEditor) {
  await initConfig(appConfig);
  await useWorkspaceInfo.getActions().init(coreEnv);
}

const adapter = new LocalAgentAdapter({
  exit: () => {
    setTimeout(() => process.exit(0), 200);
  },
  readClipboardImage,
  env: coreEnv,
  provider: modelProvider,
});

/** CSI hide — re-sent after every frame so the hardware cursor stays off. */
const HIDE_NATIVE_CURSOR = "\x1b[?25l";

function hideNativeCursor(): void {
  const stdout = process.stdout;
  if (stdout.isTTY) {
    stdout.write(HIDE_NATIVE_CURSOR);
  }
}

/**
 * Startup gate. When a first-run config is required, show the ConfigEditor and
 * only initialize the session once it has been written; otherwise initConfig has
 * already run above and we render the main App directly.
 */
function Bootstrap() {
  const [ready, setReady] = useState(!needsConfigEditor);

  useEffect(() => {
    if (!needsConfigEditor || !ready) return;
    void initConfig(appConfig);
  }, [ready]);

  if (!ready) {
    return (
      <ConfigEditor
        onDone={() => setReady(true)}
        onCancel={() => process.exit(0)}
        parseModelsConfig={parseModelsConfig}
        saveModelsConfig={saveModelsConfig}
      />
    );
  }
  return <App />;
}

useSize.getActions().init();

initHighlighter()
  .then(() => {
    render(
      <CoreEnvProvider value={coreEnv}>
        <AdapterProvider value={adapter}>
          <TerminalTitle />
          <Bootstrap />
        </AdapterProvider>
      </CoreEnvProvider>,
      {
        maxFps: 30,
        exitOnCtrlC: false,
        renderProcess: true,
        onRender: hideNativeCursor,
        standardReactLayoutTiming: true,
      }
    );
  })
  .catch((err) => {
    console.error(
      "[codent] Failed to initialize syntax highlighter:",
      err instanceof Error ? err.message : String(err)
    );
    process.exit(1);
  });
