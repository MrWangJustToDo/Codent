/**
 * Lazily-resolved ambient env for call paths that must not force CoreEnv registration.
 *
 * A Proxy over `{}` that resolves {@link getEnv} on each property read, so a path that never
 * touches the environment (an ad-hoc / test tool execution with no run context) does not throw
 * the "CoreEnv not registered" error — matching the pre-runtime behaviour where the ambient env
 * was only reached when a tool actually used one.
 *
 * NOT a replacement for {@link getEnv}: it implements only `get` / `has`, so it cannot be spread
 * (`resolveCoreEnv` builds `{ ...env }`) and it defers the not-registered throw to first access.
 * `getEnv()` stays the eager, spread-safe accessor; this is the deferred fallback used as the
 * run-context fallback in `define-tool`.
 */

import { getEnv, type ResolvedCoreEnv } from ".";

let ambientEnvProxy: ResolvedCoreEnv | null = null;

/** The shared lazy ambient-env Proxy (see the module note for why it is not `getEnv`). */
export function getAmbientEnv(): ResolvedCoreEnv {
  if (!ambientEnvProxy) {
    ambientEnvProxy = new Proxy({} as ResolvedCoreEnv, {
      get: (_target, prop, receiver) => Reflect.get(getEnv(), prop, receiver),
      has: (_target, prop) => prop in getEnv(),
    });
  }
  return ambientEnvProxy;
}
