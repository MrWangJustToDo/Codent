import { createContext, useContext } from "react";

import type { CoreEnv } from "@codent/core";

/**
 * The workspace {@link CoreEnv} for the app tree, supplied by the host at the
 * boundary (the host owns the runtime's env). This is the app's only access to
 * fs/shell/path — no ambient `getEnv()` read, so two runtimes in one process
 * cannot cross-bind.
 */
const CoreEnvContext = createContext<CoreEnv | null>(null);

export const CoreEnvProvider = CoreEnvContext.Provider;

export function useCoreEnv(): CoreEnv {
  const env = useContext(CoreEnvContext);
  if (!env) {
    throw new Error("useCoreEnv must be used within a <CoreEnvProvider>");
  }
  return env;
}
