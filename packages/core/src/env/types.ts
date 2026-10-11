/**
 * CoreEnv companion types — errors and fs/command result shapes.
 *
 * Used by {@link CoreEnv} and tools. Implementations live in `@codent/node` / server.
 */

// ============================================================================
// Typed Errors
// ============================================================================

/**
 * Stable, backend-independent file error codes returned by filesystem operations.
 */
export type FileErrorCode =
  | "not_found"
  | "permission_denied"
  | "not_directory"
  | "is_directory"
  | "invalid"
  | "not_supported"
  | "aborted"
  | "unknown";

/**
 * Typed error for filesystem operation failures.
 * Unlike plain Errors, these carry a structured error code for programmatic handling.
 *
 * @example
 * ```typescript
 * try {
 *   await getEnv().fs.readFile('/path');
 * } catch (err) {
 *   if (err instanceof FileError && err.code === 'not_found') {
 *     // Handle missing file gracefully
 *   }
 * }
 * ```
 */
export class FileError extends Error {
  /** Backend-independent error code */
  public code: FileErrorCode;
  /** Absolute addressed path associated with the failure, when available */
  public path?: string;

  constructor(code: FileErrorCode, message: string, path?: string, cause?: Error) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "FileError";
    this.code = code;
    this.path = path;
  }
}

/**
 * Stable, backend-independent execution error codes.
 */
export type ExecutionErrorCode =
  "aborted" | "timeout" | "shell_unavailable" | "spawn_error" | "callback_error" | "unknown";

/**
 * Typed error for command execution failures.
 *
 * @example
 * ```typescript
 * try {
 *   const result = await getEnv().runCommand('npm install', { timeout: 30000 });
 * } catch (err) {
 *   if (err instanceof ExecutionError && err.code === 'timeout') {
 *     // Handle timeout
 *   }
 * }
 * ```
 */
export class ExecutionError extends Error {
  /** Backend-independent error code */
  public code: ExecutionErrorCode;

  constructor(code: ExecutionErrorCode, message: string, cause?: Error) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "ExecutionError";
    this.code = code;
  }
}

// ============================================================================
// File System Types
// ============================================================================

/**
 * File entry returned by filesystem operations
 */
export interface FileEntry {
  name: string;
  type: "file" | "directory";
  /** File size in bytes (optional, may not be available in all environments) */
  size?: number;
  /** Last modification date (optional, may not be available in all environments) */
  modified?: Date;
}

/**
 * File stat information
 */
export interface FileStat {
  /** File size in bytes */
  size: number;
  /** Whether this is a directory */
  isDirectory: boolean;
  /** Whether this is a file */
  isFile: boolean;
  /** Last modification time */
  mtime: Date;
}

// ============================================================================
// Command Execution Types
// ============================================================================

/**
 * Options for running commands, with streaming support.
 */
export interface RunCommandOptions {
  /** Working directory for the command */
  cwd?: string;
  /** Environment variables */
  env?: Record<string, string>;
  /** Timeout in milliseconds */
  timeout?: number;
  /** Abort signal — aborts the command and kills its process tree. */
  signal?: AbortSignal;
  /** Called with stdout chunks as they are produced (streaming). */
  onStdout?: (chunk: string) => void;
  /** Called with stderr chunks as they are produced (streaming). */
  onStderr?: (chunk: string) => void;
}

/**
 * Result of command execution
 */
export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
}

/**
 * Platform-native paths of the resolved command shell.
 *
 * Hosts rarely need this: tools must never branch on the shell binary directly. It
exists so command-safety can pick the grammar matching the shell that will actually
run a command, because the platform alone does not answer that question — a Windows
host with Git Bash resolved at `C:\\Program Files\\Git\\bin\\bash.exe` genuinely runs
bash, so `win32` must not imply "no bash grammar".
 */
export interface CoreEnvShellInfo {
  /** Executable that will run command strings (e.g. `/bin/bash`, `powershell.exe`). */
  shell?: string;
  /** Absolute paths of every shell candidate the host resolved, most preferred first. */
  candidates?: string[];
}

/**
 * Status of a background shell job started via {@link StartCommandOptions}.
 */
export type CommandJobStatus = "running" | "exited" | "killed" | "failed";

/**
 * Options for starting a background command (does not await process exit).
 * Foreground {@link RunCommandOptions} / `runCommand` remain unchanged.
 */
export interface StartCommandOptions {
  /** Working directory for the command */
  cwd?: string;
  /** Environment variables */
  env?: Record<string, string>;
  /** Abort signal — aborts the command and kills its process tree. */
  signal?: AbortSignal;
  /** Called with stdout chunks as they are produced (streaming). */
  onStdout?: (chunk: string) => void;
  /** Called with stderr chunks as they are produced (streaming). */
  onStderr?: (chunk: string) => void;
  /** Called once when the process exits (or fails to start after spawn). */
  onExit?: (exitCode: number | null) => void;
}

/**
 * Handle returned by `CoreEnv.startCommand` after the process has been spawned.
 */
export interface StartCommandHandle {
  /** OS / runtime process id when available */
  pid?: number;
  /** Best-effort terminate the process (and children when supported). */
  kill: () => Promise<void>;
}
