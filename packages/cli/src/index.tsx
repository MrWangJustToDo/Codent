#!/usr/bin/env node
import {
  AdapterProvider,
  App,
  ConfigEditor,
  initConfig,
  initHighlighter,
  configureEnv,
  useConfig,
  useSize,
  useWorkspaceInfo,
} from "@codent/app";
import {
  createDirectModelProvider,
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

import { cliVersion, isHelpRequested, isVersionRequested, parseCliArgs } from "./args.js";
import { readClipboardImage } from "./clipboard.js";
import { LocalAgentAdapter } from "./local-adapter.js";
import { TerminalTitle } from "./terminal-title.js";

import type { CoreEnv, ModelProvider } from "@codent/core";

const argv = process.argv.slice(2);

if (isVersionRequested(argv)) {
  console.log(cliVersion());
  process.exit(0);
}

loadEnv({ quiet: true });

// Land buffered agent-log entries (and any fatal error) on disk even when the
// process crashes or is hard-exited before the 250 ms batch flush fires.
installAgentLogProcessGuards();

const appConfig = parseCliArgs(argv);

if (isHelpRequested(argv)) {
  useConfig.getActions().setHelpRequested(true);
}

// Boundary guard — the three remote planes are orthogonal on the client EXCEPT
// `--remote-session`, which runs the whole agent loop server-side and therefore
// cannot be combined with `--remote-env` / `--remote-provider` on the same
// client. Local LLM settings travel to the server via `--model`; the server
// itself may still register its own REMOTE_ENV / REMOTE_PROVIDER.
if (appConfig.remoteSession && (appConfig.remoteEnv || appConfig.remoteProvider)) {
  const conflicts = [appConfig.remoteEnv ? "--remote-env" : "", appConfig.remoteProvider ? "--remote-provider" : ""]
    .filter(Boolean)
    .join(" / ");
  console.error(
    `[cli] --remote-session cannot be combined with ${conflicts}: the agent loop runs server-side, so this client cannot also proxy its workspace or LLM keys.`
  );
  console.error(`  Use --model <id> to push local LLM settings to the server, or configure`);
  console.error(`  REMOTE_ENV / REMOTE_PROVIDER on the remote server itself.`);
  process.exit(1);
}

// CoreEnv plane — workspace fs/shell (`--remote-env` / REMOTE_ENV)
const remoteEnv = appConfig.remoteEnv;
let coreEnv: CoreEnv;
if (remoteEnv) {
  try {
    const { createRemoteEnv } = await import("@codent/server/client");
    coreEnv = await createRemoteEnv(remoteEnv);
    registerCoreEnv(coreEnv);
    console.log(`[cli] Connected to remote CoreEnv: ${remoteEnv} (rootPath=${coreEnv.rootPath})`);
  } catch (err) {
    console.error(`[cli] Failed to connect to remote CoreEnv at ${remoteEnv}`);
    console.error(`  ${err instanceof Error ? err.message : String(err)}`);
    console.error(`  Make sure the server is running: pnpm start:server`);
    process.exit(1);
  }
} else if (appConfig.remoteSession) {
  // Remote session: the agent runs on the server's CoreEnv, so the workspace
  // panel (file tree / preview / diff / git) must show the server's filesystem
  // too, not the CLI's local one. Reuse the same remote CoreEnv client as
  // `--remote-env`; a explicit `--remote-env` above still takes precedence.
  try {
    const { createRemoteEnv } = await import("@codent/server/client");
    coreEnv = await createRemoteEnv(appConfig.remoteSession);
    registerCoreEnv(coreEnv);
    console.log(
      `[cli] Remote session: workspace CoreEnv from server ${appConfig.remoteSession} (rootPath=${coreEnv.rootPath})`
    );
  } catch (err) {
    console.error(`[cli] Failed to connect to remote CoreEnv at ${appConfig.remoteSession}`);
    console.error(`  ${err instanceof Error ? err.message : String(err)}`);
    console.error(`  Make sure the server is running: pnpm start:server`);
    process.exit(1);
  }
} else {
  const useOsSandbox = (process.env.SANDBOX_ENV || "local") !== "native";
  coreEnv = createNodeEnv({ rootPath: process.cwd(), sandbox: useOsSandbox });
  registerCoreEnv(coreEnv);
}

// Provider plane — LLM keys (`--remote-provider` / REMOTE_PROVIDER); orthogonal to CoreEnv
const remoteProvider = appConfig.remoteProvider;

// Remote session + no explicit `--model*` flag + no `--remote-provider`: defer
// model resolution to the server's own `.env` provider instead of shipping local
// defaults across the wire. Pass an explicit `--model` (or `--remote-provider`)
// to keep model control client-side.
if (appConfig.remoteSession && !remoteProvider && !appConfig.modelExplicit) {
  appConfig.model = "";
  appConfig.style = undefined;
  appConfig.baseURL = undefined;
  appConfig.apiKey = undefined;
  appConfig.modelInfo = undefined;
  console.log("[cli] Remote session: no explicit --model, deferring model to the server provider.");
}

let modelProvider: ModelProvider;
if (remoteProvider) {
  try {
    const { createRemoteProvider } = await import("@codent/server/client");
    modelProvider = await createRemoteProvider(remoteProvider);
    registerModelProvider(modelProvider);
    console.log(`[cli] Using remote model provider: ${remoteProvider}`);
  } catch (err) {
    console.error(`[cli] Failed to connect to remote model provider at ${remoteProvider}`);
    console.error(`  ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
} else {
  modelProvider = createDirectModelProvider({
    model: appConfig.model,
    style: appConfig.style,
    baseURL: appConfig.baseURL,
    apiKey: appConfig.apiKey,
  });
  registerModelProvider(modelProvider);
}

if (appConfig.remoteSession) {
  // Remote session plane is distinct from CoreEnv `--remote-env`. Full RemoteSessionClient
  // chat wiring can bind via `@codent/server/agent-session` when hosts opt in.
  console.log(`[cli] Remote Agent Session configured: ${appConfig.remoteSession}`);
}

configureEnv({ allowNonBrowserUpdates: true });

// First-run config detection (local hosts only): if no `.agents/config/models.json`
// exists and the user didn't pass explicit model flags (or a remote provider/session
// that supplies its own config), enter the config editor before initializing the
// session. The editor writes a config via the same file source the unified pipeline
// reads, so startup continues through the exact same load path as an existing config.
const helpRequested = isHelpRequested(process.argv.slice(2));
const needsConfigEditor =
  !helpRequested &&
  !appConfig.remoteSession &&
  !appConfig.remoteProvider &&
  !appConfig.modelExplicit &&
  !(await loadModelsConfigFromFile());

if (!needsConfigEditor) {
  await initConfig(appConfig);
  await useWorkspaceInfo.getActions().init();
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
      <AdapterProvider value={adapter}>
        <TerminalTitle />
        <Bootstrap />
      </AdapterProvider>,
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
    console.error("[cli] Failed to initialize syntax highlighter:", err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
