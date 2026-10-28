#!/usr/bin/env node

import { installAgentLogProcessGuards, registerCoreEnv, errorMessage } from "@codent/core";
import { createNodeEnv } from "@codent/node";
import { serve } from "@hono/node-server";
import "dotenv/config";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { HTTPException } from "hono/http-exception";
import { networkInterfaces } from "os";
import { pathToFileURL } from "url";
import { z } from "zod";

import { REMOTE_PROVIDER_API_KEY } from "./provider-constants.js";
import { agentSessionRoutes } from "./routes/agent-session.js";
import { commandRoutes } from "./routes/command.js";
import { envRoutes, filterSensitiveVars } from "./routes/env.js";
import { fetchRoutes } from "./routes/fetch.js";
import { fsRoutes } from "./routes/fs.js";
import { createImageRoutes, imageRoutes } from "./routes/image.js";
import { mcpRoutes } from "./routes/mcp.js";
import {
  anthropicProxyBasePath,
  mapProviderPathToUpstream,
  normalizeProviderRequestPath,
  openaiProxyBasePath,
  providerRoutes,
  readServerModelEnv,
} from "./routes/provider.js";
import { getServerEnv, initServerRuntime } from "./server-runtime.js";

import type { CoreEnv } from "@codent/core";

export {
  REMOTE_PROVIDER_API_KEY,
  anthropicProxyBasePath,
  createImageRoutes,
  filterSensitiveVars,
  imageRoutes,
  mapProviderPathToUpstream,
  normalizeProviderRequestPath,
  openaiProxyBasePath,
  providerRoutes,
  readServerModelEnv,
};

export { createRemoteProvider } from "./remote-provider.js";
export { getServerManager, hasServerRuntime } from "./server-runtime.js";

// ============================================================================
// Configuration
// ============================================================================

/**
 * `--sandbox <local|native>` (also `--sandbox=native`) for a one-off launch; `SANDBOX_ENV` is the
 * fallback and stays the service-friendly route. Validated here so a typo cannot silently mean
 * "local" (the env fallback treats anything other than `native` as sandboxed).
 */
function readSandboxArg(argv: readonly string[]): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--sandbox") return argv[i + 1] ?? "";
    if (arg.startsWith("--sandbox=")) return arg.slice("--sandbox=".length);
  }
  return undefined;
}

const sandboxArg = readSandboxArg(process.argv.slice(2));
if (sandboxArg !== undefined && sandboxArg !== "local" && sandboxArg !== "native") {
  const detail = sandboxArg === "" ? "requires a value" : `got "${sandboxArg}"`;
  console.error(`[server] --sandbox must be "local" (OS sandbox) or "native" (no OS sandbox); ${detail}.`);
  process.exit(1);
}

const PORT = parseInt(process.env.SERVER_PORT || "3100", 10);
const ROOT_PATH = process.env.ROOT_PATH || process.cwd();
const SANDBOX_ENV = sandboxArg ?? process.env.SANDBOX_ENV ?? "local";
const REMOTE_ENV = process.env.REMOTE_ENV;

let coreEnv: CoreEnv;
if (REMOTE_ENV) {
  // Boundary: the server itself may register a remote CoreEnv (`REMOTE_ENV`),
  // e.g. when it hosts a remote-session whose workspace should be an even
  // further server's filesystem. The local node env is skipped in that case.
  // (A server-side REMOTE_PROVIDER proxy is planned but not implemented yet.)
  try {
    const { createRemoteEnv } = await import("./client.js");
    coreEnv = await createRemoteEnv(REMOTE_ENV);
    registerCoreEnv(coreEnv);
    console.log(`[server] Registered remote CoreEnv: ${REMOTE_ENV} (rootPath=${coreEnv.rootPath})`);
  } catch (err) {
    console.error(`[server] Failed to connect to remote CoreEnv at ${REMOTE_ENV}`);
    console.error(`  ${errorMessage(err)}`);
    process.exit(1);
  }
} else {
  coreEnv = createNodeEnv({ rootPath: ROOT_PATH, mode: SANDBOX_ENV === "native" ? "native" : "os" });
  registerCoreEnv(coreEnv);
}

// Agent plane: one server-owned runtime over the workspace CoreEnv. The
// `/api/agent/*` routes drive this manager instead of the ambient singleton.
await initServerRuntime(coreEnv);

// Land buffered agent-log entries (and any fatal error) on disk even when the
// server crashes or is hard-exited before the batch flush fires.
installAgentLogProcessGuards();

function getLocalIP() {
  const nets = networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] ?? []) {
      if (net.family === "IPv4" && !net.internal) {
        return net.address;
      }
    }
  }
  return "localhost";
}

// ============================================================================
// RPC Routes (chained for AppType inference)
// ============================================================================

const api = new Hono()
  .route("/env", envRoutes)
  .route("/fs", fsRoutes)
  .route("/image", imageRoutes)
  .route("/command", commandRoutes)
  .route("/fetch", fetchRoutes)
  .route("/mcp", mcpRoutes)
  .route("/provider", providerRoutes)
  // Agent plane (AgentSession) — separate from CoreEnv workspace routes above
  .route("/agent", agentSessionRoutes);

export type AppType = typeof api;

// ============================================================================
// App Setup
// ============================================================================

const app = new Hono();

/**
 * ONE error boundary for every route.
 *
 * A `ZodError` is a CLIENT error wherever it is thrown: a request body that fails the route's own
 * schema (`maxIterations: 0`, `temperature: "hot"`) and a config value that only fails later inside
 * core (`AgentConfigSchema`, `createCompactionConfig`) are the same mistake. Mapping it per handler
 * left the earlier one — thrown by `createBodySchema.parse` — as a 500 with a stack trace.
 */
app.onError((err, c) => {
  if (err instanceof HTTPException) return err.getResponse();
  if (err instanceof z.ZodError) {
    const message = err.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ");
    return c.json({ error: true, message }, 400);
  }
  // Same visibility the default handler had (a silent 500 is worse than a noisy one), but with a
  // response shape callers can read instead of the plain-text default.
  console.error(err);
  return c.json({ error: true, message: "Internal Server Error" }, 500);
});

app.use(
  "*",
  cors({
    origin: (origin) => {
      if (!origin) return "*";
      if (origin.startsWith("chrome-extension://")) return origin;
      if (origin.includes("localhost") || origin.includes("127.0.0.1")) return origin;
      return "";
    },
    allowMethods: ["GET", "POST", "DELETE", "OPTIONS"],
    allowHeaders: [
      "Content-Type",
      "Accept",
      "Authorization",
      "x-api-key",
      "anthropic-version",
      "anthropic-beta",
      // OpenAI SDK (browser env) sends these — see openai/internal/detect-platform.
      "x-stainless-lang",
      "x-stainless-package-version",
      "x-stainless-os",
      "x-stainless-arch",
      "x-stainless-runtime",
      "x-stainless-runtime-version",
      "x-stainless-retry-count",
      "x-stainless-timeout",
      "openai-organization",
      "openai-project",
    ],
  })
);

app.get("/health", (c) => {
  // Report the EFFECTIVE workspace root (the runtime's), not the local config constant —
  // under REMOTE_ENV the two differ.
  return c.json({ status: "ok", rootPath: getServerEnv().rootPath, sandboxEnv: SANDBOX_ENV });
});

app.route("/api", api);

export { app, api };

export const createServer = () => {
  return serve({ fetch: app.fetch, port: PORT }, (info) => {
    console.log(`[server] CoreEnv HTTP server listening on http://localhost:${info.port}`);
    console.log(`[server] CoreEnv HTTP server listening on http://${getLocalIP()}:${info.port}`);
    console.log(`[server] rootPath=${getServerEnv().rootPath}, sandbox=${SANDBOX_ENV}`);
  });
};

// Auto-start only when this module is the node entry (`node dist/index.mjs`) —
// plain imports (validation scripts, tests) must not bind a port.
const isMainEntry = (() => {
  try {
    return import.meta.url === pathToFileURL(process.argv[1] ?? "").href;
  } catch {
    return false;
  }
})();

if (isMainEntry) {
  createServer();
}
