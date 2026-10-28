/**
 * Browser → CORS-safe proxy → upstream URL.
 *
 * WebContainer Node/curl still hit browser CORS (origin *.w-corp-staticblitz.com).
 * Only a real server-side hop (Vite middleware or Cloudflare Worker) works.
 */

export interface ProxyFetchResponse {
  ok: boolean;
  status?: number;
  statusText?: string;
  headers?: Record<string, string>;
  body?: string;
  encoding?: "base64";
  error?: string;
}

let proxyUrl = "";

export function setFetchProxyUrl(url: string): void {
  proxyUrl = url.trim();
}

export function getFetchProxyUrl(): string {
  return proxyUrl;
}

/** Where a resolved proxy endpoint comes from, in priority order. */
export interface FetchProxySources {
  /** User setting (settings panel / persisted config). */
  configured?: string;
  /** Build-time `VITE_FETCH_PROXY_URL`. */
  envUrl?: string;
  /** True when a Vite middleware proxy exists (`vite` / `vite preview`), false on static hosting. */
  dev: boolean;
  /** `window.location.origin`; required only when `dev`. */
  origin?: string;
}

/**
 * Pure priority table: settings → build-time env → dev middleware → none.
 *
 * Split out of {@link resolveFetchProxyUrl} because the real priority lives here: the wrapper only
 * reads `import.meta.env` / `window`, neither of which exists under Node, so a validator that
 * wanted to cover the table had to re-implement it (and drifted — the copy took four arguments and
 * tested a function production never had).
 */
export function pickFetchProxyUrl(sources: FetchProxySources): string {
  const fromSettings = sources.configured?.trim();
  if (fromSettings) return fromSettings;

  const fromEnv = sources.envUrl?.trim();
  if (fromEnv) return fromEnv;

  if (sources.dev) {
    if (!sources.origin) throw new Error("fetch proxy: dev mode requires an origin");
    return new URL("/__fetch_proxy", sources.origin).href;
  }

  return "";
}

/**
 * Read the build-time proxy inputs.
 *
 * `import.meta.env` exists only under Vite. A plain Node import of this module (a validator, or
 * any SSR/tooling path) has no bundler define, so reading it unguarded threw before the priority
 * table could even run — which is how the previous validator ended up re-implementing the table
 * instead of calling it.
 */
function readBuildProxySources(): Omit<FetchProxySources, "configured"> {
  const meta = import.meta as ImportMeta & {
    env?: { VITE_FETCH_PROXY_URL?: string; DEV?: boolean };
  };
  return {
    envUrl: meta.env?.VITE_FETCH_PROXY_URL,
    dev: meta.env?.DEV === true,
    origin: typeof window === "undefined" ? undefined : window.location.origin,
  };
}

/** Resolve proxy endpoint: settings → VITE_FETCH_PROXY_URL → local Vite middleware (dev only). */
export function resolveFetchProxyUrl(configured?: string): string {
  return pickFetchProxyUrl({ configured, ...readBuildProxySources() });
}

function resolveUrl(input: string | URL | Request): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

function collectHeaders(input: string | URL | Request, init?: RequestInit): Record<string, string> {
  const headers: Record<string, string> = {};
  const raw = init?.headers ?? (input instanceof Request ? input.headers : undefined);
  if (!raw) return headers;

  if (raw instanceof Headers) {
    raw.forEach((value, key) => {
      headers[key] = value;
    });
    return headers;
  }

  if (Array.isArray(raw)) {
    for (const [key, value] of raw) {
      headers[key] = value;
    }
    return headers;
  }

  return { ...raw };
}

async function readBody(input: string | URL | Request, init?: RequestInit): Promise<string | undefined> {
  if (typeof init?.body === "string") return init.body;
  if (input instanceof Request && init?.body === undefined) {
    return input.text();
  }
  return undefined;
}

function decodeBase64(body: string): Uint8Array {
  const binary = atob(body);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/**
 * CoreEnv.fetch that POSTs to a server-side proxy (Vite or Cloudflare Worker).
 */
export function createProxiedFetch(): typeof fetch {
  return async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const endpoint = proxyUrl || resolveFetchProxyUrl();
    if (!endpoint) {
      throw new TypeError(
        "No fetch proxy configured. WebContainer cannot bypass CORS. " +
          "Set Settings → Fetch proxy URL to a Cloudflare Worker " +
          "(see packages/playground/workers/fetch-proxy), or use pnpm dev:playground (built-in proxy)."
      );
    }

    const payload = {
      url: resolveUrl(input),
      method: init?.method ?? (input instanceof Request ? input.method : "GET"),
      headers: collectHeaders(input, init),
      body: await readBody(input, init),
    };

    let proxyRes: Response;
    try {
      proxyRes = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: init?.signal,
      });
    } catch (err) {
      if (init?.signal?.aborted) {
        throw new DOMException("The operation was aborted.", "AbortError");
      }
      throw new TypeError(
        `Fetch proxy unreachable (${endpoint}): ${err instanceof Error ? err.message : String(err)}. ` +
          "For GitHub Pages, deploy packages/playground/workers/fetch-proxy and set Fetch proxy URL / VITE_FETCH_PROXY_URL."
      );
    }

    const contentType = proxyRes.headers.get("content-type") ?? "";
    if (!contentType.includes("application/json")) {
      throw new TypeError(
        `Fetch proxy at ${endpoint} returned HTTP ${proxyRes.status} (not JSON). ` +
          "GitHub Pages has no /__fetch_proxy — deploy the Cloudflare Worker and set VITE_FETCH_PROXY_URL " +
          "(or Settings → Fetch proxy URL) to https://<your-worker>.workers.dev"
      );
    }

    const data = (await proxyRes.json()) as ProxyFetchResponse;
    if (!proxyRes.ok || !data.ok) {
      throw new TypeError(data.error ?? `Fetch proxy returned HTTP ${proxyRes.status}`);
    }

    const bytes = data.body ? decodeBase64(data.body) : new Uint8Array();
    return new Response(bytes as BodyInit, {
      status: data.status ?? 500,
      statusText: data.statusText ?? "",
      headers: data.headers,
    });
  };
}
