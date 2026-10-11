/**
 * Ambient `ModelProvider` registry — the process-default provider.
 *
 * A runtime-owned provider is carried on {@link AgentRuntime} and passed explicitly;
 * this registry is the fallback for code that reads `getModelProvider()` with no
 * runtime in scope (legacy hosts, scripts, tests). New code should prefer the runtime.
 */

import type { ModelProvider } from "./model-provider.js";

let ambientProvider: ModelProvider | null = null;

/** Install the ambient model provider (backs `registerModelProvider` compatibility). */
export function registerModelProvider(provider: ModelProvider): void {
  ambientProvider = provider;
}

/** Clear the ambient model provider (host disconnect). Best-effort destroys it. */
export function clearModelProvider(): void {
  const prev = ambientProvider;
  ambientProvider = null;
  void prev?.destroy?.();
}

/** Whether an ambient model provider is registered. */
export function hasModelProvider(): boolean {
  return ambientProvider !== null;
}

/** Get the ambient model provider. Throws when none is registered. */
export function getModelProvider(): ModelProvider {
  if (!ambientProvider) {
    throw new Error(
      "ModelProvider not registered. Pass a provider to the runtime/CodentAgent, or call " +
        "registerModelProvider() before resolving models. Use createDirectModelProvider() or " +
        "createRemoteProvider() from the host."
    );
  }
  return ambientProvider;
}
