/**
 * Remote LLM provider proxy — streams upstream chat traffic with server-side keys.
 *
 * Clients point TanStack adapters at `/api/provider/openai/v1` (or anthropic) so
 * API keys never leave the CoreEnv server. Existing `/api/fetch/proxy` is unsuitable
 * (buffers the full body as JSON).
 */

import {
  parseModelStyle,
  resolveModelConnectionFromEnv,
  type ModelConnection,
  type ModelsConfig,
  type ModelsConfigEntry,
} from "@codent/core";
import { Hono } from "hono";

import { loadServerModelsConfig } from "../load-models-config.js";
import { REMOTE_PROVIDER_API_KEY } from "../provider-constants.js";

export { REMOTE_PROVIDER_API_KEY };

/**
 * Strip credentials from the server's config before it leaves the process:
 * direct entries are only needed client-side for the selectable model list, and
 * their apiKey/baseURL are server secrets — the proxy injects them. Without
 * this, GET /api/provider/info leaks the upstream key to any caller.
 *
 * The payload is normalized at the same time: the model this server actually serves
 * (its `.env` `MODEL`) leads the advertised list and is reported as the active
 * selection. Clients build both their selectable list and their notion of "current"
 * from this payload, so a models.json naming other ids — or a chained
 * `remote-provider` entry contributed by an even further server — used to hand out a
 * list that excluded the only model the proxy would ever send, leaving the client
 * displaying a model it never used.
 *
 * `entryIndex: 0` names the synthetic entry below, so the advertised config stays
 * self-consistent: the served model is where `active` says it is.
 */
function sanitizeConfigForClient(config: ModelsConfig, connection: ModelConnection): SanitizedProviderConfig {
  const servedModel = connection.model?.trim();
  const others = (config.models ?? []).map((entry: ModelsConfigEntry): SanitizedProviderConfig["models"][number] => {
    if (entry.type !== "direct") return entry;
    // Redact upstream secrets by omitting them — clients only need the model list;
    // the proxy injects baseURL/apiKey server-side.
    return { type: entry.type, style: entry.style, models: entry.models };
  });
  // `global.toolConfig` carries server-side websearch keys (braveApiKey/exaApiKey/
  // parallelApiKey/tavilyApiKey). It is a server secret like a direct entry's apiKey,
  // and no client consumes it (they read only `models` / `active`), so it must never
  // leave the process.
  const { global: _global, models: _models, ...safeRest } = config;
  if (!servedModel) {
    // No served model (the server's `.env` names none): nothing to advertise — the
    // proxy forwards whatever the client sends against its own allowlist.
    return { ...safeRest, models: others };
  }
  return {
    ...safeRest,
    models: [
      // The served model leads, under the connection's own style — the style the proxy
      // will actually use for it, which a hand-written models.json entry may disagree
      // with. It is removed from the entry that declared it so the id appears once.
      { type: "direct", style: parseModelStyle(connection.style), models: [servedModel] },
      ...others.map((entry) =>
        entry.type === "direct" && entry.models?.includes(servedModel)
          ? { ...entry, models: entry.models.filter((model) => model !== servedModel) }
          : entry
      ),
    ],
    active: { entryIndex: 0, model: servedModel },
  };
}

/** Union of selectable model ids from the config's direct entries (+ the env model). */
function collectAllowedModels(config: ModelsConfig | null, connection: ModelConnection): Set<string> {
  const set = new Set<string>();
  if (config?.models) {
    for (const e of config.models) {
      if (e.type === "direct") {
        for (const m of e.models ?? []) if (m) set.add(m);
      }
    }
    if (config.active?.model) set.add(config.active.model);
  }
  if (connection.model) set.add(connection.model);
  return set;
}

/**
 * Explain a refused model by naming the actual sources of the allowed set.
 *
 * The previous message always said "models.json allowlist" even when no
 * models.json existed and the only allowed model came from the server's `MODEL`
 * env var — which sent readers looking for a file that was not there.
 */
function modelNotAllowedMessage(reqModel: string, allowed: Set<string>): string {
  const names = [...allowed].sort().join(", ");
  return (
    `Model "${reqModel}" is not available on this server. ` +
    `The server serves: ${names || "(none configured)"}. ` +
    `Set MODEL / a models.json entry on the server, or request one of those models.`
  );
}

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailers",
  "transfer-encoding",
  "upgrade",
  "host",
  "content-length",
]);

/**
 * Headers that must not be forwarded on the response when Node `fetch` has already
 * decoded the body (undici auto-decompresses gzip/br). Passing Content-Encoding
 * through causes clients (OpenAI SDK) to gunzip plain text → Z_DATA_ERROR / "terminated".
 */
const RESPONSE_STRIP = new Set([...HOP_BY_HOP, "content-encoding"]);

// ============================================================================
// Upstream resolution
// ============================================================================

export function readServerModelEnv(
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>
) {
  // Shared with the CLI and the ACP bootstrap (core owns the env→connection mapping).
  return resolveModelConnectionFromEnv(env);
}

/** Relative adapter base path on this server (includes /v1 when upstream does). */
export function openaiProxyBasePath(upstreamBaseURL: string): string {
  const trimmed = upstreamBaseURL.replace(/\/+$/, "");
  if (trimmed.endsWith("/v1")) return "/api/provider/openai/v1";
  return "/api/provider/openai";
}

export function anthropicProxyBasePath(upstreamBaseURL: string): string {
  const trimmed = upstreamBaseURL.replace(/\/+$/, "");
  if (trimmed.endsWith("/v1")) return "/api/provider/anthropic/v1";
  return "/api/provider/anthropic";
}

/**
 * Map a request path under `/api/provider/{family}` onto the upstream base URL.
 */
export function normalizeProviderRequestPath(requestPath: string): string {
  const pathOnly = requestPath.split("?")[0] ?? requestPath;
  if (pathOnly.startsWith("/api/provider/")) return pathOnly;
  if (pathOnly.startsWith("/provider/")) return `/api${pathOnly}`;
  if (pathOnly.startsWith("/openai") || pathOnly.startsWith("/anthropic")) {
    return `/api/provider${pathOnly}`;
  }
  return pathOnly;
}

export function mapProviderPathToUpstream(
  upstreamBaseURL: string,
  family: "openai" | "anthropic",
  requestPath: string
): string {
  const proxyBase =
    family === "openai" ? openaiProxyBasePath(upstreamBaseURL) : anthropicProxyBasePath(upstreamBaseURL);
  const pathOnly = normalizeProviderRequestPath(requestPath);
  let rest = pathOnly.startsWith(proxyBase) ? pathOnly.slice(proxyBase.length) : pathOnly;
  if (!rest.startsWith("/")) rest = `/${rest}`;
  if (rest === "/") rest = "";
  return `${upstreamBaseURL.replace(/\/+$/, "")}${rest}`;
}

/**
 * Map a request on the **root-compatible** surface (`/v1/...`) onto the upstream base URL.
 *
 * Same upstream, same allowlist, same injected key as the prefixed surface — it only drops
 * `/api/provider/{family}` from the client's base URL, so any OpenAI/Anthropic SDK consumer can
 * point `baseURL` at `http://<server>:3100/v1` without knowing Codent's route layout.
 *
 * Exactly one `/v1` survives: the client supplies one (`/v1/chat/completions`) and the upstream
 * base may already end with one (`https://api.openai.com/v1`) or not (`https://api.deepseek.com`,
 * whose OpenAI-compatible paths carry their own `/v1`).
 */
export function mapRootAliasToUpstream(
  upstreamBaseURL: string,
  family: "openai" | "anthropic",
  requestPath: string
): string {
  const upstreamBase = upstreamBaseURL.replace(/\/+$/, "");
  const proxyBase = family === "openai" ? openaiProxyBasePath(upstreamBase) : anthropicProxyBasePath(upstreamBase);
  const pathOnly = requestPath.split("?")[0] ?? requestPath;
  // `proxyBase` names the `/v1` its upstream needs; whether it needs one is decided by
  // `openaiProxyBasePath`/`anthropicProxyBasePath`, so reuse that answer instead of a second rule.
  const suffix = proxyBase.endsWith("/v1") ? pathOnly.replace(/^\/v1(?=\/|$)/, "") : pathOnly;
  return `${upstreamBase}${suffix === "/" ? "" : suffix}`;
}

/**
 * Which upstream protocol a root-surface request speaks.
 *
 * Anthropic's Messages API lives at `/v1/messages`; everything else under `/v1` is the
 * OpenAI-compatible shape the majority of gateways expose. The style check in `proxyStream` turns
 * the mismatch (an Anthropic-shaped server asked for `/v1/chat/completions`) into a diagnosable
 * 400 rather than an upstream 404.
 */
export function rootProviderFamily(pathname: string): "openai" | "anthropic" {
  const pathOnly = pathname.split("?")[0] ?? pathname;
  return pathOnly === "/v1/messages" || pathOnly.startsWith("/v1/messages/") ? "anthropic" : "openai";
}

function filterRequestHeaders(source: Headers, inject: Record<string, string>): Headers {
  const out = new Headers();
  source.forEach((value, key) => {
    const lower = key.toLowerCase();
    if (HOP_BY_HOP.has(lower)) return;
    if (lower === "authorization" || lower === "x-api-key") return;
    // Avoid asking upstream for encodings we would mishandle after undici decode.
    if (lower === "accept-encoding") return;
    out.set(key, value);
  });
  for (const [key, value] of Object.entries(inject)) {
    out.set(key, value);
  }
  return out;
}

function filterResponseHeaders(source: Headers): Headers {
  const out = new Headers();
  source.forEach((value, key) => {
    if (RESPONSE_STRIP.has(key.toLowerCase())) return;
    out.set(key, value);
  });
  return out;
}

/** OpenAI-compatible error body so Chat Completions clients show `message`, not `502 true`. */
function openaiErrorResponse(status: number, message: string, code: string): Response {
  return Response.json(
    {
      error: {
        message,
        type: "proxy_error",
        code,
      },
    },
    { status }
  );
}

function formatUnknownError(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const parts = [err.message];
  let cause: unknown = err.cause;
  for (let depth = 0; cause instanceof Error && depth < 3; depth += 1) {
    if (cause.message) parts.push(cause.message);
    const code = (cause as Error & { code?: string }).code;
    if (typeof code === "string" && code) parts.push(code);
    cause = cause.cause;
  }
  return parts.join(": ");
}

/**
 * Whether the client asked for the upstream MODEL LIST.
 *
 * Decided on the MAPPED TARGET rather than on the client path, so both surfaces answer the same
 * way: a prefixed client (`/api/provider/openai/v1/models`) and a foreign OpenAI SDK
 * (`/v1/models`) resolve to the same upstream URL, and a base that does not end with `/v1`
 * (DeepSeek shape) needs no third rule.
 */
function isUpstreamModelsRequest(method: string, upstreamTarget: string, upstreamBaseURL: string): boolean {
  if (method !== "GET" && method !== "HEAD") return false;
  const base = upstreamBaseURL.replace(/\/+$/, "");
  return upstreamTarget.split("?")[0] === `${base}/models`;
}

/**
 * The OpenAI `.../models` body for what THIS server serves.
 *
 * Forwarding the upstream catalog was the behaviour, and it advertised ids that every other
 * request on this surface refuses with `model_not_allowed` — a client that lists first and asks
 * second gets a 400 for a model the list itself recommended. The allowlist that refuses those
 * requests is therefore the only honest answer to "what can I ask for", and reusing the refusal
 * path's own set means the two answers can never disagree.
 *
 * `created` is 0: an upstream catalog carries no creation time we could claim for a model id, but
 * OpenAI's SDKs type it as a required integer (and some clients sort by it).
 */
function servedModelsResponse(allowed: Set<string>): Response {
  return Response.json({
    object: "list",
    data: [...allowed].sort().map((id) => ({ id, object: "model", created: 0, owned_by: "codent" })),
  });
}

/** Which client-facing surface a proxied request arrived on. */
type ProxySurface = "prefix" | "root";

async function proxyStream(
  c: { req: { raw: Request; url: string; path: string; method: string } },
  family: "openai" | "anthropic",
  surface: ProxySurface = "prefix"
): Promise<Response> {
  const connection = readServerModelEnv();
  const pathname = new URL(c.req.url).pathname;
  if (connection.style !== family) {
    return openaiErrorResponse(
      400,
      `Server MODEL_STYLE is "${connection.style}", but ${pathname} speaks the ${family} API`,
      "style_mismatch"
    );
  }
  if (!connection.apiKey) {
    return openaiErrorResponse(500, "Server API_KEY is not configured", "missing_api_key");
  }

  // Model policy: the server's own model set is the allowlist, and it is the
  // single source of truth — a client model outside it is refused, never
  // rewritten. Rewriting was the older behaviour ("so a leftover local default
  // like gpt-4o-mini never leaks upstream"), but silently swapping the model in
  // a client's request body is the worse failure: the client believes it is
  // talking to model A while the server answers as model B, with nothing in the
  // response to reveal the substitution. A 400 with the allowed set named is
  // diagnosable.
  //
  // The set is never empty on this path: reaching here requires
  // `connection.baseURL`, whose companion `MODEL` is seeded below, so a server
  // with no models.json still refuses unknown models rather than rewriting them.
  const serverConfig = await loadServerModelsConfig();
  const allowed = collectAllowedModels(serverConfig, connection);

  const target =
    surface === "root"
      ? mapRootAliasToUpstream(connection.baseURL, family, pathname)
      : mapProviderPathToUpstream(connection.baseURL, family, pathname);

  // A model-list request is answered FROM the allowlist above, never forwarded: the upstream's
  // catalog contains ids this proxy refuses, so a client that lists first and requests second
  // would be told "this exists" and then refused with `model_not_allowed`.
  if (isUpstreamModelsRequest(c.req.method, target, connection.baseURL)) {
    return servedModelsResponse(allowed);
  }

  const url = new URL(c.req.url);
  const targetUrl = `${target}${url.search}`;

  const inject: Record<string, string> =
    family === "anthropic"
      ? {
          "x-api-key": connection.apiKey,
          "anthropic-version": process.env.ANTHROPIC_VERSION?.trim() || "2023-06-01",
        }
      : {
          Authorization: `Bearer ${connection.apiKey}`,
        };

  const headers = filterRequestHeaders(c.req.raw.headers, inject);
  const method = c.req.method;
  const hasBody = method !== "GET" && method !== "HEAD";

  let body: BodyInit | undefined = c.req.raw.body ?? undefined;
  if (hasBody && connection.baseURL) {
    const contentType = headers.get("content-type") ?? "";
    if (contentType.includes("application/json")) {
      const rawText = await c.req.raw.clone().text();
      try {
        const parsed = JSON.parse(rawText) as Record<string, unknown>;
        if (parsed && typeof parsed === "object") {
          const reqModel = typeof parsed.model === "string" ? parsed.model : "";
          if (reqModel && !allowed.has(reqModel)) {
            return openaiErrorResponse(400, modelNotAllowedMessage(reqModel, allowed), "model_not_allowed");
          }
          body = rawText;
        }
      } catch {
        // Not JSON or unparseable — forward the original body unchanged.
        body = c.req.raw.body ?? undefined;
      }
    }
  }

  let upstream: Response;
  try {
    upstream = await fetch(targetUrl, {
      method,
      headers,
      body: hasBody ? body : undefined,
      ...(hasBody ? ({ duplex: "half" } as RequestInit) : {}),
      signal: c.req.raw.signal,
    });
  } catch (err) {
    return openaiErrorResponse(502, `Upstream provider error: ${formatUnknownError(err)}`, "upstream_fetch_failed");
  }

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: filterResponseHeaders(upstream.headers),
  });
}

// ============================================================================
// Routes
// ============================================================================

/**
 * Server config shape safe to hand to remote clients: direct entries keep only
 * the selectable model ids — upstream `baseURL`/`apiKey` never leave the server.
 */
export type SanitizedProviderConfig = Omit<ModelsConfig, "models" | "global"> & {
  models: Array<{ type: "direct"; style: string; models?: string[] } | { type: "remote-provider"; url: string }>;
};

export interface ProviderInfoResponse {
  mode: "remote";
  style: "openai" | "anthropic";
  model: string;
  /** Absolute-path adapter baseURL on this server (no host). */
  basePath: string;
  /** Server's own models.json (sanitized) — lets clients resolve the list. */
  config?: SanitizedProviderConfig;
}

/**
 * The same proxy at the server root: `/v1/chat/completions`, `/v1/models`, `/v1/messages`, …
 *
 * This is the "consume me like a provider" surface. A foreign service configures
 * `baseURL=http://<server>:3100/v1` plus any placeholder key (the proxy replaces `Authorization`
 * with the server's own `API_KEY`), and gets the server's model allowlist, streaming, and
 * tool calls without knowing Codent's `/api/provider/{family}` layout. Mounted on the root app,
 * not under `/api` — the shape other OpenAI-compatible tools expect.
 */
export const rootProviderRoutes = new Hono()
  .all("/v1/*", (c) => proxyStream(c, rootProviderFamily(new URL(c.req.url).pathname), "root"))
  .all("/v1", (c) => proxyStream(c, rootProviderFamily(new URL(c.req.url).pathname), "root"));

export const providerRoutes = new Hono()
  .get("/info", async (c) => {
    const connection = readServerModelEnv();
    const style = parseModelStyle(connection.style);
    const basePath =
      style === "anthropic" ? anthropicProxyBasePath(connection.baseURL) : openaiProxyBasePath(connection.baseURL);
    const serverConfig = await loadServerModelsConfig();
    const body: ProviderInfoResponse = {
      mode: "remote",
      style,
      model: connection.model,
      basePath,
      // Strip direct-entry apiKey/baseURL secrets: clients only need the model list.
      ...(serverConfig ? { config: sanitizeConfigForClient(serverConfig, connection) } : {}),
    };
    return c.json(body);
  })
  .all("/openai/*", (c) => proxyStream(c, "openai"))
  .all("/openai", (c) => proxyStream(c, "openai"))
  .all("/anthropic/*", (c) => proxyStream(c, "anthropic"))
  .all("/anthropic", (c) => proxyStream(c, "anthropic"));
