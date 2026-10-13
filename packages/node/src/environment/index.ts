/**
 * Node.js environment utilities.
 *
 * Provides shell, filesystem, and sandbox utilities used by createNodeEnv().
 */

// Shell utilities
export {
  getShellConfig,
  spawnCommand,
  killProcessTree,
  waitForChildProcess,
  trackDetachedChildPid,
  untrackDetachedChildPid,
  type ShellConfig,
  type SpawnOptions,
  type SpawnResult,
  type SpawnShellStringOptions,
} from "./shell.js";

// Local environment config
export { resolveLocalEnvironmentMode, type LocalEnvironmentConfig, type LocalEnvironmentMode } from "./local.js";

// Shell-agnostic command resolution (replaces a `command -v` probe)
export { commandFileCandidates, pathDirs, scanPathForCommand } from "./command-lookup.js";

// Native filesystem (used internally, exported for advanced usage)
export { createNativeFilesystem, type NativeFilesystemHandle } from "./native-fs.js";

// Native command runner
export { runNativeCommand, resolveRunFailure } from "./native-run.js";

// OS sandbox utilities
export { resetOsSandbox, ensureOsSandbox, buildOsSandboxConfig } from "./os-sandbox.js";

// Code-mode isolate driver (native, loaded lazily; degrades to null)
export { createNodeIsolateDriver } from "./isolate-driver.js";
