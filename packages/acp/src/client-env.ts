/**
 * A `CoreEnv` whose filesystem and argv execution are borrowed from the ACP client (an editor's
 * native file/diff/terminal facilities) instead of our own local Node runtime.
 *
 * Three properties define this env, and each exists because the alternative has a concrete bad
 * outcome rather than a theoretical one:
 *
 * 1. **`.agents/**` and anything outside `rootPath` never reach the client.** The workspace's own
 *    storage (session logs, media, memory, plans, config) is what makes a conversation survive a
 *    restart. Handing it to the client means a client that declines — no user grant, path not in
 *    its visible workspace, a hidden directory policy — silently costs the agent its memory.
 *    `.agents` is ours, not the workspace's source; see {@link isLocalOnlyPath}.
 *
 * 2. **A missing client capability delegates, it never fails.** Tools feature-detect by *member
 *    existence* (`canExecArgs()` is literally `Boolean(env.execFile)`), so defining a member that
 *    always throws flips detection to "supported" and turns a graceful fallback into an exception.
 *    The lesson is already recorded in `packages/server/src/client.ts`. Optional members are
 *    therefore omitted (`execFile`, `readFileRange`), and `CoreEnvFs`'s required members delegate
 *    to the fallback.
 *
 * 3. **Only argv-shaped execution goes over the wire.** ACP's `terminal/create` takes
 *    `command` + `args` with no shell, so `exec` / `runCommand` (both free text) stay on the local
 *    fallback. That keeps command-safety's shell analysis and the actual execution on the *same*
 *    shell, instead of analysing one shell while handing the command to an unknown one.
 */

import {
  methods,
  type AgentContext,
  type CreateTerminalResponse,
  type ReadTextFileResponse,
  type TerminalOutputResponse,
} from "@agentclientprotocol/sdk";
import { defaultPath } from "@codent/core";

import type {
  CoreEnv,
  CoreEnvFs,
  CoreEnvExecFileOptions,
  CoreEnvExecResult,
  CommandResult,
  FileEntry,
  ResolvedCoreEnv,
  RunCommandOptions,
  StartCommandOptions,
} from "@codent/core";

/** The `.agents` directory name — this project's own storage, never the client's business. */
const AGENT_STATE_DIR = ".agents";

/** Bound on `terminal/output` polling: 20 ms doubling to 250 ms. */
const POLL_INITIAL_MS = 20;
const POLL_MAX_MS = 250;
/** Give up after this long without an exit status rather than polling forever. */
const TERMINAL_DEADLINE_MS = 10 * 60 * 1000;

/**
 * Whether a path must be served locally no matter what the client can do.
 *
 * Two categories, both deliberate:
 *
 * - **`.agents/**`** — our own state (see the module header). Matched by *path segment*, not by a
 *   prefix on the string, so both a relative `.agents/logs/...` and an absolute
 *   `/workspace/.agents/logs/...` are caught. A `startsWith(".agents")` test would miss the
 *   absolute form and — worse — would also match a legitimate workspace file named
 *   `.agentsomething`.
 * - **anything outside `rootPath`** — the client is asked to read workspace files; a traversal
 *   (`../secrets`) or an absolute path elsewhere is not workspace content, and the local env
 *   keeps whatever workspace constraint it already had.
 *
 * One definition, used by every fs method below: a per-method re-derivation would be the place
 * this invariant quietly rots.
 */
export function isLocalOnlyPath(rootPath: string, target: string): boolean {
  const resolved = target.startsWith("/") ? defaultPath.normalize(target) : defaultPath.resolve(rootPath, target);
  const root = defaultPath.normalize(rootPath);
  // Outside the workspace root (also catches `..` traversal).
  if (resolved !== root && !resolved.startsWith(`${root}/`)) return true;
  const relative = resolved === root ? "" : resolved.slice(root.length + 1);
  return relative === AGENT_STATE_DIR || relative.startsWith(`${AGENT_STATE_DIR}/`);
}

/** Which client capabilities this env may use (per-method, per the SDK's shape). */
export interface AcpClientCapabilities {
  readTextFile: boolean;
  writeTextFile: boolean;
  terminal: boolean;
}

export interface AcpClientEnvOptions {
  /** The agent-side connection handle; the env calls back through `client.request`. */
  client: () => AgentContext;
  /** The ACP session every request is tagged with (a getter: see the factory context). */
  sessionId: () => string;
  /** Workspace root (also the default command cwd). */
  rootPath: string;
  /** The complete local env that serves everything the client cannot. */
  fallback: ResolvedCoreEnv;
  caps: AcpClientCapabilities;
  /** Diagnostics sink — the capability matrix and every fallback decision land here. */
  log?: (message: string) => void;
}

export interface AcpClientEnv extends ResolvedCoreEnv {
  /** The capability matrix this env was built with (read by validation and README claims). */
  readonly clientCapabilities: AcpClientCapabilities;
  /** Number of clients routed locally rather than to the client, per reason. */
  readonly fallbackCounts: { localOnlyPath: number; noCapability: number };
  /**
   * Whether a write to `target` is the **client's** to authorise.
   *
   * The single definition of that question, and deliberately a method rather than a flag: a write
   * only moves authority when it actually leaves this process, which depends on both the path
   * (`.agents/**` and outside-root writes are ours) and the capability. A host that guessed from
   * the tool name alone would stop prompting for writes that never reached the client — dropping
   * the approval instead of delegating it.
   */
  routesWriteToClient(target: string): boolean;
}

/**
 * Build a client-backed env over a complete local `fallback`.
 *
 * The returned env is a `ResolvedCoreEnv`, so it can be handed straight to `CodentAgent.create`.
 */
export function createAcpClientEnv(options: AcpClientEnvOptions): AcpClientEnv {
  const { client, sessionId, rootPath, fallback, caps } = options;
  const fallbackCounts = { localOnlyPath: 0, noCapability: 0 };

  const note = (reason: string): void => {
    if (reason === "local-only-path") fallbackCounts.localOnlyPath += 1;
    else fallbackCounts.noCapability += 1;
    options.log?.(`client-env: ${reason}`);
  };

  /** True when this path must be served locally (counting the decision once). */
  const mustFallback = (target: string): boolean => {
    if (!isLocalOnlyPath(rootPath, target)) return false;
    note("local-only-path");
    return true;
  };

  // Two overloads mirroring `CoreEnvFs.readFile` — the encoding decides the return type, and a
  // single implementation signature cannot express that.
  async function readFile(target: string): Promise<string>;
  async function readFile(target: string, encoding: "buffer"): Promise<Uint8Array>;
  async function readFile(target: string, encoding?: string): Promise<string | Uint8Array> {
    // A BYTE read is always local, capability or not. The client method returns text, and decoding
    // it back to bytes is lossy for anything that is not valid UTF-8 — an image read through it
    // would reach the model as replacement characters instead of pixels. Callers asking for bytes
    // are asking for fidelity the client cannot provide, and `read_file`'s probe already treats a
    // failing byte read as "this host cannot return bytes" and degrades to a text read.
    if (encoding === "buffer") {
      note("byte-read");
      return fallback.fs.readFile(target, "buffer");
    }
    if (mustFallback(target) || !caps.readTextFile) {
      if (!caps.readTextFile) note("no-capability:readTextFile");
      return fallback.fs.readFile(target);
    }
    // No `line` / `limit`: core's `readFile` has no line window (the `read_file` tool slices the
    // returned text itself), so sending them would invent a second, differently-anchored window.
    const response = (await client().request(methods.client.fs.readTextFile, {
      sessionId: sessionId(),
      path: target,
    })) as ReadTextFileResponse;
    return response.content;
  }

  const fs: CoreEnvFs = {
    readFile,

    async writeFile(target: string, content: string | Uint8Array) {
      if (mustFallback(target) || !caps.writeTextFile) {
        if (!caps.writeTextFile) note("no-capability:writeTextFile");
        await fallback.fs.writeFile(target, content);
        return;
      }
      if (typeof content !== "string") {
        // The client's write method is text-only; binary payloads (media, images) are also the
        // kind of thing that belongs to our own storage, so delegating is both correct and safe.
        note("binary-write");
        await fallback.fs.writeFile(target, content);
        return;
      }
      await client().request(methods.client.fs.writeTextFile, { sessionId: sessionId(), path: target, content });
    },

    // `readFileRange` is intentionally ABSENT: it is defined in terms of byte offsets on our own
    // storage, which never reaches the client, and callers already degrade to a full read.

    // Optional members that always serve paths the client never sees (`.agents/**`, outside the
    // root), so they are pure pass-throughs. They are NOT cosmetic: the log sink refuses to attach
    // at all when `appendFile` is missing and degrades silently, so dropping this one would cost
    // the session its log file — on a store that never leaves the process anyway.
    ...(fallback.fs.appendFile
      ? { appendFile: (target: string, content: string) => fallback.fs.appendFile!(target, content) }
      : {}),
    ...(fallback.fs.rename ? { rename: (from: string, to: string) => fallback.fs.rename!(from, to) } : {}),
    // The sync trio is deliberately NOT forwarded: they exist for crash/exit paths on a host that
    // can write synchronously, and the sink already degrades to an async flush without them. A
    // client-backed session therefore loses nothing but the last-resort sync write.

    async stat(target: string) {
      // Required member: the client has no stat method at all, and directory/search tools depend on
      // it across the whole workspace, so it always delegates.
      return await fallback.fs.stat(target);
    },

    async readdir(target: string) {
      return await fallback.fs.readdir(target);
    },

    async mkdir(target: string) {
      // The client's write method creates parents on its own; a standalone mkdir has no client
      // counterpart, and our own directories are local by definition.
      await fallback.fs.mkdir(target);
    },

    async exists(target: string) {
      return await fallback.fs.exists(target);
    },

    async remove(target: string) {
      await fallback.fs.remove(target);
    },
  };

  /**
   * Run `file` with `args` through the client's terminal, returning the COMPLETE result.
   *
   * There is no incremental delivery here by construction: `execFile`'s contract is a full
   * `{ stdout, stderr, code }`, and the callers (glob/grep/tree) consume it that way. Output is
   * read by bounded polling — never a busy loop — and the terminal is always released.
   */
  const execFileViaTerminal = async (
    file: string,
    args: string[],
    execOptions?: CoreEnvExecFileOptions
  ): Promise<CoreEnvExecResult> => {
    const created = (await client().request(methods.client.terminal.create, {
      sessionId: sessionId(),
      command: file,
      args,
      ...(execOptions?.cwd ? { cwd: execOptions.cwd } : {}),
      ...(execOptions?.env ? { env: toEnvVariables(execOptions.env) } : {}),
    })) as CreateTerminalResponse;
    const terminalId = created.terminalId;
    try {
      let delay = POLL_INITIAL_MS;
      let output = "";
      let truncated = false;
      const deadline = Date.now() + (execOptions?.timeout ?? TERMINAL_DEADLINE_MS);
      let exitCode: number | null = null;
      for (;;) {
        const snapshot = (await client().request(methods.client.terminal.output, {
          sessionId: sessionId(),
          terminalId,
        })) as TerminalOutputResponse;
        // `output` is the terminal's buffer, not a delta — replacement, not accumulation. The
        // typical terminal contract leaves `exitStatus` unset until the process has ended, so the
        // exit status is what terminates the loop.
        output = snapshot.output;
        truncated = Boolean(snapshot.truncated);
        if (snapshot.exitStatus) {
          exitCode = snapshot.exitStatus.exitCode ?? null;
          break;
        }
        if (Date.now() >= deadline) break;
        await sleep(delay);
        delay = Math.min(delay * 2, POLL_MAX_MS);
      }
      if (truncated) {
        // `CoreEnvExecResult` has no truncation flag, and silently returning a clipped buffer would
        // read as a complete result. Say so on stderr (the callers surface it) and count it.
        note("terminal-output-truncated");
        return { stdout: output, stderr: "terminal output truncated by the client", code: exitCode };
      }
      return { stdout: output, stderr: "", code: exitCode };
    } finally {
      // Release even when the read threw: a leaked terminal outlives the run.
      await client()
        .request(methods.client.terminal.release, { sessionId: sessionId(), terminalId })
        .catch(() => undefined);
    }
  };

  const env: AcpClientEnv = {
    rootPath,
    routesWriteToClient: (target: string) => caps.writeTextFile && !mustFallback(target),
    path: fallback.path,
    byteLength: fallback.byteLength,
    base64Encode: fallback.base64Encode,
    base64Decode: fallback.base64Decode,
    fs,
    // Free-text execution is NOT routed to the client (see the module header): the local env is
    // the only thing that can answer `getShellInfo()`, so the shell command-safety analyses and
    // the shell that runs the command stay the same one.
    runCommand: (command: string, runOptions?: RunCommandOptions): Promise<CommandResult> => {
      note("free-text-command");
      return fallback.runCommand(command, runOptions);
    },
    exec: (command: string, execOptions) => {
      note("free-text-command");
      return fallback.exec(command, execOptions);
    },
    ...(caps.terminal ? { execFile: execFileViaTerminal } : {}),
    fetch: (input, init) => fallback.fetch(input, init),
    getPlatform: () => fallback.getPlatform(),
    getArch: () => fallback.getArch(),
    getEnv: () => fallback.getEnv(),
    homedir: () => fallback.homedir(),
    // The command default directory. Our free-text commands run on the fallback, so its answer is
    // the one that describes where commands actually run; a client terminal call passes an explicit
    // cwd anyway. Never `process.cwd()` — that diverges from the root the moment a host is given one.
    cwd: () => fallback.cwd(),
    ...(fallback.getShellInfo ? { getShellInfo: () => fallback.getShellInfo!() } : {}),
    // Background commands stay on the local runtime for the same reason the free-text ones do: they
    // run through a shell we analyse locally, and the client's terminal has no job-handle concept.
    ...(fallback.startCommand
      ? { startCommand: (c: string, o?: StartCommandOptions) => fallback.startCommand!(c, o) }
      : {}),
    // LSP, MCP stdio transports and the isolate driver need a local process runtime that the
    // client cannot provide. Omitting them keeps every feature-detect on its degrade path
    // (`createIsolateDriver` is the one member whose contract is to return `null`).
    ...(fallback.getMimeType ? { getMimeType: (p: string) => fallback.getMimeType!(p) } : {}),
    ...(fallback.commandExists ? { commandExists: (c: string) => fallback.commandExists!(c) } : {}),
    ...(fallback.locateTreeSitterGrammar
      ? { locateTreeSitterGrammar: (g: string) => fallback.locateTreeSitterGrammar!(g) }
      : {}),
    ...(fallback.resizeImage
      ? { resizeImage: (b: Uint8Array, o: { maxWidth?: number }) => fallback.resizeImage!(b, o) }
      : {}),
    ...(fallback.getMCPTransportProcess
      ? { getMCPTransportProcess: (t: unknown) => fallback.getMCPTransportProcess!(t) }
      : {}),
    clientCapabilities: caps,
    fallbackCounts,
  };
  return env;
}

/** Map core env vars onto ACP's `EnvVariable[]`. */
function toEnvVariables(env: Record<string, string | undefined>): Array<{ name: string; value: string }> {
  return Object.entries(env)
    .filter((entry): entry is [string, string] => typeof entry[1] === "string")
    .map(([name, value]) => ({ name, value }));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export type { CoreEnv, FileEntry };
