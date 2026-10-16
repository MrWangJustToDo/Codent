#!/usr/bin/env node
/**
 * `@codent/cli` — development host entry.
 *
 * Thin shell over {@link bootstrapCliHost}. The only thing this file adds is
 * the `@codent/server/client` remote-plane factories (remote CoreEnv + remote
 * AgentSession host), which the server-free shared host module receives via
 * injection. Everything else lives in `host.tsx`.
 */
import { createRemoteAgentSessionHost, createRemoteEnv } from "@codent/server/client";

import { bootstrapCliHost } from "./host.jsx";

await bootstrapCliHost({
  productName: "Codent",
  server: {
    createRemoteEnv,
    createRemoteAgentSessionHost,
  },
});
