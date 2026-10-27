import { toError } from "../../utils/errors.js";
// ============================================================================
// Agent Log Lifecycle Guards
// ============================================================================
//
// AgentLog's file sink is asynchronous and batch-flushed (see `attachFileSink`).
// On a crash or a hard `process.exit` the last buffered batch — which is usually
// exactly the error/abort that explains why the process is dying — would be lost.
// These guards close that window:
//
//   1. A registry of the agent logs that currently own a disk sink, so a
//      process-wide handler knows where to write.
//   2. Process-level handlers that record a fatal error into every active log
//      and then flush synchronously before the process goes down.
//   3. A `process.on("exit")` flush so a normal quit also drains the buffer.
//
// The same two exit moments also run the *extensions'* synchronous flush registrations
// (`ctx.registerExitFlush`): an extension that buffers state for persistence has the same window,
// and unlike a log it has no core-side registry to fall back on.

import type { AgentLog } from "./agent-log.js";

/**
 * Agent logs with an attached file sink. Managed by the agent lifecycle
 * (`bindSessionLogSink` registers, destroy unregisters), not by callers.
 */
const activeLogs = new Set<AgentLog>();

/** Track a log so crash/exit guards can flush it. Idempotent. */
export function registerActiveAgentLog(log: AgentLog): void {
  activeLogs.add(log);
}

/** Stop tracking a log (agent destroyed). Idempotent. */
export function unregisterActiveAgentLog(log: AgentLog): void {
  activeLogs.delete(log);
}

/**
 * Synchronously flush every tracked log's buffered entries. Never throws — a
 * failing flush must not break the shutdown path.
 */
export function flushActiveAgentLogsSync(): void {
  for (const log of activeLogs) {
    try {
      log.flushSync();
    } catch {
      // Non-fatal: log persistence must never break teardown.
    }
  }
}

/**
 * Synchronous exit flushes registered by extensions (`ctx.registerExitFlush`).
 *
 * Process-wide rather than per-agent because the path that needs them most — a hard exit with a
 * live session — never runs agent teardown, so there is no per-agent registry to consult.
 *
 * Two sets because order is the contract: a user flush commonly writes through `ctx.logger`, whose
 * entries only reach the file when the log sink is flushed. The sink's own flush is registered by
 * the built-in log extension at agent construction (i.e. FIRST), so a single insertion-ordered set
 * ran it before every user flush and silently dropped what they wrote. Finalizers always run last.
 */
const extensionExitFlushes = new Set<() => void>();
const extensionExitFinalizers = new Set<() => void>();

/**
 * Register an extension's synchronous exit flush. Returns the disposer (idempotent).
 *
 * `last: true` marks a finalizer (the log sink's own flush) that every ordinary flush must run
 * before.
 */
export function registerExtensionExitFlush(flush: () => void, options?: { last?: boolean }): () => void {
  const target = options?.last ? extensionExitFinalizers : extensionExitFlushes;
  target.add(flush);
  return () => {
    target.delete(flush);
  };
}

/**
 * Run every registered extension exit flush. Never throws: a failing flush is contained so it
 * cannot prevent the process from exiting.
 *
 * Ordinary flushes run first (they may append to an AgentLog), then the finalizers (the log sink),
 * so the state those flushes just wrote is what lands on disk.
 */
export function flushExtensionExitFlushesSync(): void {
  for (const flush of [...extensionExitFlushes]) {
    try {
      flush();
    } catch {
      // Non-fatal: a failing extension flush must not block the exit path.
    }
  }
  for (const flush of [...extensionExitFinalizers]) {
    try {
      flush();
    } catch {
      // Non-fatal: a failing sink flush must not block the exit path.
    }
  }
}

/** Minimal structural view of the host `process` — avoids depending on Node types. */
interface ProcessLike {
  on(event: string, listener: (...args: unknown[]) => void): void;
  exit(code?: number): void;
}

let guardsInstalled = false;

/**
 * Install process-level handlers so a crash (or a normal exit) still lands the
 * final buffered log entries — and the fatal error itself — on disk.
 *
 * Registered handlers:
 * - `uncaughtException` / `unhandledRejection`: write the error into every
 *   active log, flush synchronously, reprint to stderr (listeners suppress
 *   Node's default print), then exit(1) to preserve the crash semantics that
 *   exist when no handler is registered.
 * - `exit`: flush synchronously (the only hook that can still write on a hard
 *   `process.exit`).
 *
 * Idempotent, and a no-op in runtimes without a `process` (browser hosts).
 * Hosts that run the agent in-process (CLI / server) should call it
 * once at startup.
 */
export function installAgentLogProcessGuards(): void {
  if (guardsInstalled) return;
  const proc = (globalThis as { process?: ProcessLike }).process;
  if (!proc || typeof proc.on !== "function") return;
  guardsInstalled = true;

  let handlingFatal = false;

  const handleFatal = (kind: string, reason: unknown): void => {
    if (handlingFatal) return;
    handlingFatal = true;
    const error = toError(reason);
    try {
      // Listeners replace Node's default fatal print, so reproduce it here.
      console.error(`[agent] fatal ${kind}:`);
      console.error(error);
      for (const log of activeLogs) {
        try {
          log.error("system", `Fatal ${kind}`, error, { fatal: true, kind });
        } catch {
          // Non-fatal: keep trying the remaining logs.
        }
      }
      // Ordinary extension flushes first (they may write through `ctx.logger`), then the log
      // sink's finalizer inside the same call, then a last drain for logs the log extension does
      // not own. The previous order drained the logs BEFORE user flushes ran, so anything an exit
      // flush logged was left in the buffer.
      flushExtensionExitFlushesSync();
      flushActiveAgentLogsSync();
    } finally {
      proc.exit(1);
    }
  };

  proc.on("uncaughtException", (err) => handleFatal("uncaughtException", err));
  proc.on("unhandledRejection", (reason) => handleFatal("unhandledRejection", reason));
  proc.on("exit", () => {
    flushExtensionExitFlushesSync();
    flushActiveAgentLogsSync();
  });
}
