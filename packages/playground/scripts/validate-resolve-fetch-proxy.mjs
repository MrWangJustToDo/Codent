/* global process: readonly */
/**
 * Validates the fetch-proxy endpoint priority table.
 *
 * Imports the REAL `pickFetchProxyUrl` / `resolveFetchProxyUrl`. The previous version defined a
 * four-argument copy in this file with a different signature from anything in production, so it
 * could pass while the shipped priority order was wrong.
 *
 * Run: pnpm --filter @codent/playground validate:resolve-fetch-proxy
 */
import assert from "node:assert/strict";

import {
  getFetchProxyUrl,
  pickFetchProxyUrl,
  resolveFetchProxyUrl,
  setFetchProxyUrl,
} from "../src/webcontainer/create-proxy-fetch.ts";

const ORIGIN = "http://localhost:5177";

// ----------------------------------------------------------------------------
// Priority: a user setting beats the build-time env, which beats the dev middleware
// ----------------------------------------------------------------------------
assert.equal(
  pickFetchProxyUrl({
    configured: "https://proxy.example/worker",
    envUrl: "https://env.example",
    dev: true,
    origin: ORIGIN,
  }),
  "https://proxy.example/worker",
  "the settings value wins over both the build-time env and dev middleware"
);

assert.equal(
  pickFetchProxyUrl({ configured: "", envUrl: "https://env.example", dev: true, origin: ORIGIN }),
  "https://env.example",
  "an empty setting falls through to VITE_FETCH_PROXY_URL"
);

assert.equal(
  pickFetchProxyUrl({ configured: "", envUrl: "", dev: true, origin: ORIGIN }),
  `${ORIGIN}/__fetch_proxy`,
  "with no configured endpoint, dev falls back to the Vite middleware"
);

assert.equal(
  pickFetchProxyUrl({ configured: "", envUrl: "", dev: false }),
  "",
  "static hosting (GitHub Pages) has no middleware, so it resolves to empty"
);

// ----------------------------------------------------------------------------
// Trimming: whitespace-only is not a setting
// ----------------------------------------------------------------------------
assert.equal(pickFetchProxyUrl({ configured: "  https://proxy.example  ", dev: false }), "https://proxy.example");
assert.equal(
  pickFetchProxyUrl({ configured: "   ", envUrl: " https://env.example ", dev: false }),
  "https://env.example"
);
assert.equal(pickFetchProxyUrl({ configured: "   ", envUrl: "  ", dev: false }), "");

// ----------------------------------------------------------------------------
// Dev mode without an origin is a wiring bug, not a silent empty endpoint
// ----------------------------------------------------------------------------
assert.throws(
  () => pickFetchProxyUrl({ dev: true }),
  /origin/i,
  "dev mode with no origin must fail loudly instead of emitting a broken proxy url"
);

// ----------------------------------------------------------------------------
// The module-level override (`setFetchProxyUrl`) is trimmed and read back verbatim
// ----------------------------------------------------------------------------
setFetchProxyUrl("  https://runtime.example/worker  ");
assert.equal(getFetchProxyUrl(), "https://runtime.example/worker", "the runtime override is trimmed");
setFetchProxyUrl("");
assert.equal(getFetchProxyUrl(), "", "it can be cleared");

// ----------------------------------------------------------------------------
// The exported wrapper is wired to the table (and is importable outside Vite)
// ----------------------------------------------------------------------------
assert.equal(
  resolveFetchProxyUrl(" https://proxy.example/worker "),
  "https://proxy.example/worker",
  "the wrapper must apply the settings branch of the real table"
);
// Under plain Node there is no `import.meta.env` and no DOM: dev is false, so the answer is the
// static-hosting one. This asserts the wrapper does not throw and does not invent an endpoint.
assert.equal(resolveFetchProxyUrl(), "", "no sources at all resolves to empty, not a throw");

process.stdout.write("validate-resolve-fetch-proxy: ok\n");
