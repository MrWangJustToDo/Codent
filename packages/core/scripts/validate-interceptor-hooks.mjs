/**
 * Interceptor hook grammar.
 *
 * `registerInterceptor` takes a bare string, so the runtime check is the only thing standing between
 * an extension author and a handler that can never fire. For a `tool:before:*` guard that is a silent
 * FAIL-OPEN: the code looks like it denies the call and the call runs.
 *
 * The subtle half is the wildcard. `interceptorMatches` supports exactly one form — a TRAILING `*` as
 * a prefix match — so `tool:before:*_command` used to pass registration and then match nothing.
 *
 * Run: pnpm --filter @codent/core run validate:interceptor-hooks
 */

import assert from "node:assert/strict";

import { interceptorMatches, isInterceptorHook } from "../dist/dev.mjs";

const valid = [
  "before_agent_start",
  "session:bootstrap",
  "session:shutdown",
  "tool:before:run_command",
  "tool:before:*",
  "tool:before:run_*",
  "tool:after:read_file",
  "tool:error:write_file",
];

for (const hook of valid) {
  assert.equal(isInterceptorHook(hook), true, `"${hook}" is dispatched and must register`);
  // The invariant that makes the grammar worth checking: anything accepted must be able to match at
  // least one concrete name. `interceptorMatches` is the only matcher, so it is the oracle here.
  const probe = hook.endsWith("*") ? `${hook.slice(0, -1)}probe_tool` : hook;
  assert.equal(interceptorMatches(hook, probe), true, `"${hook}" is accepted and must match "${probe}"`);
}

const invalid = [
  // Family typos — the original reason this module exists.
  "tool:befor:run_command",
  "tool:before",
  "before-agent-start",
  // Empty tool name: nothing can match it.
  "tool:before:",
  // Wildcards `interceptorMatches` cannot honour (only a trailing `*` is a prefix match).
  "tool:before:*_command",
  "tool:before:*read*",
  "tool:before:run*cmd",
  "tool:before:**",
];

for (const hook of invalid) {
  assert.equal(isInterceptorHook(hook), false, `"${hook}" cannot match and must be refused at registration`);
  // …and the refusal is not merely pedantic: none of them can match a concrete hook either, which is
  // exactly the silent fail-open the registration check exists to prevent.
  assert.equal(
    interceptorMatches(hook, "tool:before:run_command"),
    false,
    `"${hook}" is refused because it can never match`
  );
}

console.log("interceptor-hooks validation passed");
