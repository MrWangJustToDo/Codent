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
  beginRuntimeSuspend,
  useEditorHandoff,
} from "@codent/app";
import {
  createDirectModelProvider,
  createRemoteProvider,
  installAgentLogProcessGuards,
  loadModelsConfigFromFile,
  MAX_AGENT_ITERATIONS,
  parseModelsConfig,
  registerCoreEnv,
  registerModelProvider,
  saveModelsConfig,
  errorMessage,
} from "@codent/core";
import { createNodeEnv } from "@codent/node";
import { config as loadEnv } from "dotenv";
import { render } from "ink";
import { useEffect, useState } from "react";

import { isAcpRequested, runAcpCommand } from "./acp-command.js";
import { cliVersion, isHelpRequested, isVersionRequested, parseCliArgs, type ParsedCliConfig } from "./args.js";
import { readClipboardImage } from "./clipboard.js";
import { launchEditor } from "./editor.js";
import { LocalAgentAdapter } from "./local-adapter.js";
import { TerminalTitle } from "./terminal-title.js";

import type { EditorTarget } from "@codent/app";
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

/** Upper bound on teardown during exit; a hung hook must not keep the process alive. */
const EXIT_TEARDOWN_TIMEOUT_MS = 2000;

/**
 * Quiet window between releasing the renderer and printing the exit report.
 *
 * With `renderProcess` the last frame's bytes are written by the renderer's worker, so a write
 * issued in the same tick can land in the middle of a row. Short: nothing else is painted after
 * `unmount`, so this is a drain, not a race.
 */
const EXIT_REPORT_FLUSH_MS = 50;

/** CSI hide — re-sent after every frame so the hardware cursor stays off. */
const HIDE_NATIVE_CURSOR = "\x1b[?25l";

function hideNativeCursor(): void {
  const stdout = process.stdout;
  if (stdout.isTTY) {
    stdout.write(HIDE_NATIVE_CURSOR);
  }
}

/** Resolve the launch sandbox: explicit flag > `SANDBOX_ENV` > `local` (OS sandbox). */
function resolveSandboxMode(productName: string, value: string | undefined): "local" | "native" {
  if (value !== undefined && value !== "local" && value !== "native") {
    const detail = value === "" ? "requires a value" : `got "${value}"`;
    console.error(`[${productName}] --sandbox must be "local" (OS sandbox) or "native" (no OS sandbox); ${detail}.`);
    process.exit(1);
  }
  if (value) return value;
  return process.env.SANDBOX_ENV === "native" ? "native" : "local";
}

/**
 * Parse the command line, or print the parser's one-line message and exit.
 *
 * The parser is strict (`util.parseArgs`), so an unknown flag or a missing value is an error
 * instead of a silently ignored setting; this is the single place that turns it into a host error.
 */
function parseArgsForHost(productName: string, argv: string[]): ParsedCliConfig {
  try {
    return parseCliArgs(argv);
  } catch (error) {
    // `--help` wins over a broken command line: asking for help with a typo'd flag must render the
    // help screen (which reads only host defaults, not the flags), not an error. `--version` is
    // already answered before any parsing.
    if (isHelpRequested(argv)) return parseCliArgs(["--help"]);
    console.error(`[${productName}] ${errorMessage(error)}`);
    process.exit(1);
  }
}

/** Reject an iteration budget the schema would reject, with the bound the user can act on. */
function assertMaxIterations(productName: string, value: number): void {
  if (Number.isInteger(value) && value >= 1 && value <= MAX_AGENT_ITERATIONS) return;
  console.error(
    `[${productName}] --max-iterations must be an integer between 1 and ${MAX_AGENT_ITERATIONS} (got ${value}).`
  );
  process.exit(1);
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
  //
  // The ACP host has its own session seam, so this branch forwards the launch settings it can
  // honour: the model connection, `--system`, `--max-iterations`, `--max-concurrent-tasks`,
  // `--extension-dirs`, `--mcp-config` and the host version. `--resume` / `--continue` are
  // protocol-driven in ACP (the client chooses the session), so they are not forwarded.
  if (isAcpRequested(argv) && !isHelpRequested(argv)) {
    // Flags this shell declares but the ACP host cannot honour: sessions, workspace roots and resume
    // are negotiated by the ACP client, so forwarding them would be a silent drop — the same failure
    // the parser now refuses for unknown flags.
    const unsupported = argv
      .slice(1)
      .find((arg) => ["--remote-env", "-R", "--remote-session", "--continue", "-c", "--resume", "-r"].includes(arg));
    if (unsupported) {
      console.error(
        `[${options.productName}] codent acp does not take ${unsupported}: sessions, workspace roots and resume are negotiated by the ACP client.`
      );
      process.exit(1);
    }
    const acpConfig = parseArgsForHost(options.productName, argv.slice(1));
    assertMaxIterations(options.productName, acpConfig.maxIterations);
    const acpSandbox = resolveSandboxMode(options.productName, acpConfig.sandbox);
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
      {
        clientEnv: acpConfig.clientEnv === true,
        version: cliVersion(),
        sandbox: acpSandbox,
        ...(acpConfig.systemPrompt ? { systemPrompt: acpConfig.systemPrompt } : {}),
        maxIterations: acpConfig.maxIterations,
        ...(acpConfig.maxConcurrentTasks !== undefined ? { maxConcurrentTasks: acpConfig.maxConcurrentTasks } : {}),
        ...(acpConfig.extensionDirs?.length ? { extensionDirs: acpConfig.extensionDirs } : {}),
        ...(acpConfig.mcpConfigPath ? { mcpConfigPath: acpConfig.mcpConfigPath } : {}),
      }
    );
  }

  // Reached with a leading `acp` only via `codent acp --help` (the intercept above skips help): drop
  // the subcommand so it does not become the initial prompt.
  const appConfig = parseArgsForHost(options.productName, isAcpRequested(argv) ? argv.slice(1) : argv);
  assertMaxIterations(options.productName, appConfig.maxIterations);
  const sandboxMode = resolveSandboxMode(options.productName, appConfig.sandbox);
  /** Set once the TUI mounts; the exit path unmounts through it so the alternate screen is left. */
  let inkInstance: Instance | undefined;
  /**
   * Set by the explicit exit path once it has unmounted the renderer itself.
   *
   * The `process.once("exit")` restore below exists for paths that exit WITHOUT unmounting. When
   * the explicit path already ran, that restore is not a safety net — it is a duplicate, and the
   * screen-switch sequence it writes would be the last thing the process ever prints, right after
   * the exit report.
   */
  let terminalRestored = false;

  // Cosmetic host identity — purely display: help screen + OSC-0 terminal title.
  appConfig.productName = options.productName;
  // Capability-derived help gating. `acp` is truthful as a constant: the subcommand lives in this
  // shell, not in an injected factory. The remote env/session planes need `@codent/server/client`,
  // which the release host deliberately omits — advertising them there made `--help` list flags
  // that immediately exit(1). `--remote-provider` is NOT gated: it lives in core (global fetch).
  appConfig.acp = true;
  appConfig.remotePlanes = Boolean(options.server?.createRemoteEnv || options.server?.createRemoteAgentSessionHost);

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
      console.error(`  ${errorMessage(err)}`);
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
      console.error(`  ${errorMessage(err)}`);
      console.error(`  Make sure the server is running: pnpm start:server`);
      process.exit(1);
    }
  } else {
    coreEnv = createNodeEnv({ rootPath: process.cwd(), mode: sandboxMode === "native" ? "native" : "os" });
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
      console.error(`  ${errorMessage(err)}`);
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
    !(await loadModelsConfigFromFile(undefined, coreEnv));

  if (!needsConfigEditor) {
    await initConfig(appConfig);
    await useWorkspaceInfo.getActions().init(coreEnv);
  }

  /**
   * Render (or re-render) the TUI.
   *
   * A function rather than the single call it used to be: the editor handoff unmounts the app and
   * mounts it again, and both mounts must build the same tree.
   */
  function renderApp(): Instance {
    return render(
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
  }

  /**
   * Hand the terminal to the user's editor, then take it back.
   *
   * `beginRuntimeSuspend()` is what makes this not a shutdown: the app's unmount path would otherwise
   * dispose the runtime and its session, killing whatever run is in flight. With the flag set the
   * session survives the unmount, and the mount below re-binds it instead of building another one.
   */
  async function openInEditor(target: EditorTarget): Promise<void> {
    beginRuntimeSuspend();
    try {
      inkInstance?.unmount();
    } catch {
      // already unmounted — nothing to release
    }
    // Nothing may paint while the editor owns the terminal. Unmounting also leaves the alternate
    // screen and releases raw mode, which is exactly the handover the editor needs; the renderer is
    // re-created afterwards rather than asked to diff against a screen it no longer owns.
    try {
      const notice = await launchEditor(target);
      if (notice) useEditorHandoff.getActions().setNotice(notice);
    } finally {
      // A failed handoff must still leave a UI behind: the terminal was handed over, so a throw here
      // would strand the user on a blank screen with no way back.
      inkInstance = renderApp();
    }
  }

  const adapter = new LocalAgentAdapter({
    // The terminal host prints the report itself, once the renderer has released the screen —
    // see `printsExitReport` on `AgentAdapter`.
    printsExitReport: true,
    exit: (report) => {
      // Teardown (`session:shutdown` → per-extension flush → deactivate → MCP/background kill) lives
      // behind `adapter.destroy()`; the app's unmount only fires it as `void`. Await it (bounded, so a
      // hung hook cannot keep the process alive) or the "guaranteed" exit flush is best-effort.
      void (async () => {
        await Promise.race([
          adapter.destroy().catch(() => {}),
          new Promise<void>((resolve) => setTimeout(resolve, EXIT_TEARDOWN_TIMEOUT_MS)),
        ]);

        // Release the renderer FIRST, then print the report on the terminal it handed back.
        //
        // The report used to be painted into the last frame (the app's `ExitSummary` row) and left
        // there, on the assumption that the last frame survives the exit. It does not reach the
        // user as the final screen: `unmount()` restores the terminal, and the process-exit
        // restore below (which is there for paths that never unmount) then wrote a screen-switch
        // sequence as the LAST bytes of the process — after the summary and after anything the
        // frame printed. Printing the report here, with that restore suppressed, is what makes the
        // report the final content rather than a row that the teardown erases a beat later.
        //
        // The workspace panel owns the alternate screen while it is up, and a report written into
        // it is discarded with it. Read the ownership BEFORE unmounting (the panel's own cleanup
        // clears the flag) and leave the screen explicitly, so the order is leave → print rather
        // than "leave, whenever the renderer gets to it, around the report".
        const ownsAlternateScreen = isAlternateScreenActive();
        try {
          inkInstance?.unmount();
        } catch {
          // already unmounted (double exit chord) — nothing to restore
        }
        if (ownsAlternateScreen && process.stdout.isTTY) {
          try {
            process.stdout.write("\x1b[?1049l");
          } catch {
            // stdout already closed — nothing to restore
          }
        }
        terminalRestored = true;
        // One quiet beat: with `renderProcess` the final byte of the last frame is written by the
        // renderer's worker, so a write issued in the same tick can be interleaved mid-row.
        setTimeout(() => {
          if (report && report.length > 0) process.stdout.write(`\n${report.join("\n")}\n`);
          process.exit(0);
        }, EXIT_REPORT_FLUSH_MS);
      })();
    },
    readClipboardImage,
    openInEditor,
    env: coreEnv,
    provider: modelProvider,
    // Only the locally-built Node env is ours to destroy; a remote env is borrowed.
    ownsEnv: !remoteEnv && !remoteSession,
    // A remote workspace has no local file to edit. The capability stays wired so the panel can
    // explain the refusal in its footer instead of hiding the key without a reason.
    remoteWorkspace: Boolean(remoteEnv || remoteSession),
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
  // signal, an external `process.exit`). Ink's own unmount already writes the leave-alt-screen
  // sequence; the sequences are idempotent, and they matter when the workspace panel owns the
  // alternate screen at exit. `1007h` re-arms the wheel→arrow translation the panel switched on
  // (it is the terminal default, so this only matters for a terminal that starts with it off).
  process.once("exit", () => {
    if (!process.stdout.isTTY) return;
    // The explicit exit path already released the renderer and printed the report there; adding
    // this sequence after it would clear the screen the report was just written to.
    if (terminalRestored) return;
    try {
      process.stdout.write("\x1b[?1007h\x1b[?1049l\x1b[?25h");
    } catch {
      // stdout already closed
    }
  });

  initHighlighter()
    .then(() => {
      inkInstance = renderApp();
    })
    .catch((err) => {
      console.error(`[${options.productName}] Failed to initialize syntax highlighter:`, errorMessage(err));
      process.exit(1);
    });

  // The process stays alive via the ink renderer; it exits through the
  // adapter's `exit` callback. Nothing further to await here.
}
