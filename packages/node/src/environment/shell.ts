/**
 * Cross-platform shell utilities for command execution.
 *
 * Provides:
 * - Shell detection (Linux, macOS, Windows with Git Bash detection)
 * - Process tree killing (SIGTERM → SIGKILL escalation)
 * - Detached child PID tracking for cleanup
 */

import { spawn, type ChildProcess } from "node:child_process";
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { platform } from "node:os";

// ============================================================================
// Shell Configuration
// ============================================================================

export interface ShellConfig {
  /** Path to the shell executable */
  shell: string;
  /** Arguments to pass for command execution (e.g., ["-l", "-c"]) */
  args: string[];
}

/**
 * Detect the platform and return the appropriate shell configuration.
 *
 * Resolution order:
 * 1. Explicit `shellPath` parameter
 * 2. `SHELL` environment variable
 * 3. Platform default (/bin/bash on macOS/Linux, Git Bash or PowerShell on Windows)
 */
export async function getShellConfig(shellPath?: string): Promise<ShellConfig> {
  const isWindows = platform() === "win32";

  if (shellPath) {
    return {
      shell: shellPath,
      args: isWindows && !shellPath.includes("bash") ? ["-c"] : ["-l", "-c"],
    };
  }

  const envShell = process.env.SHELL;

  if (envShell) {
    return {
      shell: envShell,
      args: isWindows && !envShell.includes("bash") ? ["-c"] : ["-l", "-c"],
    };
  }

  if (isWindows) {
    const gitBashPath = await findGitBash();
    if (gitBashPath) {
      return { shell: gitBashPath, args: ["-l", "-c"] };
    }
    return { shell: "powershell.exe", args: ["-Command"] };
  }

  return { shell: "/bin/bash", args: ["-l", "-c"] };
}

/**
 * Try to find Git Bash on Windows.
 * Checks common installation paths.
 */
export async function findGitBash(): Promise<string | undefined> {
  const candidates = [
    "C:\\Program Files\\Git\\bin\\bash.exe",
    "C:\\Program Files (x86)\\Git\\bin\\bash.exe",
    `${process.env.USERPROFILE}\\AppData\\Local\\Programs\\Git\\bin\\bash.exe`,
  ];

  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      continue;
    }
  }

  return undefined;
}

/**
 * Get the default shell environment variables for spawned processes.
 * Inherits from process.env with any necessary sanitization.
 */
export function getShellEnv(): NodeJS.ProcessEnv {
  return { ...process.env };
}

// ============================================================================
// Process Tree Management
// ============================================================================

/** Tracked detached child PIDs for lifecycle management */
const trackedPids = new Set<number>();

/**
 * Track a detached child process PID so it can be cleaned up later.
 * Call {@link untrackDetachedChildPid} when the process completes normally.
 */
export function trackDetachedChildPid(pid: number): void {
  trackedPids.add(pid);
}

/**
 * Stop tracking a detached child process PID.
 */
export function untrackDetachedChildPid(pid: number): void {
  trackedPids.delete(pid);
}

/**
 * Get all currently tracked PIDs.
 */
export function getTrackedPids(): number[] {
  return Array.from(trackedPids);
}

/**
 * Kill a process and its entire process tree.
 *
 * Strategy:
 * 1. Send SIGTERM to the process group (negative PID) on Unix
 * 2. Fall back to SIGTERM on the process itself
 * 3. Force SIGKILL after 5 seconds if the process hasn't exited
 *
 * On Windows, uses `taskkill /T /F` for tree killing since negative PID
 * signals are not supported.
 */
export async function killProcessTree(pid: number, signal: "SIGTERM" | "SIGKILL" = "SIGTERM"): Promise<void> {
  if (platform() === "win32") {
    await killProcessTreeWindows(pid);
    return;
  }

  try {
    // Negative PID = process group kill (includes all children)
    process.kill(-pid, signal);
  } catch {
    // Process group may not exist; fall back to single process
    try {
      process.kill(pid, signal);
    } catch {
      // Process may already be dead
    }
  }
}

/**
 * Kill a process tree on Windows using `taskkill`.
 */
async function killProcessTreeWindows(pid: number): Promise<void> {
  return new Promise((resolve) => {
    const child = spawn("taskkill", ["/T", "/F", "/PID", String(pid)], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    child.on("close", () => resolve());
    child.on("error", () => resolve());

    // Timeout the taskkill call after 5 seconds
    setTimeout(() => resolve(), 5000);
  });
}

// ============================================================================
// Process Execution (Spawn Wrapper)
// ============================================================================

export interface SpawnOptions {
  /** Working directory */
  cwd: string;
  /** Environment variables */
  env?: NodeJS.ProcessEnv;
  /** Abort signal for cancellation */
  signal?: AbortSignal;
  /** Timeout in seconds (if undefined, no timeout) */
  timeout?: number;
  /** Called with stdout data chunks */
  onStdout?: (data: string) => void;
  /** Called with stderr data chunks */
  onStderr?: (data: string) => void;
  /** Custom shell path override */
  shellPath?: string;
}

export interface SpawnResult {
  exitCode: number | null;
  timedOut: boolean;
}

export interface SpawnShellStringOptions extends SpawnOptions {
  /** When true, `command` is passed to the shell as a single string (for pre-wrapped sandbox commands). */
  useShellString?: boolean;
}

/**
 * Spawn a command in the platform shell without awaiting exit.
 * Used for background jobs (`CoreEnv.startCommand`).
 */
export async function spawnDetachedCommand(
  command: string,
  options: SpawnShellStringOptions
): Promise<DetachedSpawnHandle> {
  const isWindows = platform() === "win32";

  try {
    await access(options.cwd, constants.F_OK);
  } catch {
    throw new Error(`Working directory does not exist: ${options.cwd}`);
  }

  let child: ChildProcess;
  if (options.useShellString) {
    child = spawn(command, {
      shell: true,
      cwd: options.cwd,
      detached: !isWindows,
      env: options.env ?? getShellEnv(),
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
  } else {
    const { shell, args } = await getShellConfig(options.shellPath);
    child = spawn(shell, [...args, command], {
      cwd: options.cwd,
      detached: !isWindows,
      env: options.env ?? getShellEnv(),
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
  }

  if (child.pid) {
    trackDetachedChildPid(child.pid);
  }

  child.stdin?.destroy();

  if (options.onStdout && child.stdout) {
    child.stdout.on("data", (data: Buffer) => {
      options.onStdout?.(data.toString("utf-8"));
    });
  }

  if (options.onStderr && child.stderr) {
    child.stderr.on("data", (data: Buffer) => {
      options.onStderr?.(data.toString("utf-8"));
    });
  }

  const exited = new Promise<number | null>((resolve, reject) => {
    child.once("error", (err) => {
      if (child.pid) untrackDetachedChildPid(child.pid);
      reject(err);
    });
    child.once("close", (code) => {
      if (child.pid) untrackDetachedChildPid(child.pid);
      resolve(code);
    });
  });

  const kill = async (): Promise<void> => {
    if (!child.pid) return;
    await killProcessTree(child.pid, "SIGTERM");
    setTimeout(() => {
      if (child.pid) {
        void killProcessTree(child.pid, "SIGKILL");
      }
    }, 5000);
  };

  return { pid: child.pid ?? undefined, kill, exited };
}

export interface DetachedSpawnHandle {
  pid?: number;
  kill: () => Promise<void>;
  /** Resolves with exit code when the process closes; rejects on spawn error. */
  exited: Promise<number | null>;
}

/**
 * Spawn a command in the platform shell with proper process tree management.
 *
 * Features:
 * - Cross-platform shell resolution
 * - Process tree tracking for cleanup
 * - Abort signal support with full tree kill
 * - Timeout with SIGTERM → SIGKILL escalation
 * - Streaming stdout/stderr via callbacks
 */
export async function spawnCommand(command: string, options: SpawnShellStringOptions): Promise<SpawnResult> {
  const isWindows = platform() === "win32";

  // Verify working directory exists
  try {
    await access(options.cwd, constants.F_OK);
  } catch {
    throw new Error(`Working directory does not exist: ${options.cwd}`);
  }

  // Check for pre-existing abort
  if (options.signal?.aborted) {
    throw new Error("aborted");
  }

  let child: ChildProcess;
  if (options.useShellString) {
    child = spawn(command, {
      shell: true,
      cwd: options.cwd,
      detached: !isWindows,
      env: options.env ?? getShellEnv(),
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
  } else {
    const { shell, args } = await getShellConfig(options.shellPath);
    child = spawn(shell, [...args, command], {
      cwd: options.cwd,
      detached: !isWindows,
      env: options.env ?? getShellEnv(),
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
  }

  // Track the child PID
  if (child.pid) {
    trackDetachedChildPid(child.pid);
  }

  let timedOut = false;
  let timeoutHandle: NodeJS.Timeout | undefined;
  let isAborted = false;

  // Create an abort handler that kills the process tree
  const onAbort = () => {
    isAborted = true;
    if (child.pid) {
      killProcessTree(child.pid, "SIGTERM").then(() => {
        // Force kill after 5 seconds
        setTimeout(() => {
          if (child.pid) {
            killProcessTree(child.pid, "SIGKILL");
          }
        }, 5000);
      });
    }
  };

  try {
    // Set timeout if provided
    if (options.timeout !== undefined && options.timeout > 0) {
      timeoutHandle = setTimeout(() => {
        timedOut = true;
        onAbort();
      }, options.timeout * 1000);
    }

    // Stream stdout
    if (options.onStdout && child.stdout) {
      child.stdout.on("data", (data: Buffer) => {
        options.onStdout?.(data.toString("utf-8"));
      });
    }

    // Stream stderr
    if (options.onStderr && child.stderr) {
      child.stderr.on("data", (data: Buffer) => {
        options.onStderr?.(data.toString("utf-8"));
      });
    }

    // Handle abort signal
    if (options.signal) {
      if (options.signal.aborted) {
        onAbort();
      } else {
        options.signal.addEventListener("abort", onAbort, { once: true });
      }
    }

    // Wait for the process to finish (waitForChildProcess handles spawn errors via child.on("error")).
    // Pass the caller timeout so the internal safety guard, a last resort for a process that never
    // exits, is scaled past the caller's own deadline and cannot race it (see waitForChildProcess).
    const safetyTimeoutMs =
      options.timeout !== undefined && options.timeout > 0
        ? Math.max(MIN_SAFETY_TIMEOUT_MS, options.timeout * 1000 + SAFETY_TIMEOUT_MARGIN_MS)
        : undefined;
    const exitCode = await waitForChildProcess(child, safetyTimeoutMs);

    // Check if abort happened during execution
    if (options.signal?.aborted) {
      throw new Error("aborted");
    }

    if (timedOut) {
      throw new Error(`timeout:${options.timeout}`);
    }

    return { exitCode, timedOut };
  } catch (err) {
    if (err instanceof Error) {
      if (err.message === "aborted" || (options.signal?.aborted && !isAborted)) {
        throw new Error("aborted");
      }
      if (err.message.startsWith("timeout:")) {
        throw err; // re-throw timeout as-is
      }
    }
    throw err;
  } finally {
    // Cleanup
    if (child.pid) {
      untrackDetachedChildPid(child.pid);
    }
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
    if (options.signal) {
      try {
        options.signal.removeEventListener("abort", onAbort);
      } catch {
        // Signal may have been aborted already
      }
    }
  }
}

/**
 * Minimum safety timeout (ms) used when no caller timeout is provided.
 *
 * This is the last-resort guard for a process that has not **exited** (`waitForChildProcess` judges
 * completion on the child's `exit` event; the "a descendant keeps `close` open after exit" case is
 * handled by the drain grace, not here). It must not be reached by a legitimate command: `run_command`
 * supplies a default deadline of its own, and a caller with a known deadline passes
 * `max(MIN_SAFETY_TIMEOUT_MS, callerTimeoutMs + SAFETY_TIMEOUT_MARGIN_MS)` so the guard scales with
 * the deadline instead of racing it.
 */
const MIN_SAFETY_TIMEOUT_MS = 30_000;

/** Extra slack (ms) added on top of the caller timeout for the safety guard. */
const SAFETY_TIMEOUT_MARGIN_MS = 10_000;

/**
 * Bounded grace used in two places, both about not waiting forever on stdio:
 *
 * - after the process **exits**: give `close` a short window to drain the tail, then settle with the
 *   real exit code (a descendant holding the stdout pipe open after exit must not turn a finished
 *   command into a false "did not exit");
 * - after the safety guard **kills** a still-running process: give the streams a short window to
 *   deliver in-flight output before rejecting, so a caller joining the captured chunks afterwards
 *   has the complete partial output.
 */
const DRAIN_GRACE_MS = 2_000;

/**
 * Wait for a child process to exit. The "a detached descendant keeps the stdio pipes open" case is
 * handled by the drain grace below, not by waiting here.
 *
 * Completion is judged on the child's **exit** event. `close` (process gone AND streams drained) is
 * preferred, but a descendant that inherits the stdout pipe keeps `close` open after exit, so a
 * bounded {@link DRAIN_GRACE_MS} after exit settles with the REAL exit code — not a fabricated
 * failure. Resolving on `exit` alone would truncate the tail; the grace is what keeps trailing bytes.
 *
 * The `safetyTimeoutMs` parameter (defaults to {@link MIN_SAFETY_TIMEOUT_MS}) is the last-resort hang
 * guard for a process that never exits at all. It fires only while the process is still running
 * (never while draining after exit), kills the whole process tree, and rejects with a reason naming
 * the bound. When a caller deadline is known, pass
 * `max(MIN_SAFETY_TIMEOUT_MS, callerTimeoutMs + SAFETY_TIMEOUT_MARGIN_MS)` so the guard cannot race a
 * legitimate long command; `run_command` also supplies a default deadline of its own.
 */
export function waitForChildProcess(child: ChildProcess, safetyTimeoutMs?: number): Promise<number | null> {
  const bound = safetyTimeoutMs ?? MIN_SAFETY_TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    // Close stdin immediately since we don't write to it
    child.stdin?.destroy();

    let settled = false;
    let exited = false;
    let exitCode: number | null = null;
    let guardError: Error | undefined;
    const timers: { safety?: NodeJS.Timeout; drain?: NodeJS.Timeout } = {};

    const cleanup = () => {
      if (timers.safety) clearTimeout(timers.safety);
      if (timers.drain) clearTimeout(timers.drain);
      child.off("exit", onExit);
      child.off("close", onClose);
      child.off("error", onError);
    };
    const settle = (code: number | null) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(code);
    };
    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    };

    const onExit = (code: number | null) => {
      // After a guard kill the outcome is a rejection, owned by the guard's drain — do not resolve.
      if (guardError) return;
      exited = true;
      exitCode = code;
      // The process is done; give the pipes a short, bounded grace to flush the tail. A descendant
      // holding them open must not push this into the safety guard's "did not exit".
      timers.drain = setTimeout(() => settle(exitCode), DRAIN_GRACE_MS);
    };
    const onClose = (code: number | null) => {
      if (guardError) {
        fail(guardError);
        return;
      }
      // Process gone AND streams drained — the ideal settle. Prefer the real exit code if seen.
      settle(exited ? exitCode : code);
    };
    const onError = (err: Error) => fail(err);

    timers.safety = setTimeout(() => {
      // Only a process that has NOT exited is a hang. If it exited and we are merely draining the
      // pipes, the drain timer owns settling.
      if (settled || exited) return;
      guardError = new Error(
        `safety-timeout:command did not exit within ${bound}ms (still running); process tree killed`
      );
      if (child.pid) void killProcessTree(child.pid, "SIGKILL");
      // `kill` closes the pipes; give the streams a bounded window to deliver in-flight output before
      // rejecting, so a caller joining the captured chunks afterwards has the full partial output.
      timers.drain = setTimeout(() => {
        if (guardError) fail(guardError);
      }, DRAIN_GRACE_MS);
    }, bound);

    child.on("exit", onExit);
    child.on("close", onClose);
    child.on("error", onError);
  });
}
