/**
 * Validates the process-local disk-session claim table:
 * acquire / conflict / idempotence, owner-scoped release, and destroy's releaseAllFor.
 *
 * Run: pnpm --filter @codent/core run validate:session-ownership
 */

import assert from "node:assert/strict";

import { SessionOwnership } from "../dist/dev.mjs";

const ownership = new SessionOwnership();

assert.equal(ownership.acquire("ses_a", "agent_1"), true);
assert.equal(ownership.ownerOf("ses_a"), "agent_1");
assert.equal(ownership.acquire("ses_a", "agent_1"), true, "same-agent re-acquire is idempotent");
assert.equal(ownership.acquire("ses_a", "agent_2"), false, "a live agent cannot steal a claim");
assert.equal(ownership.ownerOf("ses_a"), "agent_1", "a refused acquire leaves the owner unchanged");

ownership.release("ses_a", "agent_2");
assert.equal(ownership.ownerOf("ses_a"), "agent_1", "a wrong-owner release is a no-op");
ownership.release("ses_a", "agent_1");
assert.equal(ownership.ownerOf("ses_a"), undefined);

assert.equal(ownership.acquire("ses_b", "agent_1"), true);
assert.equal(ownership.acquire("ses_c", "agent_1"), true);
ownership.releaseAllFor("agent_1");
assert.equal(ownership.ownerOf("ses_b"), undefined, "destroy releases every claim for the agent");
assert.equal(ownership.ownerOf("ses_c"), undefined);

assert.equal(ownership.acquire("ses_d", "agent_2"), true);
ownership.releaseAllFor("agent_1");
assert.equal(ownership.ownerOf("ses_d"), "agent_2", "another agent's claims are untouched");

console.log("session-ownership validation passed");
