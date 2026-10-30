/**
 * Extension notices published before a host subscribed must still reach that host.
 *
 * `notify` retains nothing (unlike render slots), and extension activation runs inside
 * `createSession`. A language server that becomes ready in that window — measured 52 ms after
 * activation for the TypeScript server — used to report into the void: the host subscribes when the
 * session lands in its store, which is strictly later. The session now hands the pending notices to
 * the first `extension-ui` subscriber and forgets them.
 *
 * Run: pnpm --filter @codent/core run validate:extension-ui-notices
 */

import assert from "node:assert/strict";

import { ExtensionRunner, createAgentEventBus, createLocalAgentSession } from "../dist/dev.mjs";

const AGENT_ID = "agent_notice";

/** A session over a real bus + real runner; only what `subscribe` reads is provided. */
function sessionWith(runner, bus) {
  const managed = {
    id: AGENT_ID,
    parentId: undefined,
    getEventBus: () => bus,
    getExtensionRunner: () => runner,
  };
  return createLocalAgentSession({ managed, manager: null });
}

function collect(session) {
  const seen = [];
  const unsub = session.subscribe((event) => seen.push(event.payload), { channels: ["extension-ui"] });
  return { seen, unsub };
}

const notices = (seen) => seen.filter((payload) => payload.type === "notify").map((p) => `${p.level}:${p.message}`);

// 1. A notice published before the subscription is delivered to it (the startup race).
{
  const bus = createAgentEventBus(AGENT_ID);
  const runner = new ExtensionRunner({ eventBus: bus, agentId: AGENT_ID });
  runner.getUI().notify("LSP: typescript ready", "success");
  const session = sessionWith(runner, bus);

  const { seen, unsub } = collect(session);
  assert.deepEqual(notices(seen), ["success:LSP: typescript ready"]);
  unsub();
}

// 2. Pending notices are consumed: a re-subscribe (the editor-handoff remount) is not a replay.
{
  const bus = createAgentEventBus(AGENT_ID);
  const runner = new ExtensionRunner({ eventBus: bus, agentId: AGENT_ID });
  runner.getUI().notify("pending", "info");
  const session = sessionWith(runner, bus);

  const first = collect(session);
  assert.deepEqual(notices(first.seen), ["info:pending"]);
  first.unsub();

  // Live notices between mounts do NOT accumulate for the next attach either: with a host already
  // on this session they were delivered (or the host was knowingly away).
  runner.getUI().notify("while unmounted", "info");

  const second = collect(session);
  assert.deepEqual(notices(second.seen), []);
  second.unsub();
}

// 3. A notice published while a host is subscribed still arrives live (no double delivery).
{
  const bus = createAgentEventBus(AGENT_ID);
  const runner = new ExtensionRunner({ eventBus: bus, agentId: AGENT_ID });
  const session = sessionWith(runner, bus);

  const { seen, unsub } = collect(session);
  runner.getUI().notify("live", "error");
  assert.deepEqual(notices(seen), ["error:live"]);
  unsub();
}

// 4. The pending buffer is bounded, and the bound keeps the NEWEST notices.
{
  const bus = createAgentEventBus(AGENT_ID);
  const runner = new ExtensionRunner({ eventBus: bus, agentId: AGENT_ID });
  for (let i = 0; i < 24; i++) runner.getUI().notify(`n${i}`, "info");
  const session = sessionWith(runner, bus);

  const { seen, unsub } = collect(session);
  const delivered = notices(seen);
  assert.equal(delivered.length, 16, `expected the buffer bound (16), got ${delivered.length}`);
  assert.equal(delivered[0], "info:n8");
  assert.equal(delivered[delivered.length - 1], "info:n23");
  unsub();
}

// 5. Render slots still replay on subscribe (the pre-existing reconcile path is unchanged), and a
// pending notice rides alongside them.
{
  const bus = createAgentEventBus(AGENT_ID);
  const runner = new ExtensionRunner({ eventBus: bus, agentId: AGENT_ID });
  runner.getUI().render("footer", "badge", "jobs: 1");
  runner.getUI().notify("slot and notice", "info");
  const session = sessionWith(runner, bus);

  const { seen, unsub } = collect(session);
  assert.deepEqual(
    seen.map((payload) => payload.type),
    ["render", "notify"]
  );
  assert.equal(seen[0].surface, "footer");
  assert.equal(seen[0].payload, "jobs: 1");
  unsub();
}

console.log("extension-ui-notices: 5/5 checks passed");
