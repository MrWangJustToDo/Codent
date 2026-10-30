/**
 * Validation for ExtensionRunner render-slot ownership cleanup.
 *
 * Covers:
 * - ctx.ui.render writes a surface slot and notifies `render`
 * - the slot is attributed to the owning extension (via the per-extension UI wrapper)
 * - disabling the extension (setEnabled(false) → destroyExtension) clears its slots
 *   and notifies the host with a null payload (remove signal)
 * - slots from other extensions survive
 * - raw text and layout-tree payloads both round-trip untouched
 * - destroyAll clears every slot
 *
 * Run: pnpm --filter @codent/core run validate:extension-render-owner
 */

import assert from "node:assert/strict";

import { ExtensionRunner } from "../dist/dev.mjs";

/** Render notifications are coalesced (100ms window) — wait for the flush. */
const flushUi = () => new Promise((resolve) => setTimeout(resolve, 150));

// --- Helpers: a fake extension factory that renders a slot on activate --------
function renderExtension(id, key, payload) {
  return {
    id,
    name: id,
    version: "1.0.0",
    description: "render-slot test extension",
    async activate(ctx) {
      ctx.ui.render("footer", key, payload);
    },
  };
}

const notifications = [];
const runner = new ExtensionRunner({});

// Subscribe to the shared UI (as a host would).
runner.getUI().subscribe("render", (data) => notifications.push(data));

// --- Activate extensions that each render their own slot ----------------------
const extA = renderExtension("ext-a", "lsp", "LSP: typescript ready");
const extB = renderExtension("ext-b", "mem", "memory: 12 items");
const tree = { type: "row", gap: 1, children: [{ type: "text", value: "ok" }] };
const extC = renderExtension("ext-c", "tree", tree);

await runner.loadExtension(extA);
await runner.loadExtension(extB);
await runner.loadExtension(extC);
await flushUi();

assert.deepEqual(
  runner.getUISlots(),
  {
    footer: {
      lsp: "LSP: typescript ready",
      mem: "memory: 12 items",
      tree,
    },
  },
  "every extension's slot is present (raw text and layout tree)"
);

// --- Disabling ext-a clears only its own slot ---------------------------------
notifications.length = 0;
const result = await runner.setEnabled("ext-a", false);
assert.equal(result.ok, true, "disabling ext-a succeeds");
await flushUi();

assert.deepEqual(
  runner.getUISlots(),
  {
    footer: {
      mem: "memory: 12 items",
      tree,
    },
  },
  "ext-a slot cleared, other extensions' slots remain"
);

assert.ok(
  notifications.some((n) => n.key === "lsp" && n.payload === null),
  "host received a null-payload render for the disabled extension's key"
);

// --- Re-enabling ext-a re-writes its slot (owner re-attribution works) --------
await runner.setEnabled("ext-a", true);
assert.equal(runner.getUISlots().footer.lsp, "LSP: typescript ready", "re-enabling ext-a restores its slot");

// --- destroyAll clears everything ---------------------------------------------
notifications.length = 0;
await runner.destroyAll();
await flushUi();
assert.deepEqual(runner.getUISlots(), {}, "destroyAll clears every slot");
assert.ok(notifications.filter((n) => n.payload === null).length >= 3, "destroyAll notifies removal for every slot");

// --- Same key across extensions: the LAST publish owns the slot ----------------
//
// An identical payload must not skip the ownership transfer. The dedupe early-return skips the
// host NOTIFICATION, not the attribution: attributing after it left the slot owned by the first
// publisher, so disabling that one cleared a slot the second one had just published, and disabling
// the second left its content on screen. Both directions are asserted — a fix in either direction
// alone would still pass half of this.
{
  const runner3 = new ExtensionRunner({});
  await runner3.loadExtension(renderExtension("ext-first", "shared", "same content"));
  await runner3.loadExtension(renderExtension("ext-second", "shared", "same content"));
  await flushUi();

  assert.equal(runner3.getUISlots().footer?.shared, "same content", "the shared slot renders once");

  const disabledFirst = await runner3.setEnabled("ext-first", false);
  assert.equal(disabledFirst.ok, true, "disabling the earlier publisher succeeds");
  await flushUi();
  assert.equal(
    runner3.getUISlots().footer?.shared,
    "same content",
    "disabling the earlier publisher leaves the slot to its actual owner"
  );

  await runner3.setEnabled("ext-second", false);
  await flushUi();
  assert.equal(
    runner3.getUISlots().footer?.shared,
    undefined,
    "disabling the later publisher clears the slot it took ownership of"
  );
  await runner3.destroyAll();
}

// --- Non-serializable payloads are rejected at publish time --------------------
// A payload that cannot survive JSON round-tripping would be replayed to late
// subscribers and forwarded to remote hosts outside this publish path, so it must
// never reach the retained slots.
{
  const runner2 = new ExtensionRunner({});
  const circular = { type: "column", children: [] };
  circular.children.push(circular);

  await runner2.loadExtension({
    id: "ext-bad",
    name: "bad",
    version: "1.0.0",
    description: "publishes unserializable payloads",
    activate(ctx) {
      ctx.ui.render("footer", "circular", circular);
      ctx.ui.render("footer", "fn", { type: "text", value: "x", onClick: () => {} });
      ctx.ui.render("footer", "bigint", { type: "text", value: "x", n: 1n });
      ctx.ui.render("footer", "ok", "fine");
    },
  });
  await flushUi();

  const footer = runner2.getUISlots().footer ?? {};
  assert.equal(footer.circular, undefined, "circular payload is rejected, not retained");
  assert.equal(footer.fn, undefined, "function-valued payload is rejected, not retained");
  assert.equal(footer.bigint, undefined, "bigint-valued payload is rejected, not retained");
  assert.equal(footer.ok, "fine", "a serializable payload is still accepted");

  // Retained slots must stay JSON-round-trippable for the replay/remote paths.
  assert.doesNotThrow(() => JSON.stringify(runner2.getUISlots()), "retained slots stay serializable");
  await runner2.destroyAll();
}

console.log("extension-render-owner validation passed");
