/**
 * Runtime teardown hooks — fired by {@link clearCoreEnv}.
 *
 * `clearCoreEnv()` has to tear down process-scoped state that lives in *other*
 * layers (background shell jobs live under `agent/tools/`). Importing that state
 * from `env.ts` would make the bottom of the stack depend on the top, and the
 * dependency is not hypothetical: ~60 modules under `agent/` import `env.js`, so
 * `env → agent/tools/util/command-job-registry` closed a real cycle
 * (`env → command-job-registry → command-output-log → env`).
 *
 * So the direction is inverted: the owner of the state registers a hook at module
 * load, and `clearCoreEnv()` drains whatever was registered. `env.ts` therefore
 * imports nothing above it, and a new process-scoped resource joins the teardown
 * without touching `env.ts` at all.
 *
 * Hooks are best-effort and synchronous — `clearCoreEnv()` is not async and callers
 * (`@codent/cli`, extension, playground) do not await it, so an async teardown has
 * to start its own work and return (`command-job-registry` does exactly that).
 *
 * This module is part of the `env` layer and must stay import-free.
 */

/** Teardown callbacks, in registration order. */
const hooks = new Set<() => void>();

/**
 * Register a callback to run when the CoreEnv is cleared.
 *
 * @returns an unsubscribe function, so a resource that is itself destroyed can
 *          stop being called on the next teardown.
 */
export function registerEnvTeardownHook(hook: () => void): () => void {
  hooks.add(hook);
  return () => hooks.delete(hook);
}

/**
 * Run every registered teardown hook. A throwing hook must not stop the others —
 * teardown runs while the host is giving up, and one failing resource may not
 * strand the rest.
 */
export function runEnvTeardownHooks(): void {
  for (const hook of hooks) {
    try {
      hook();
    } catch {
      // Teardown is best-effort; a failing hook is not a reason to leak the others.
    }
  }
}

/** Test-only: drop every hook (so a validator can assert registration from scratch). */
export function clearEnvTeardownHooksForTesting(): void {
  hooks.clear();
}
