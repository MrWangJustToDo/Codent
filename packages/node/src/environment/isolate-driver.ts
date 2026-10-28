/**
 * Node.js isolate driver for sandboxed TypeScript execution (code-mode).
 *
 * Lazily loads `@tanstack/ai-isolate-node` (which depends on the `isolated-vm`
 * native addon) on first call and returns `null` if it can't be loaded or the
 * addon is incompatible with the current Node runtime. Returning `null` lets the
 * built-in code-mode extension degrade gracefully (warns, registers no
 * `execute_typescript`) instead of crashing `createNodeEnv` at module load time.
 *
 * The `skipProbe` flag is intentionally not exposed here: the subprocess probe
 * in `createNodeIsolateDriver` is the safety net that turns a segfault-prone
 * native-addon mismatch into a catchable Error, which this function then
 * converts into a `null` (degrade).
 */
import { errorMessage } from "@codent/core";

import type { IsolateDriver } from "@tanstack/ai-code-mode";

/**
 * Lowest Node major `isolated-vm@7` supports. It declares `engines.node >=24` and
 * ships prebuilds for abi137 (Node 24) and abi147 (Node 26) only.
 *
 * Below that, npm **silently skips** the package: it is an `optionalDependency`, so
 * an unsatisfied `engines` range is an omission rather than an error. The import
 * then fails with a bare `Cannot find package 'isolated-vm'`, which reads exactly
 * like a broken install — it is not, and telling the two apart is the point of the
 * message below ("upgrade Node" vs "reinstall the CLI").
 */
const MINIMUM_NODE_MAJOR = 24;

/**
 * Explain an isolate-driver load failure in terms the reader can act on.
 *
 * The absent-package message is only reinterpreted when this runtime is genuinely
 * below the supported range. Blaming the Node version unconditionally would hide a
 * real packaging fault behind "upgrade Node and try again".
 */
function describeLoadFailure(err: unknown): string {
  const message = errorMessage(err);
  const major = Number.parseInt(process.versions.node.split(".")[0] ?? "", 10);

  const addonAbsent = /Cannot find (package|module) 'isolated-vm'/.test(message);
  if (addonAbsent && Number.isFinite(major) && major < MINIMUM_NODE_MAJOR) {
    return (
      `code mode needs Node.js ${MINIMUM_NODE_MAJOR}+ (running ${process.versions.node}). ` +
      `The optional dependency "isolated-vm" was skipped at install time because npm omits ` +
      `an optional dependency whose "engines" range is not satisfied — nothing is broken. ` +
      `Upgrade Node to re-enable it.`
    );
  }

  return message;
}

/**
 * Create a Node.js isolate driver backed by `isolated-vm`, or `null` when the
 * native addon is unavailable/incompatible (code-mode degrades gracefully).
 */
export async function createNodeIsolateDriver(): Promise<IsolateDriver | null> {
  try {
    const { createNodeIsolateDriver } = await import("@tanstack/ai-isolate-node");
    return createNodeIsolateDriver();
  } catch (err) {
    console.warn(`[node] code-mode isolate driver unavailable (degrading): ${describeLoadFailure(err)}`);
    return null;
  }
}
