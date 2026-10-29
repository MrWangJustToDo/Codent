#!/usr/bin/env node

import { installAgentLogProcessGuards, parseModelStyle, registerCoreEnv, errorMessage } from "@codent/core";
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
  mapRootAliasToUpstream,
  normalizeProviderRequestPath,
  openaiProxyBasePath,
  providerRoutes,
  readServerModelEnv,
  rootProviderFamily,
  rootProviderRoutes,
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
  mapRootAliasToUpstream,
  normalizeProviderRequestPath,
  openaiProxyBasePath,
  providerRoutes,
  readServerModelEnv,
  rootProviderFamily,
  rootProviderRoutes,
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

// Provider-compatible surface at the ROOT (`/v1/*`): the same proxy/allowlist/key injection as
// `/api/provider/*`, at the path an OpenAI- or Anthropic-SDK consumer expects. Kept out of `/api`
// deliberately — `baseURL=http://host:3100/v1` has to be enough for a foreign service.
app.route("/", rootProviderRoutes);

export { app, api };

/**
 * Print the LLM surface a foreign client should point at.
 *
 * The provider-native proxy lives at the server ROOT (`/v1/...`), which nothing advertises: it is
 * absent from `/health`, and an operator who started the process only sees CoreEnv/workspace lines.
 * The two styles also need DIFFERENT base URLs — an OpenAI SDK appends `/chat/completions` to the
 * base it is given and so needs the `/v1`, while an Anthropic SDK appends `/v1/messages` itself and
 * would double it — so the line prints the exact value instead of a generic "LLM ready".
 */
function logProviderSurface(port: number): void {
  const connection = readServerModelEnv();
  const style = parseModelStyle(connection.style);
  const addresses = [...new Set([`http://localhost:${port}`, `http://${getLocalIP()}:${port}`])];
  // OpenAI-compatible clients take base=/v1; the Messages API is versioned by the client, not the base.
  const bases = style === "anthropic" ? addresses : addresses.map((address) => `${address}/v1`);
  const surface =
    style === "anthropic"
      ? "Anthropic Messages (/v1/messages)"
      : "OpenAI-compatible (/v1/chat/completions, /v1/models)";
  // A missing key is not fatal at startup but every proxied request 500s — say so here, with the
  // first line an operator reads, instead of leaving it to the first request to explain.
  const missingKey = connection.apiKey ? "" : "  [warn] API_KEY is not set — proxied requests will fail";
  const model = connection.model ? `model=${connection.model}` : "model=<unset>";
  console.log(`[server] LLM ${surface} at ${bases.join(" | ")}  (${model})${missingKey}`);
}

export const createServer = () => {
  return serve({ fetch: app.fetch, port: PORT }, (info) => {
    console.log(`[server] CoreEnv HTTP server listening on http://localhost:${info.port}`);
    console.log(`[server] CoreEnv HTTP server listening on http://${getLocalIP()}:${info.port}`);
    console.log(`[server] rootPath=${getServerEnv().rootPath}, sandbox=${SANDBOX_ENV}`);
    logProviderSurface(info.port);
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
