#!/usr/bin/env node
/**
 * Unified CLI host bootstrap — single source of truth for both the development
 * host (`@codent/cli` bin) and the self-contained release host (`codent-cli`).
 *
 * Everything that is host logic lives here exactly once:
 *
 *   loadEnv → version/help → ACP intercept → parseCliArgs
 *           → CoreEnv plane → Provider plane → config-editor gate
 *           → LocalAgentAdapter → render(App)
 *
 * The only thing that differs between the two hosts is whether the remote
 * planes are available. `@codent/server/client` (`createRemoteEnv` and the
 * remote AgentSession host) is NOT imported here — it is injected by the caller
 * via {@link CliHostServerFactories}. The self-contained release host omits it
 * (its bundle must stay free of `@codent/server`), so the remote env/session
 * planes degrade with a clear error instead of importing server code.
 * `--remote-provider` needs no injection: `createRemoteProvider` lives in
 * `@codent/core` (global fetch only), so every host can carry it.
 */

import {
  AdapterProvider,
  App,
  ConfigEditor,
  CoreEnvProvider,
  InputScopeProvider,
  initConfig,
  initHighlighter,
  configureEnv,
  useConfig,
  useSize,
  useWorkspaceInfo,
  isAlternateScreenActive,
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

import type { AgentSessionHost, CoreEnv, ModelProvider } from "@codent/core";
import type { Instance } from "ink";

/**
 * Remote-plane factories the host CAN reach. Injected by hosts that bundle
 * `@codent/server/client` (the dev `@codent/cli`); omitted by the release host.
 */
export interface CliHostServerFactories {
  /** Build a remote CoreEnv for a server URL (`--remote-env` / remote-session workspace). */
  createRemoteEnv(url: string): Promise<CoreEnv>;
  /** Build a remote AgentSession host for a server URL (`--remote-session`). */
  createRemoteAgentSessionHost(opts: { baseUrl: string }): AgentSessionHost;
}

export interface CliHostOptions {
  /** Product/display name — purely cosmetic (help screen + OSC-0 terminal title). */
  productName: string;
  /** Remote-plane factories. Absent → remote env/session unavailable with a clear error. */
  server?: CliHostServerFactories;
}

/** CSI hide — re-sent after every frame so the hardware cursor stays off. */
const HIDE_NATIVE_CURSOR = "\x1b[?25l";

function hideNativeCursor(): void {
  const stdout = process.stdout;
  if (stdout.isTTY) {
    stdout.write(HIDE_NATIVE_CURSOR);
  }
}

/**
 * Bootstrap the CLI host and render the TUI. Resolves once the TUI is mounted;
 * the process stays alive via the ink renderer and exits through the adapter's
 * `exit` callback (or a fatal startup error).
 */
export async function bootstrapCliHost(options: CliHostOptions): Promise<void> {
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
  /** Set once the TUI mounts; the exit path unmounts through it so the alternate screen is left. */
  let inkInstance: Instance | undefined;

  // Cosmetic host identity — purely display: help screen + OSC-0 terminal title.
  appConfig.productName = options.productName;
  appConfig.acp = true;

  if (isHelpRequested(argv)) {
    useConfig.getActions().setHelpRequested(true);
  }

  const remoteEnv = appConfig.remoteEnv;
  const remoteSession = appConfig.remoteSession;
  const remoteProvider = appConfig.remoteProvider;

  // A remote plane requested without the factory that would serve it (release
  // host): fail loudly rather than silently dropping the flag.
  if (remoteEnv && !options.server?.createRemoteEnv) {
    console.error(
      `[${options.productName}] --remote-env is not available in this build (no @codent/server client). ` +
        `Use the development host (@codent/cli) for remote workspaces, or run without --remote-env.`
    );
    process.exit(1);
  }
  if (remoteSession && !options.server?.createRemoteAgentSessionHost) {
    console.error(
      `[${options.productName}] --remote-session is not available in this build (no @codent/server client). ` +
        `Use the development host (@codent/cli) for remote sessions, or run without --remote-session.`
    );
    process.exit(1);
  }

  // Boundary guard — the three remote planes are orthogonal on the client EXCEPT
  // `--remote-session`, which runs the whole agent loop server-side and therefore
  // cannot be combined with `--remote-env` / `--remote-provider` on the same
  // client. Local LLM settings travel to the server via `--model`; the server
  // itself may still register its own REMOTE_ENV / REMOTE_PROVIDER.
  if (remoteSession && (remoteEnv || remoteProvider)) {
    const conflicts = [remoteEnv ? "--remote-env" : "", remoteProvider ? "--remote-provider" : ""]
      .filter(Boolean)
      .join(" / ");
    console.error(
      `[${options.productName}] --remote-session cannot be combined with ${conflicts}: the agent loop runs server-side, so this client cannot also proxy its workspace or LLM keys.`
    );
    console.error(`  Use --model <id> to push local LLM settings to the server, or configure`);
    console.error(`  REMOTE_ENV / REMOTE_PROVIDER on the remote server itself.`);
    process.exit(1);
  }

  // CoreEnv plane — workspace fs/shell (`--remote-env` / REMOTE_ENV, or local).
  let coreEnv: CoreEnv;
  if (remoteEnv) {
    try {
      coreEnv = await options.server!.createRemoteEnv(remoteEnv);
      registerCoreEnv(coreEnv);
      console.log(`[${options.productName}] Connected to remote CoreEnv: ${remoteEnv} (rootPath=${coreEnv.rootPath})`);
    } catch (err) {
      console.error(`[${options.productName}] Failed to connect to remote CoreEnv at ${remoteEnv}`);
      console.error(`  ${err instanceof Error ? err.message : String(err)}`);
      console.error(`  Make sure the server is running: pnpm start:server`);
      process.exit(1);
    }
  } else if (remoteSession) {
    // Remote session: the agent runs on the server's CoreEnv, so the workspace
    // panel (file tree / preview / diff / git) must show the server's filesystem
    // too, not the CLI's local one. Reuse the same remote CoreEnv client as
    // `--remote-env`; an explicit `--remote-env` above still takes precedence.
    try {
      coreEnv = await options.server!.createRemoteEnv(remoteSession);
      registerCoreEnv(coreEnv);
      console.log(
        `[${options.productName}] Remote session: workspace CoreEnv from server ${remoteSession} (rootPath=${coreEnv.rootPath})`
      );
    } catch (err) {
      console.error(`[${options.productName}] Failed to connect to remote CoreEnv at ${remoteSession}`);
      console.error(`  ${err instanceof Error ? err.message : String(err)}`);
      console.error(`  Make sure the server is running: pnpm start:server`);
      process.exit(1);
    }
  } else {
    const useOsSandbox = (process.env.SANDBOX_ENV || "local") !== "native";
    coreEnv = createNodeEnv({ rootPath: process.cwd(), sandbox: useOsSandbox });
    registerCoreEnv(coreEnv);
  }

  // Remote session + no explicit `--model*` flag + no `--remote-provider`: defer
  // model resolution to the server's own `.env` provider instead of shipping local
  // defaults across the wire. Pass an explicit `--model` (or `--remote-provider`)
  // to keep model control client-side.
  if (remoteSession && !remoteProvider && !appConfig.modelExplicit) {
    appConfig.model = "";
    appConfig.style = undefined;
    appConfig.baseURL = undefined;
    appConfig.apiKey = undefined;
    appConfig.modelInfo = undefined;
    console.log(
      `[${options.productName}] Remote session: no explicit --model, deferring model to the server provider.`
    );
  }

  // Provider plane — local LLM keys from flags / `.env`, or remote keys held on
  // a `--remote-provider` server (orthogonal to CoreEnv). `createRemoteProvider`
  // is server-free (lives in core, global fetch only), so every host can carry it.
  let modelProvider: ModelProvider;
  if (remoteProvider) {
    try {
      modelProvider = await createRemoteProvider(remoteProvider);
      registerModelProvider(modelProvider);
      console.log(`[${options.productName}] Using remote model provider: ${remoteProvider}`);
    } catch (err) {
      console.error(`[${options.productName}] Failed to connect to remote model provider at ${remoteProvider}`);
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

  if (remoteSession) {
    console.log(`[${options.productName}] Remote Agent Session configured: ${remoteSession}`);
  }

  configureEnv({ allowNonBrowserUpdates: true });

  // First-run config detection: if no `.agents/config/models.json` exists, the
  // user passed no explicit model flags, and there is no remote provider/session
  // to supply MODEL, enter the config editor before initializing the session. The
  // editor writes a config via the same file source the unified pipeline reads,
  // so startup continues through the exact same load path as an existing config.
  const helpRequested = isHelpRequested(process.argv.slice(2));
  const needsConfigEditor =
    !helpRequested &&
    !remoteSession &&
    !remoteProvider &&
    !appConfig.modelExplicit &&
    !(await loadModelsConfigFromFile());

  if (!needsConfigEditor) {
    await initConfig(appConfig);
    await useWorkspaceInfo.getActions().init(coreEnv);
  }

  const adapter = new LocalAgentAdapter({
    exit: (report) => {
      // The terminal has to be restored either way: a bare `process.exit` strands it in the
      // alternate buffer, where the shell prompt is then drawn over a screen the user cannot
      // scroll. `unmount()` is what writes the leave-alt-screen sequence.
      // A panel that owns the alternate screen (the workspace browser) discards it on the way
      // out, so a report painted there would vanish. Leave the screen first, then print it
      // where the user can read and scroll it. The normal-screen path keeps the painted row.
      if (isAlternateScreenActive()) {
        try {
          inkInstance?.unmount();
        } catch {
          // already unmounted (double exit chord) — nothing to restore
        }
        if (report && report.length > 0) process.stdout.write(`\n${report.join("\n")}\n`);
        process.exit(0);
        return;
      }
      setTimeout(() => {
        try {
          inkInstance?.unmount();
        } catch {
          // already unmounted — nothing to restore
        }
        process.exit(0);
      }, 200);
    },
    readClipboardImage,
    env: coreEnv,
    provider: modelProvider,
    // Only the locally-built Node env is ours to destroy; a remote env is borrowed.
    ownsEnv: !remoteEnv && !remoteSession,
    ...(options.server?.createRemoteAgentSessionHost
      ? { createRemoteAgentSessionHost: options.server.createRemoteAgentSessionHost }
      : {}),
  });

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
      // The wizard replaces the chat screen, so it takes the `main` input scope. Without a scope its
      // handlers stay inert by design (`useSurfaceInput` never subscribes outside one) and the
      // first-run setup would not accept a single keystroke.
      return (
        <InputScopeProvider value="main">
          <ConfigEditor
            onDone={() => setReady(true)}
            onCancel={() => process.exit(0)}
            parseModelsConfig={parseModelsConfig}
            saveModelsConfig={saveModelsConfig}
          />
        </InputScopeProvider>
      );
    }
    return <App />;
  }

  useSize.getActions().init();

  // Last-resort restore for a path that exits without unmounting (fatal bootstrap error, a
  // signal, an external `process.exit`). Ink's own unmount already writes these; the sequences
  // are idempotent, and they matter when a panel owns the alternate screen at exit.
  process.once("exit", () => {
    if (!process.stdout.isTTY) return;
    try {
      process.stdout.write("\x1b[?1007h\x1b[?1049l\x1b[?25h");
    } catch {
      // stdout already closed
    }
  });

  initHighlighter()
    .then(() => {
      inkInstance = render(
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
        `[${options.productName}] Failed to initialize syntax highlighter:`,
        err instanceof Error ? err.message : String(err)
      );
      process.exit(1);
    });

  // The process stays alive via the ink renderer; it exits through the
  // adapter's `exit` callback. Nothing further to await here.
}
