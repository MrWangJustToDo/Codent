/**
 * The builtin commands a headless client can invoke must do what their advertised usage says.
 *
 * `/mode` was the failure: the catalog advertises
 * `plan|auto|off|switch plan|switch auto|status|execute|done|cancel|save|load|list`, but this host
 * recognised only `plan|auto|off` and mapped **everything else to `mode.toggle`** — a client that
 * picked `/mode execute` flipped the mode instead of building the plan. `/resume <name>` (documented)
 * only accepted an id, and `/effort display` forwarded `display` as a reasoning level.
 *
 * The grammar now lives in core (`parseModeCommand` / `parseModelsCommand` / `resolveSessionRef`);
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
  // Mutable so `model.set` / `effort.set` are visible to later reads, exactly as a real session
  // behaves — `/models` validates the depth against the model it just switched TO.
  let snapshot = baseSnapshot(id, {
    modelInfo: {
      name: "test-model",
      capabilities: ["reasoning", "tool_calling"],
      reasoningConfig: { effortValues: ["low", "medium", "high"] },
    },
    reasoningEffort: "medium",
  });
  const session = {
    id,
    getSnapshot: () => snapshot,
    getAgentStreamSnapshot: () => null,
    subscribe: (handler) => {
      listeners.add(handler);
      return () => listeners.delete(handler);
    },
    dispatch: async (command) => {
      dispatched.push(command);
      switch (command.type) {
        case "model.set":
          // The switch must MOVE the snapshot: the slash path re-advertises from state afterwards, so a
          // fake that swallowed `model.set` would make "reads the state" and "echoes the request"
          // indistinguishable.
          snapshot = {
            ...snapshot,
            model: command.model,
            ...(command.modelInfo !== undefined ? { modelInfo: command.modelInfo ?? undefined } : {}),
          };
          return { ok: true, data: { model: command.model } };
        case "effort.set":
          snapshot = { ...snapshot, reasoningEffort: command.effort };
          return { ok: true, data: { effort: command.effort } };
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
        // Lifecycle commands answer with STRUCTURED data, which is exactly why the host has to turn it
        // into text itself — the shapes here are the real ones (`session-resume` returns the restored
        // conversation, `rename` only the new name).
        case "session.new":
          return { ok: true, data: { sessionId: "ses_new" } };
        case "session.resume":
          return {
            ok: true,
            data: { sessionId: command.sessionId, name: "Saved Session", model: "m", uiMessages: [] },
          };
        case "session.clone":
          return {
            ok: true,
            data: { sessionId: "ses_clone", name: command.name ?? "clone", model: "m", uiMessages: [] },
          };
        case "rename":
        case "rename.generate":
          return { ok: true, data: { name: command.name ?? "generated title" } };
        case "compact":
          return { ok: true, data: { message: "Compacted 40 messages into a summary" } };
        case "usage.history":
          return { ok: true, data: { weeks: command.weeks ?? 12, daily: [], models: [] } };
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
const commandUpdates = [];
const client = createClient({ name: "command-client" }).onNotification(methods.client.session.update, (ctx) => {
  const update = ctx.params.update;
  if (update.sessionUpdate === "agent_message_chunk" && update.content?.type === "text") {
    commandMessages.push(update.content.text);
  }
  commandUpdates.push(ctx.params);
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
  // One runtime read, projected by both the selectors and `/models` — the fixture is what makes
  // "switch then validate the depth against the NEW model" observable at all.
  models: {
    entries: [
      {
        type: "direct",
        style: "openai",
        baseURL: "https://upstream.test/v1",
        apiKey: "sk-test",
        models: ["test-model", "other-model"],
      },
    ],
  },
  modelsDefaultEntryIndex: 0,
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

  // --- /models: one command for the model AND its thinking depth -------------------------------
  //
  // `/effort` is gone from the catalog, so a headless client reaches depth through `/models` (and
  // through the `thought_level` config option, which has its own gate). The dispatch order matters:
  // the model switch happens FIRST, and the depth is validated against the model it switched to.

  const listed = await run("/models");
  check(
    "/models with no argument lists the entries and dispatches nothing",
    listed.commands.length === 0 && /^Models:/m.test(listed.message),
    listed.message
  );

  // One command, two effects — and the ORDER is the contract: the model switch happens first, then
  // the depth is validated against the model it switched TO (the old model's list says nothing about
  // the new one). The fake session records both dispatches, so the order is observable.
  const both = await run("/models 0:other-model high");
  check(
    "/models dispatches model.set then effort.set",
    both.commands.length === 2 &&
      both.commands[0].type === "model.set" &&
      both.commands[0].model === "other-model" &&
      both.commands[0].modelBaseURL === "https://upstream.test/v1" &&
      both.commands[1].type === "effort.set" &&
      both.commands[1].effort === "high",
    JSON.stringify(both.commands)
  );

  const cleared = await run("/models 0:other-model off");
  check(
    "/models … off clears the depth instead of setting a level called off",
    cleared.commands.some((c) => c.type === "effort.set" && c.effort === undefined),
    JSON.stringify(cleared.commands)
  );

  const badLevel = await run("/models 0:other-model turbo");
  check(
    "an unknown level is refused before any dispatch",
    badLevel.commands.length === 0 && /Unknown \/models argument/.test(badLevel.message),
    `${JSON.stringify(badLevel.commands)} ${badLevel.message}`
  );

  const noDepth = await run("/models 0:test-model");
  check(
    "a model-only switch (different model) leaves the depth alone",
    noDepth.commands.length === 1 &&
      noDepth.commands[0].type === "model.set" &&
      noDepth.commands[0].model === "test-model",
    JSON.stringify(noDepth.commands)
  );

  // The slash path must re-advertise too. `set_config_option` does it from its own handler, but a
  // prompt-issued command returns early with the command's text — so without an explicit advertise
  // the client keeps rendering the OLD model and depth in its selectors until something else moves.
  session.take();
  commandUpdates.length = 0;
  const viaSlash = await run("/models 0:other-model high");
  check(
    "a slash-issued /models switch emits config_option_update",
    commandUpdates.some((u) => u.update.sessionUpdate === "config_option_update"),
    `${JSON.stringify(viaSlash.commands.map((c) => c.type))} updates=${commandUpdates.length}`
  );
  const slashOptions = commandUpdates.filter((u) => u.update.sessionUpdate === "config_option_update").at(-1)
    ?.update.configOptions;
  check(
    "…and it names the NEW model",
    slashOptions?.find((o) => o.category === "model")?.currentValue === "0:other-model",
    JSON.stringify(slashOptions?.find((o) => o.category === "model")?.currentValue)
  );
  check(
    "…and carries the whole option set (no incremental form exists)",
    Boolean(slashOptions?.some((o) => o.category === "mode")),
    JSON.stringify(slashOptions?.map((o) => o.category))
  );

  // A command that changes NOTHING must stay silent — the client's cache is already correct and a
  // re-broadcast is noise the user cannot act on.
  commandUpdates.length = 0;
  await run("/models");
  check(
    "a read-only command emits no config_option_update",
    commandUpdates.filter((u) => u.update.sessionUpdate === "config_option_update").length === 0,
    `updates=${commandUpdates.length}`
  );

  // A re-selection of the CURRENT model is a no-op: the client already holds that value and a
  // metadata re-resolution for nothing is the bug task 3.3 fixed.
  const reselect = await run("/models 0:other-model");
  check(
    "re-selecting the current model dispatches nothing",
    reselect.commands.length === 0,
    JSON.stringify(reselect.commands)
  );

  // A bare id is the natural way to type it; the parser accepts it and the host resolves it against
  // the catalog. `applyModel` alone only accepts a bare value equal to the CURRENT model (the
  // "current model missing from the catalog" case), so without the resolution step this failed with
  // "Unknown model" for an id that is right there in the catalog.
  const bare = await run("/models test-model high");
  check(
    "a bare model id resolves to its entry before applyModel",
    bare.commands.some(
      (c) => c.type === "model.set" && c.model === "test-model" && c.modelBaseURL === "https://upstream.test/v1"
    ) && bare.commands.some((c) => c.type === "effort.set" && c.effort === "high"),
    JSON.stringify(bare.commands)
  );

  // `/effort` must not be advertised (and so must not resolve): the catalog is the single source.
  // An unadvertised slash command falls through to the model as an ordinary prompt — the point is
  // that nothing dispatches `effort.set`, not which wording the fallthrough uses.
  const effort = await run("/effort high");
  check(
    "/effort no longer dispatches effort.set (it is not a builtin)",
    !effort.commands.some((c) => c.type === "effort.set"),
    JSON.stringify(effort.commands.map((c) => c.type))
  );
  {
    const { BUILTIN_COMMAND_CATALOG } = await import("@codent/core");
    check(
      "the catalog no longer advertises /effort",
      !BUILTIN_COMMAND_CATALOG.some((entry) => entry.name === "effort"),
      BUILTIN_COMMAND_CATALOG.map((entry) => entry.name).join(",")
    );
  }

  // --- Every advertised command answers the client ---------------------------------------------
  //
  // The failure this pins: `/usage`, `/rename`, `/new`, `/resume` and `/clone` all reached their
  // session command and returned `handled: true` with NO text, because those commands answer with
  // structured data (`{ sessionId }`, `{ name }`, the usage aggregate) instead of prose. ACP has no
  // panel to draw, so on the client side a command with no text is a command that does nothing —
  // `/usage` looked broken while it quietly dispatched `usage.history`.
  //
  // Text is the assertion, not the only legal answer: a mode toggle legitimately reports through the
  // `mode` selector instead, and a read-only command (`/mode status`, a bare `/models`) dispatches
  // nothing at all. So each advertised command names the evidence it must produce — and a catalog
  // entry with no row fails, because adding a command without deciding how it answers is the bug this
  // gate exists to catch.
  const ANSWERS = {
    new: { args: "", text: /Started a new session/, dispatches: true },
    resume: { args: "Saved Session", text: /Resumed "Saved Session"/, dispatches: true },
    clone: { args: "probe clone", text: /Cloned this session into "probe clone"/, dispatches: true },
    compact: { args: "", text: /Compacted 40 messages/, dispatches: true },
    rename: { args: "probe title", text: /Renamed this session to "probe title"/, dispatches: true },
    mode: { args: "status", text: /^Mode: /, dispatches: false },
    models: { args: "", text: /^Models:/, dispatches: false },
    usage: { args: "", text: /Session lifetime/, dispatches: true },
  };

  {
    const { listAdvertisableCommands } = await import("@codent/core");
    const advertised = listAdvertisableCommands().map((entry) => entry.name);
    const missing = advertised.filter((name) => !(name in ANSWERS));
    check(
      "every advertised builtin has an expected answer in this gate",
      missing.length === 0,
      missing.length > 0 ? `missing: ${missing.join(",")}` : `${advertised.length} commands`
    );
    const extra = Object.keys(ANSWERS).filter((name) => !advertised.includes(name));
    check(
      "…and this gate does not assert a command the catalog stopped advertising",
      extra.length === 0,
      extra.join(",")
    );
  }

  for (const [name, expected] of Object.entries(ANSWERS)) {
    const slash = `/${name}${expected.args ? ` ${expected.args}` : ""}`;
    const { commands, message } = await run(slash);
    check(`${slash} answers the client with text`, expected.text.test(message), message || "<<silent>>");
    check(
      expected.dispatches ? `${slash} dispatches a session command` : `${slash} is a read-only command`,
      expected.dispatches ? commands.length > 0 : commands.length === 0,
      JSON.stringify(commands.map((command) => command.type))
    );
  }

  // `/usage [Nw]` is the advertised argument form, so it has to reach the command — it used to be
  // dropped (every call asked for the 12-week default whatever the client typed).
  // A built-in this client cannot run must say so instead of becoming a prompt: `handled: false` fell
  // through to `send`, so a client typing `/help` (a TUI panel) asked the MODEL for help.
  for (const uiOnly of ["/help", "/settings", "/quit", "/fork"]) {
    const answered = await run(uiOnly);
    check(
      `${uiOnly} answers locally instead of being sent to the model`,
      answered.commands.length === 0 && /is not available in this client/.test(answered.message),
      `${JSON.stringify(answered.commands.map((c) => c.type))} ${answered.message || "<<silent>>"}`
    );
  }

  const fourWeeks = await run("/usage 4w");
  check(
    "/usage 4w carries the span to usage.history",
    fourWeeks.commands.some((command) => command.type === "usage.history" && command.weeks === 4),
    JSON.stringify(fourWeeks.commands)
  );
  check("…and the report names the same window", /Global activity \(4w\)/.test(fourWeeks.message), fourWeeks.message);

  const badUsage = await run("/usage forever");
  check(
    "an unknown /usage argument reports usage and dispatches nothing",
    badUsage.commands.length === 0 && /Usage: \/usage/.test(badUsage.message),
    `${JSON.stringify(badUsage.commands)} ${badUsage.message}`
  );
});

finish(checker.failures);
