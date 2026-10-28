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
import { AGENT_DATA_DIR, defaultPath, ExecutionError } from "@codent/core";

import { toWirePath } from "./paths.js";

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

/** This project's own storage directory — never the client's business. */
const AGENT_STATE_DIR = AGENT_DATA_DIR;

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
  // The SAME resolution the wire uses (`paths.ts`), not a third spelling of it: "is this absolute?"
  // was being asked with `startsWith("/")` here and with `isAbsolute` on the wire.
  //
  // Scope, stated honestly because it is easy to overclaim: the two implementations were compared
  // over every root/target shape we could think of (POSIX, `..`, `//`, drive-letter, UNC, `.agents/**`)
  // and produced the SAME verdict in all of them, so this converges two spellings rather than fixing
  // a reachable bug — and for that reason no behavioral assertion can pin it (an untestable claim in
  // a validator is worse than a comment). The single divergence found needs `rootPath === ""`, which
  // `bootstrapLocalAcp` normalizing the root makes unreachable. `toWirePath` also preserves the
  // empty-root behaviour this function already had.
  const resolved = toWirePath(target, rootPath);
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
  /**
   * The ACP session every request is tagged with, or `undefined` before the session exists.
   *
   * A getter, not a value, and *nullable*, because of an ordering fact: `session/load` and
   * `session/resume` are told the id by the client, but `session/new` is not — core mints it inside
   * `host.create`, which is also the call that needs this env. During that call the env is asked to
   * read workspace files (the instruction file, `.lsp.json`, `.mcp.json`) that simply cannot be
   * tagged with a session id.
   *
   * `undefined` therefore means "serve this locally", not "fail": every client request needs an id,
   * so without one the only correct answer is the fallback. Throwing here is not an option — the
   * instruction loader catches a failed read and reports "no documentation file found", so a throw
   * silently costs every new session its project instructions.
   */
  sessionId: () => string | undefined;
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
  /**
   * Where requests ended up, by reason.
   *
   * `other` is deliberate local routing (byte reads, free-text commands, binary writes) — not a
   * capability gap, so it is not folded into `localNoCapability`.
   */
  readonly fallbackCounts: {
    /** Paths never sent to a client (`.agents/**`, outside the root). */
    localOnlyPath: number;
    /** Requests the client could have served but could not be asked: no capability, or no session yet. */
    localNoCapability: number;
    /** Deliberate local routing (byte reads, free-text commands, binary writes). */
    other: number;
  };
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
  const fallbackCounts = { localOnlyPath: 0, localNoCapability: 0, other: 0 };

  /**
   * Reasons whose path never leaves this process (`.agents/**`, outside the root).
   *
   * They are counted in `localOnlyPath` — not in `localNoCapability`, and not as a "capability gap"
   * line — because the client was never the intended route.
   */
  const PATHS_WE_NEVER_SEND = ["local-only-path"];
  /**
   * Reasons that are the DESIGNED route rather than a fallback worth a line each — the counters below
   * still record every decision, which is the tested contract; the line was only ever a duplicate.
   */
  const ROUTINE_REASONS = new Set([
    "local-only-path",
    "byte-read",
    "binary-write",
    "free-text-command",
    "no-session-yet",
  ]);
  /** Missing-capability routes already reported, so each is said once rather than per request. */
  const reportedMissingCapabilities = new Set<string>();
  const NO_CAPABILITY_REASONS = [
    "no-session-yet",
    "no-capability:readTextFile",
    "no-capability:writeTextFile",
    "no-capability:terminal",
  ];
  /**
   * Record a locally-served request: bucket it, then log only what a user can act on.
   *
   * The two counters mean different things and must not be merged: `localOnlyPath` counts paths
   * this env refuses to send (`.agents/**`, outside the root), while `localNoCapability` counts
   * requests the client *could* have served but did not — either because the capability is
   * missing, or because the session does not exist yet. Deliberate local routes (byte reads,
   * free-text commands) are neither: they are already in an "other" bucket, because reporting them
   * as a missing capability would make the matrix read as if the client were less capable than it
   * is.
   *
   * `no-session-yet` sits in `localNoCapability`, not in `localOnlyPath`, because the reason is
   * *when* the request happened, not *where* it pointed: the path would have gone to the client a
   * moment later. Filing it under the path bucket would make a startup read look like a guard hit.
   */
  const note = (reason: string): void => {
    if (PATHS_WE_NEVER_SEND.includes(reason)) fallbackCounts.localOnlyPath += 1;
    else if (NO_CAPABILITY_REASONS.includes(reason)) fallbackCounts.localNoCapability += 1;
    else fallbackCounts.other += 1;
    // The counter above is the machine-readable record; a line per request is a duplicate of it, and
    // for the DESIGNED routes it is noise that reads as a fault: `local-only-path` fires for every
    // `.agents/**` request, so loading one session printed ~50 WARN-tagged lines (reported as an
    // error). Only the reasons a user can act on — or an anomaly — get a line now.
    if (ROUTINE_REASONS.has(reason)) return;
    // A capability the client never declared is actionable once ("you did not enable terminal"), not
    // once per request on that route.
    if (reason.startsWith("no-capability:")) {
      if (reportedMissingCapabilities.has(reason)) return;
      reportedMissingCapabilities.add(reason);
      options.log?.(`client-env: ${reason} (this route stays local)`);
      return;
    }
    options.log?.(`client-env: ${reason}`);
  };

  /** True when this path must be served locally (counting the decision once). */
  const mustFallback = (target: string): boolean => {
    if (!isLocalOnlyPath(rootPath, target)) return false;
    note("local-only-path");
    return true;
  };

  /**
   * Whether the client can be asked anything at all right now.
   *
   * False before the session exists: every client request carries a `sessionId`, so a read during
   * `host.create` (the instruction file, `.lsp.json`, `.mcp.json`) has nowhere to go. It is served
   * locally and counted — see the factory contract on {@link AcpClientEnvOptions.sessionId}.
   */
  const hasSession = (): boolean => Boolean(sessionId());

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
    // At most ONE reason is recorded per request: `mustFallback` counts the path itself, so the
    // later conditions must not add a second note for the same read.
    if (mustFallback(target)) return fallback.fs.readFile(target);
    if (!caps.readTextFile || !hasSession()) {
      note(!caps.readTextFile ? "no-capability:readTextFile" : "no-session-yet");
      return fallback.fs.readFile(target);
    }
    // No `line` / `limit`: core's `readFile` has no line window (the `read_file` tool slices the
    // returned text itself), so sending them would invent a second, differently-anchored window.
    const response = (await client().request(methods.client.fs.readTextFile, {
      sessionId: sessionId(),
      path: toWirePath(target, rootPath),
    })) as ReadTextFileResponse;
    return response.content;
  }

  /**
   * Read a workspace text file through the client, or `undefined` when it cannot serve the path
   * (local-only path, no capability, no session yet, or the client rejected the read).
   *
   * `exists` / `stat` are derived from this because ACP exposes no metadata method: a successful
   * text read is proof the file exists, and its length is the best size we can get without one.
   */
  const clientReadText = async (target: string): Promise<string | undefined> => {
    if (mustFallback(target) || !caps.readTextFile || !hasSession()) return undefined;
    try {
      const response = (await client().request(methods.client.fs.readTextFile, {
        sessionId: sessionId(),
        path: toWirePath(target, rootPath),
      })) as ReadTextFileResponse;
      return response.content;
    } catch {
      return undefined;
    }
  };

  const fs: CoreEnvFs = {
    readFile,

    async writeFile(target: string, content: string | Uint8Array) {
      // At most ONE reason per request — `mustFallback` has already counted the path case.
      if (mustFallback(target)) {
        await fallback.fs.writeFile(target, content);
        return;
      }
      if (!caps.writeTextFile || !hasSession()) {
        note(!caps.writeTextFile ? "no-capability:writeTextFile" : "no-session-yet");
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
      await client().request(methods.client.fs.writeTextFile, {
        sessionId: sessionId(),
        path: toWirePath(target, rootPath),
        content,
      });
    },

    // `readFileRange` is intentionally ABSENT: it is defined in terms of byte offsets on our own
    // storage, which never reaches the client, and callers already degrade to a full read.

    // `appendFile` always serves paths the client never sees (`.agents/**`, outside the root), so it
    // is a pure pass-through. It is NOT cosmetic: the log sink refuses to attach at all when
    // `appendFile` is missing and degrades silently, so dropping it would cost the session its log
    // file — on a store that never leaves the process anyway.
    ...(fallback.fs.appendFile
      ? { appendFile: (target: string, content: string) => fallback.fs.appendFile!(target, content) }
      : {}),
    //
    // `rename` is NOT in that class, and forwarding it unconditionally was a latent defect this
    // guard closes.
    //
    // A whole-file rewrite is `writeFile(<sibling tmp>)` then `rename(tmp, target)` — that is what
    // `rename`'s own contract in `CoreEnvFs` is FOR. The write routes to the client (it is a
    // workspace text file) while the rename, being local, executed against OUR filesystem. That
    // "works" only while the client happens to write the same disk we do — a LOCAL editor. With a
    // genuinely remote client (Zed over SSH, a dev container, a different machine) the temp file
    // exists only on the client's disk, so the rename fails (ENOENT) or crosses devices (EXDEV) and
    // the temp file is left behind.
    //
    // So the atomic-replace path becomes unreachable exactly when it cannot work: with the write
    // routed away, `write_file` takes its documented direct-write branch and the client gets ONE
    // write of the real path.
    //
    // Honest about the cost: this is a CAPABILITY-level gate, not a path-level one. `fs.rename` going
    // away is visible to the whole env, so a LOCAL write under this flag also loses its atomic
    // replace — `.agents/**` included. Core documents that degradation itself
    // (`session-journal.ts`: "Without rename this degrades to a direct overwrite … best-effort"),
    // and its else-branch is a plain `writeFile`, so nothing is dropped: a folded log rewrite is
    // simply no longer crash-atomic. Doing better needs a path-aware question ("can this path be
    // replaced atomically?") in the CoreEnv contract — a core API change, deliberately not smuggled
    // in here.
    ...(fallback.fs.rename && !caps.writeTextFile
      ? { rename: (from: string, to: string) => fallback.fs.rename!(from, to) }
      : {}),
    // The sync trio is deliberately NOT forwarded: they exist for crash/exit paths on a host that
    // can write synchronously, and the sink already degrades to an async flush without them. A
    // client-backed session therefore loses nothing but the last-resort sync write.

    async stat(target: string) {
      // Local metadata first: it is cheap and carries a REAL mtime. A client-served read is only
      // needed for a file that exists solely on the client (a remote workspace).
      try {
        return await fallback.fs.stat(target);
      } catch {
        // Remote-only path: fall through to the client read.
      }
      const content = await clientReadText(target);
      if (content !== undefined) {
        return {
          isDirectory: false,
          isFile: true,
          // ACP v1 exposes no metadata method. The size is the length of the text we had to read;
          // the mtime is UNKNOWN, so use epoch rather than `new Date()` — a fabricated "now" would
          // make every freshness/TTL check believe the file was just updated.
          size: fallback.byteLength(content),
          mtime: new Date(0),
        };
      }
      // Preserve the local error (missing path / not a directory), like the old unconditional path.
      return await fallback.fs.stat(target);
    },

    async readdir(target: string) {
      // No client-side directory listing exists in ACP v1. A remote workspace therefore still
      // needs a local (or client-terminal) answer for `list_file` / `tree`; this is the documented
      // remaining local-only metadata operation.
      return await fallback.fs.readdir(target);
    },

    async mkdir(target: string) {
      // The client's write method creates parents on its own; a standalone mkdir has no client
      // counterpart, and our own directories are local by definition.
      await fallback.fs.mkdir(target);
    },

    async exists(target: string) {
      // Local answer first (no wire round-trip); ask the client only when the host does not have it.
      if (await fallback.fs.exists(target)) return true;
      const content = await clientReadText(target);
      return content !== undefined;
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
   *
   * `stderr` is always empty on this path: ACP exposes one merged terminal buffer, with no stream
   * to separate. A failing argv search therefore reports its message inside `stdout`, which is
   * acceptable only because the callers fall back on a non-zero `code` (or `killed`) rather than
   * parsing the text — see `exec-args.ts`.
   */
  const execFileViaTerminal = async (
    file: string,
    args: string[],
    execOptions?: CoreEnvExecFileOptions
  ): Promise<CoreEnvExecResult> => {
    // Never spawn for a run that is already over: the terminal would be killed immediately anyway,
    // and on a client that bills or displays terminals that is a visible artefact. `execArgs`
    // makes the same check for the same reason.
    if (execOptions?.signal?.aborted) {
      note("terminal-aborted");
      throw new ExecutionError("aborted", `${file} was cancelled`);
    }
    // No session yet ⇒ no client call is possible (every request carries a `sessionId`), so this
    // degrades exactly like the fs paths rather than sending `sessionId: undefined`. Unreachable on
    // today's create path — nothing spawns argv before a session exists — but the invariant is
    // "this can never fail", and an unbound call would break it at the first such caller.
    if (!hasSession()) {
      note("no-session-yet");
      if (fallback.execFile) return await fallback.execFile(file, args, execOptions);
      // No terminal to run in and no fallback that can spawn: report the shape `execArgs` already
      // understands as "unsupported" (`missing` ⇒ `execArgsCapture` returns undefined ⇒ the caller
      // falls back to its in-process implementation). Throwing would turn a degrade into a failure,
      // which is the thing this invariant exists to prevent.
      return { stdout: "", stderr: `${file} cannot run before the session exists`, code: null, missing: true };
    }
    const created = (await client().request(methods.client.terminal.create, {
      sessionId: sessionId(),
      command: file,
      args,
      ...(execOptions?.cwd ? { cwd: toWirePath(execOptions.cwd, rootPath) } : {}),
      ...(execOptions?.env ? { env: toEnvVariables(execOptions.env) } : {}),
    })) as CreateTerminalResponse;
    const terminalId = created.terminalId;
    try {
      let delay = POLL_INITIAL_MS;
      let output = "";
      let truncated = false;
      const deadline = Date.now() + (execOptions?.timeout ?? TERMINAL_DEADLINE_MS);
      let exitCode: number | null = null;
      let exitSignal: string | null = null;
      // Why the loop ended, when it did not end because the process did. Each of these produces a
      // result the caller must NOT read as a real one — see the return below.
      let endedBy: "exit" | "signal" | "aborted" | "timeout" | "truncated" = "exit";
      for (;;) {
        // Cancellation is checked every turn, not just at entry: this loop can run for the whole
        // deadline, and `execArgs` documents that a host which cannot be told the signal runs the
        // child to completion. Esc has to stop a grep, not wait ten minutes for it.
        if (execOptions?.signal?.aborted) {
          endedBy = "aborted";
          break;
        }
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
          exitSignal = snapshot.exitStatus.signal ?? null;
          // A signal-terminated process is not a normal exit even though the client sends an exit
          // status. Report it as killed so `execArgs` degrades instead of treating the partial
          // buffer as a complete result.
          if (exitSignal) {
            endedBy = "signal";
            break;
          }
          // A finished process is normally the end of it — but `truncated` is independent and can
          // be set on the same response (the process exited AND its buffer was clipped by the
          // client's byte limit). Running out of one byte limit is not the same as running out of
          // output, so the exit only ends the loop *cleanly* when the buffer is intact.
          endedBy = truncated ? "truncated" : "exit";
          break;
        }
        if (truncated) {
          endedBy = "truncated";
          break;
        }
        if (Date.now() >= deadline) {
          endedBy = "timeout";
          break;
        }
        await sleep(delay);
        delay = Math.min(delay * 2, POLL_MAX_MS);
      }

      if (endedBy === "exit") {
        return { stdout: output, stderr: "", code: exitCode };
      }
      if (endedBy === "signal") {
        // The process is already gone; only release it (in `finally`). Say WHY it was killed, like
        // the timeout/truncation branches and the local env's own failure text.
        return {
          stdout: output,
          stderr: `terminal process terminated by signal${exitSignal ? ` ${exitSignal}` : ""}`,
          code: exitCode,
          killed: true,
        };
      }

      // Everything else ended without the process telling us it finished, so `killed: true` is the
      // only honest answer: `execArgsCapture` maps `killed` to `undefined`, and its callers then
      // fall back to their in-process implementation. Returning the partial buffer instead would be
      // read as a complete result — an empty grep that looks like "no matches" rather than a
      // failure, which is the exact confusion `exec-args.ts` warns about.
      //
      // This is also why the child is killed rather than left to run: a released-but-running
      // terminal keeps consuming the client's resources with nobody reading it.
      await client()
        .request(methods.client.terminal.kill, { sessionId: sessionId(), terminalId })
        .catch(() => undefined);
      if (endedBy === "aborted") {
        note("terminal-aborted");
        // Aborts surface as an error, matching what the local env does for a cancelled command.
        throw new ExecutionError("aborted", `${file} was cancelled`);
      }
      if (endedBy === "timeout") {
        note("terminal-timeout");
        return { stdout: output, stderr: `${file} exceeded its time budget`, code: null, killed: true };
      }
      note("terminal-output-truncated");
      return {
        stdout: output,
        stderr: "terminal output truncated by the client",
        code: null,
        killed: true,
      };
    } finally {
      // Release even when the read threw: a leaked terminal outlives the run.
      await client()
        .request(methods.client.terminal.release, { sessionId: sessionId(), terminalId })
        .catch(() => undefined);
    }
  };

  const env: AcpClientEnv = {
    rootPath,
    // A pure query: it answers "would a write here leave the process" and must not touch the
    // counters, or every approval check would inflate the routing stats (and mix an approval
    // decision into a routing one). `isLocalOnlyPath` inline, not `mustFallback`.
    routesWriteToClient: (target: string) => caps.writeTextFile && !isLocalOnlyPath(rootPath, target),
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
    // Omitted (not defined-to-throw) when the client has no terminal, and equally before a session
    // exists: `execArgs` feature-detects on the member's presence, so absence is the "unsupported"
    // answer it already knows how to degrade from.
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
