/* global console: readonly */
/**
 * Validates preview-port list helpers (open / ready / close + active fallback).
 *
 * Imports the REAL helpers from `use-preview-ports.ts`. The previous version re-implemented them
 * in this file, so a regression in the hook's reducer could not fail this validation.
 *
 * Run: pnpm --filter @codent/playground validate:preview-ports
 */
import assert from "node:assert/strict";

import { markPortReady, removePort, upsertPortOpen } from "../src/hooks/use-preview-ports.ts";

// ----------------------------------------------------------------------------
// Open: sorted by port, and `ready` is preserved on an existing entry
// ----------------------------------------------------------------------------
let ports = [];
ports = upsertPortOpen(ports, 5173, "https://a.local");
assert.deepEqual(
  ports.map((p) => [p.port, p.ready]),
  [[5173, false]],
  "a port that is only open is not ready"
);

ports = upsertPortOpen(ports, 3000, "https://b.local");
assert.deepEqual(
  ports.map((p) => p.port),
  [3000, 5173],
  "the list is kept sorted by port"
);

// Re-opening a ready port must not drop `ready` (the preview URL can change while it stays up).
ports = markPortReady(ports, 5173, "https://a.local/ready");
ports = upsertPortOpen(ports, 5173, "https://a.local/reopened");
assert.equal(ports.find((p) => p.port === 5173).ready, true, "re-opening preserves `ready`");
assert.equal(ports.find((p) => p.port === 5173).url, "https://a.local/reopened", "…and takes the new url");

// ----------------------------------------------------------------------------
// Ready: inserts when unknown, updates url + ready when known
// ----------------------------------------------------------------------------
let readyOnly = markPortReady([], 8080, "https://c.local");
assert.deepEqual(
  readyOnly.map((p) => [p.port, p.ready]),
  [[8080, true]],
  "a ready event for an unseen port inserts it as ready"
);

readyOnly = markPortReady(readyOnly, 8080, "https://c.local/v2");
assert.equal(readyOnly.find((p) => p.port === 8080).url, "https://c.local/v2", "the ready url wins");

// ----------------------------------------------------------------------------
// Pure updates: the previous array is never mutated
// ----------------------------------------------------------------------------
const before = [...ports];
upsertPortOpen(ports, 9999, "https://d.local");
markPortReady(ports, 5173, "https://a.local/other");
assert.deepEqual(ports, before, "the helpers must return a new array, not mutate in place");

// ----------------------------------------------------------------------------
// Close: drops the port and reports the next active port (first remaining)
// ----------------------------------------------------------------------------
let closed = removePort(readyOnly, 8080);
assert.deepEqual(closed.ports, [], "closing the only port empties the list");
assert.equal(closed.nextActive, null, "no remaining port means no active preview");

closed = removePort(ports, 3000);
assert.deepEqual(
  closed.ports.map((p) => p.port),
  [5173],
  "closing a port removes exactly that one"
);
assert.equal(closed.nextActive, 5173, "the first remaining port becomes active");

// Closing an unknown port is inert but still reports the current active port.
const noop = removePort(closed.ports, 12345);
assert.deepEqual(
  noop.ports.map((p) => p.port),
  [5173]
);
assert.equal(noop.nextActive, 5173);

console.log("validate-preview-ports: ok");
