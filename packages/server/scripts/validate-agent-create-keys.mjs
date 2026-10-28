/**
 * The remote create plane must not silently drop a contract field.
 *
 * `AgentSessionCreateOptions` is the host contract; a remote-session client's create travels through
 * `RemoteSessionHost.create` (JSON body) and the agent server's `createBodySchema` + route. Those are
 * two hand-written copies, and the local host was already converted to a generic forward precisely
 * because a field-by-field copy silently dropped every new option. Types are erased, so this is a
 * source-level key-set check: every contract field must be accepted by the schema and forwarded by
 * the remote host, unless it is one of the documented exemptions below.
 *
 * Run: pnpm --filter @codent/server run validate:agent-create-keys
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..", "..", "..");

const read = (relative) => readFileSync(join(repo, relative), "utf8");

/**
 * Fields that must NOT cross the HTTP create body:
 * - `extensions` — in-process factories; functions cannot be serialized (`RemoteSessionHost`
 *   rejects them loudly, which is the whole point of the exemption).
 * - `providerMode` — a LOCAL resume decision; the agent server owns its provider.
 */
const EXEMPT = new Set(["extensions", "providerMode"]);

/**
 * The route's body names three connection fields differently (they are mapped onto the server's
 * resolved connection, not copied): `modelStyle` → `style`, `modelBaseURL` → `baseURL`,
 * `modelApiKey` → `apiKey`.
 */
const ROUTE_ALIASES = new Map([
  ["modelStyle", "style"],
  ["modelBaseURL", "baseURL"],
  ["modelApiKey", "apiKey"],
]);

/** Interface member keys at exactly one indent level (nested object types are deeper). */
function contractKeys(source) {
  const start = source.indexOf("export interface AgentSessionCreateOptions {");
  assert.ok(start >= 0, "AgentSessionCreateOptions not found — did the contract move?");
  const end = source.indexOf("\n}", start);
  assert.ok(end > start, "unterminated AgentSessionCreateOptions");
  const body = source.slice(start, end);
  return new Set([...body.matchAll(/^\s{2}([A-Za-z_$][\w$]*)\??:/gm)].map((match) => match[1]));
}

/** Keys of a `z.object({ … })` body at one indent level. */
function schemaKeys(source) {
  const start = source.indexOf("const createBodySchema = z.object({");
  assert.ok(start >= 0, "createBodySchema not found — did the route move?");
  const end = source.indexOf("\n});", start);
  assert.ok(end > start, "unterminated createBodySchema");
  const body = source.slice(start, end);
  return new Set([...body.matchAll(/^\s{2}([A-Za-z_$][\w$]*)\??:/gm)].map((match) => match[1]));
}

/** Keys forwarded by `RemoteSessionHost.create`'s JSON body. */
function remoteForwardedKeys(source) {
  const start = source.indexOf("body: JSON.stringify({");
  assert.ok(start >= 0, "the remote create body was not found — did the host move?");
  const end = source.indexOf("\n        }),", start);
  const body = source.slice(start, end > start ? end : start + 4000);
  const keys = new Set();
  for (const line of body.split("\n")) {
    // `key: …` and `...(cond ? { key: … } : {})` both name a forwarded field.
    for (const match of line.matchAll(/(?:^|[{,\s])([A-Za-z_$][\w$]*)\s*:/g)) keys.add(match[1]);
  }
  return keys;
}

const contract = contractKeys(read("packages/core/src/agent-session/host-types.ts"));
const schema = schemaKeys(read("packages/server/src/routes/agent-session.ts"));
const remote = remoteForwardedKeys(read("packages/server/src/remote-session-host.ts"));

assert.ok(contract.size > 20, `suspiciously few contract fields parsed (${contract.size})`);
assert.ok(schema.size > 15, `suspiciously few create-body fields parsed (${schema.size})`);
assert.ok(remote.size > 15, `suspiciously few forwarded fields parsed (${remote.size})`);

const missingFromSchema = [];
const missingFromRemote = [];
for (const key of contract) {
  if (EXEMPT.has(key)) continue;
  // Both planes use the connection aliases: the remote body must be a body this route accepts.
  const wireKey = ROUTE_ALIASES.get(key) ?? key;
  const suffix = wireKey === key ? "" : ` (as ${wireKey})`;
  if (!schema.has(wireKey)) missingFromSchema.push(`${key}${suffix}`);
  if (!remote.has(wireKey)) missingFromRemote.push(`${key}${suffix}`);
}

assert.deepEqual(
  missingFromSchema,
  [],
  "every AgentSessionCreateOptions field must be accepted by POST /api/agent — add it to createBodySchema (or record a new exemption with a reason)"
);
assert.deepEqual(
  missingFromRemote,
  [],
  "every AgentSessionCreateOptions field must be forwarded by RemoteSessionHost.create — a new option is otherwise silently dropped for remote sessions"
);

// The exemptions must stay exemptions: forwarding them would contradict the documented reason.
for (const key of EXEMPT) {
  assert.equal(remote.has(key), false, `"${key}" is exempt from the remote create body; do not forward it`);
}

console.log(
  `agent-create-keys validation passed (${contract.size} contract fields, ${schema.size} body fields, ${remote.size} forwarded)`
);
