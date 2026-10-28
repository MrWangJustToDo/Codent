/**
 * OS-level sandbox integration via @anthropic-ai/sandbox-runtime.
 *
 * Wraps shell commands with seatbelt (macOS) or bubblewrap (Linux).
 * File tools use Node fs separately; this module only handles runCommand isolation.
 */

import { SandboxManager, type SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime";
import { errorMessage } from "@codent/core";
import { homedir } from "node:os";
import { join } from "node:path";

/** Domains commonly needed for local coding-agent workflows */
const DEFAULT_ALLOWED_DOMAINS = [
  "github.com",
  "*.github.com",
  "api.github.com",
  "lfs.github.com",
  "raw.githubusercontent.com",
  "objects.githubusercontent.com",
  "npmjs.org",
  "*.npmjs.org",
  "registry.npmjs.org",
  "registry.yarnpkg.com",
  "pypi.org",
  "*.pypi.org",
  "files.pythonhosted.org",
  "crates.io",
  "index.crates.io",
  "static.crates.io",
  "go.dev",
  "proxy.golang.org",
  "sum.golang.org",
  "dl.google.com",
  "azure.com",
  "*.azure.com",
  "openai.com",
  "*.openai.com",
  "anthropic.com",
  "*.anthropic.com",
  "openrouter.ai",
  "*.openrouter.ai",
  "ollama.com",
  "*.ollama.com",
  "localhost",
  "127.0.0.1",
];

let initializedRootPath: string | null = null;
let osSandboxActive = false;
let downgradeWarned = false;

function warnSandboxDowngrade(message: string): void {
  if (downgradeWarned || process.env.MY_AGENT_SANDBOX_QUIET === "1") {
    return;
  }
  downgradeWarned = true;
  process.stderr.write(`[codent] ${message}\n`);
}

/**
 * Sensitive directories under the home directory that must stay unreadable.
 *
 * Stored as home-relative segments and joined at call time. They used to be emitted as literal
 * `~/.ssh` strings, which relies on the sandbox library expanding `~` itself — an assumption
 * about someone else's implementation rather than something this code controls.
 */
const DENIED_HOME_SEGMENTS = [".ssh", ".aws", ".config/gcloud", ".gnupg"];

/**
 * Build sandbox-runtime config for a workspace root.
 * Paths use "." relative to spawn cwd (the workspace root).
 *
 * `denyRead` is derived from the real home directory. On Windows this is latent rather than
 * active — `SandboxManager.isSupportedPlatform()` gates the sandbox off there — but resolving
 * `~` explicitly keeps the rule correct wherever the sandbox does run.
 */
export function buildOsSandboxConfig(_rootPath: string): SandboxRuntimeConfig {
  const home = homedir();
  return {
    network: {
      allowedDomains: DEFAULT_ALLOWED_DOMAINS,
      deniedDomains: [],
      allowLocalBinding: true,
    },
    filesystem: {
      denyRead: DENIED_HOME_SEGMENTS.map((segment) => join(home, segment)),
      allowWrite: [".", "/tmp", "/private/tmp", "/var/tmp"],
      denyWrite: [],
    },
  };
}

/**
 * Initialize OS sandbox for a workspace. Returns false if unavailable (falls back to unsandboxed shell).
 */
export async function ensureOsSandbox(rootPath: string): Promise<boolean> {
  if (!SandboxManager.isSupportedPlatform()) {
    warnSandboxDowngrade(
      "OS sandbox is not supported on this platform; shell commands run without OS isolation. " +
        "Use SANDBOX_ENV=native or run on macOS/Linux/WSL."
    );
    return false;
  }

  if (initializedRootPath === rootPath && osSandboxActive) {
    return true;
  }

  if (initializedRootPath) {
    await SandboxManager.reset();
    initializedRootPath = null;
    osSandboxActive = false;
  }

  try {
    await SandboxManager.initialize(buildOsSandboxConfig(rootPath));
    const deps = SandboxManager.checkDependencies();
    if (deps.errors.length > 0) {
      await SandboxManager.reset();
      warnSandboxDowngrade(
        `OS sandbox dependencies missing (${deps.errors.join("; ")}); shell commands run unsandboxed. ` +
          "On Linux install: apt install bubblewrap socat ripgrep"
      );
      return false;
    }

    if (deps.warnings.length > 0 && process.env.MY_AGENT_SANDBOX_QUIET !== "1") {
      for (const warning of deps.warnings) {
        process.stderr.write(`[codent] sandbox warning: ${warning}\n`);
      }
    }

    osSandboxActive = SandboxManager.isSandboxingEnabled();
    if (!osSandboxActive) {
      await SandboxManager.reset();
      warnSandboxDowngrade("OS sandbox could not be enabled; shell commands run unsandboxed.");
      return false;
    }

    initializedRootPath = rootPath;
    return true;
  } catch (err) {
    await SandboxManager.reset().catch(() => undefined);
    warnSandboxDowngrade(`OS sandbox initialization failed (${errorMessage(err)}); shell commands run unsandboxed.`);
    return false;
  }
}

/**
 * Wrap a shell command with OS sandbox restrictions.
 */
export async function wrapOsSandboxCommand(command: string): Promise<string> {
  return SandboxManager.wrapWithSandbox(command);
}

/**
 * Annotate stderr when sandbox blocked an operation.
 */
export function annotateOsSandboxStderr(command: string, stderr: string): string {
  return SandboxManager.annotateStderrWithSandboxFailures(command, stderr);
}

/** Cleanup per-command resources (proxies, temp profiles, etc.) */
export function cleanupOsSandboxAfterCommand(): void {
  SandboxManager.cleanupAfterCommand();
}

/**
 * Reset global sandbox-runtime state (call on sandbox destroy).
 */
export async function resetOsSandbox(): Promise<void> {
  if (initializedRootPath) {
    await SandboxManager.reset();
    initializedRootPath = null;
    osSandboxActive = false;
  }
}

/** Whether OS sandbox is active for the current session */
export function isOsSandboxActive(): boolean {
  return osSandboxActive;
}
