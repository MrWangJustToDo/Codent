import { ProviderManager } from "./provider.js";
import { PROVIDER_REGISTRY } from "./registry.js";

/**
 * Create a fresh, agent/runtime-scoped provider manager with the standard providers registered.
 *
 * Lives in its own module (not the directory barrel) because this is behavior, not re-export
 * surface: a barrel whose only job is to be imported by the package entry is an indirection, and
 * the one function it defined would have been the only reason to keep it.
 */
export function createConfiguredProviderManager(): ProviderManager {
  const pm = new ProviderManager();
  for (const registration of PROVIDER_REGISTRY) {
    pm.register(registration.create());
  }
  return pm;
}
