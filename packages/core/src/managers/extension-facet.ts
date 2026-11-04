/**
 * Extension facet: the agent-facing view over the extension registry.
 *
 * Loading/activation, ownership and tool registration stay in `ExtensionRegistry`; this facet is
 * the narrow read surface (`runner`, `loader`, commands, command context) so `ManagedAgent` does
 * not reach into the registry from every accessor.
 */

import type { ExtensionRegistryService } from "./services/extension-registry-service.js";
import type { ExtensionLoader } from "../agent/extension/loader.js";
import type { ExtensionRunner } from "../agent/extension/runner.js";
import type { ExtensionContext, ExtensionCommand } from "../agent/extension/types.js";

export interface ExtensionFacetHost {
  getRegistry(): ExtensionRegistryService;
}

export class ExtensionFacet {
  constructor(private readonly host: ExtensionFacetHost) {}

  getRunner(): ExtensionRunner | null {
    return this.host.getRegistry().getExtensionRunner();
  }

  getLoader(): ExtensionLoader | null {
    return this.host.getRegistry().getExtensionLoader();
  }

  getCommands(): ExtensionCommand[] {
    return this.host.getRegistry().getExtensionCommands();
  }

  getContextForCommand(name: string): ExtensionContext | undefined {
    return this.getRunner()?.contextForCommand(name);
  }
}
