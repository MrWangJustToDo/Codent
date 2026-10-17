/**
 * The builtin commands a headless client can invoke must do what their advertised usage says.
 *
 * `/mode` was the failure: the catalog advertises
 * `plan|auto|off|switch plan|switch auto|status|execute|done|cancel|save|load|list`, but this host
 * recognised only `plan|auto|off` and mapped **everything else to `mode.toggle`** — a client that
 * picked `/mode execute` flipped the mode instead of building the plan. `/resume <name>` (documented)
 * only accepted an id, and `/effort display` forwarded `display` as a reasoning level.
 *
 * The grammar now lives in core (`parseModeCommand` / `parseEffortCommand` / `resolveSessionRef`);
 * this gate asserts the host DISPATCHES what the intent says, not just that the parser works (the
 * parser has its own gate: `validate:builtin-command-arguments`).
 *
 * Run: node scripts/validate-acp-command-args.mjs
 */

import { client as createClient, methods } from "@agentclientprotocol/sdk";

import { createAcpAgent } from "../dist/index.mjs";

import { createChecker, finish } from "./acp-report.mjs";
import { baseSnapshot } from "./session-fixture.mjs";

const checker = createChecker();
const check = checker.check;

const SAVED_PLAN = ".agents/plans/my-plan.md";

function makeSession(id) {
  const listeners = new Set();
  let dispatched = [];
  const session = {
    id,
    getSnapshot: () =>
      baseSnapshot(id, {
        modelInfo: { name: "test-model", reasoningConfig: { effortValues: ["low", "medium", "high"] } },
        reasoningEffort: "medium",
      }),
    getSummaryStreamSnapshot: () => null,
    subscribe: (handler) => {
      listeners.add(handler);
      return () => listeners.delete(handler);
    },
    dispatch: async (command) => {
      dispatched.push(command);
      switch (command.type) {
        case "session.list":
          return {
            ok: true,
            data: { sessions: [{ id: "ses_saved", name: "Saved Session", model: "m", updatedAt: 1 }] },
          };
        case "plan.execute":
          return { ok: true, data: { queued: false } };
        case "plan.save":
          return { ok: true, data: { path: SAVED_PLAN } };
        case "plan.load":
          return { ok: true, data: { path: SAVED_PLAN, stepCount: 3 } };
        case "plan.list":
          return { ok: true, data: { files: ["my-plan.md"] } };
        default:
          return { ok: true };
      }
    },
    /** The commands dispatched since the last reset. */
    take: () => {
      const seen = dispatched;
      dispatched = [];
      return seen;
    },
  };
  return session;
}

const session = makeSession("s-commands");
const commandMessages = [];
const client = createClient({ name: "command-client" }).onNotification(methods.client.session.update, (ctx) => {
  const update = ctx.params.update;
  if (update.sessionUpdate === "agent_message_chunk" && update.content?.type === "text") {
    commandMessages.push(update.content.text);
  }
});

const app = createAcpAgent({
  host: {
    async create() {
      return { session };
    },
    connect: () => null,
    list: () => [],
    async destroy() {},
  },
  defaults: { model: "fake-model" },
  rootPath: "/ws",
});

await client.connectWith(app, async (cx) => {
  await cx.request(methods.agent.initialize, { protocolVersion: 1, clientCapabilities: {} });
  const started = await cx.request(methods.agent.session.new, { cwd: "/ws", mcpServers: [] });

  const run = async (text) => {
    commandMessages.length = 0;
    await cx.request(methods.agent.session.prompt, {
      sessionId: started.sessionId,
      prompt: [{ type: "text", text }],
    });
    return { commands: session.take(), message: commandMessages.join("") };
  };

  // --- /mode: every advertised subcommand routes to its plan command, never to a mode toggle ------

  for (const [raw, expected] of [
    ["/mode execute", "plan.execute"],
    ["/mode done", "plan.complete"],
    ["/mode cancel", "plan.cancel"],
    ["/mode save my-plan", "plan.save"],
    ["/mode load my-plan", "plan.load"],
    ["/mode list", "plan.list"],
  ]) {
    const { commands } = await run(raw);
    check(
      `${raw} dispatches ${expected} (not a mode toggle)`,
      commands.length === 1 && commands[0].type === expected,
      commands.map((c) => c.type).join(",")
    );
  }

  const save = await run("/mode save my-plan");
  check(
    "…and the plan name reaches the command",
    save.commands[0]?.nameHint === "my-plan",
    JSON.stringify(save.commands)
  );

  const load = await run("/mode load my-plan");
  check("a load carries its name", load.commands[0]?.name === "my-plan");

  const status = await run("/mode status");
  check("status reports the mode instead of toggling it", /^Mode: /.test(status.message), status.message);

  const toggle = await run("/mode");
  check(
    "no argument still toggles (the interactive cycle)",
    toggle.commands.length === 1 && toggle.commands[0].type === "mode.toggle"
  );

  const unknown = await run("/mode bogus");
  check("an unknown subcommand reports usage and dispatches nothing", unknown.commands.length === 0, unknown.message);
  check("…with the usage text", unknown.message.includes("Usage: /mode"), unknown.message);

  // --- /resume: the documented id-or-name query ------------------------------------------------

  const resumed = await run("/resume Saved Session");
  check(
    "/resume <name> resolves the id before dispatching",
    resumed.commands.some((c) => c.type === "session.resume" && c.sessionId === "ses_saved"),
    JSON.stringify(resumed.commands)
  );

  const missing = await run("/resume nope");
  check("an unknown name does not dispatch a resume", !missing.commands.some((c) => c.type === "session.resume"));

  // --- /effort: display is UI state, values are validated against the model ---------------------

  const display = await run("/effort display");
  check(
    "/effort display is not forwarded as a reasoning level",
    !display.commands.some((c) => c.type === "effort.set"),
    JSON.stringify(display.commands)
  );

  const unsupported = await run("/effort max");
  check(
    "a level the model does not advertise is refused",
    !unsupported.commands.some((c) => c.type === "effort.set") && /does not support/.test(unsupported.message),
    unsupported.message
  );

  const supported = await run("/effort high");
  check(
    "a supported level is dispatched",
    supported.commands.some((c) => c.type === "effort.set" && c.effort === "high"),
    JSON.stringify(supported.commands)
  );
});

finish(checker.failures);
