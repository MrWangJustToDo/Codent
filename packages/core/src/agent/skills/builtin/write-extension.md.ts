/**
 * Body text for the built-in `write-extension` skill.
 *
 * Kept in its own module so the skill definition stays small. Everything inside the
 * exported template literal is markdown, so backticks and `${` are escaped.
 *
 * Verified against the implementation, not against `examples/extensions/`:
 * - `ExtensionContext`  → packages/core/src/agent/extension/types.ts
 * - hook names          → middleware/extensions-middleware.ts + extension/runner.ts
 * - `present` fields    → agent/tools/presentation/types.ts
 * `validate:skills-extension` re-checks the API surface this text documents.
 */

import { AGENT_DATA_DIR } from "../../../utils/workspace-paths.js";

export const writeExtensionBody = `# Writing a codent extension

An extension is a module that runs inside the agent's process and can add tools, slash
commands, lifecycle hooks, per-turn context, or UI. Reach for one when the user asks to:

- add a **tool** the model can call
- add a **slash command** (\`/thing\`) the user can run
- **react to** or **block** agent activity (a tool call, the start of a turn, session startup)
- inject **per-turn context** the model sees while a condition holds
- draw into the **host UI** (a footer badge, a notification)

Extensions run in-process, so they are trusted code — they can read files and run commands.

## Where the file goes

Core scans these directories in order, later ids winning — so the most specific source wins:

1. \`~/${AGENT_DATA_DIR}/extension\`    (user home — lowest priority)
2. \`${AGENT_DATA_DIR}/extension\`      (project)
3. \`AGENT_EXTENSION_DIRS\` (comma-separated env var)
4. \`--extension-dirs <dir>\` (CLI flag) / \`extensionDirs\` config — highest priority

Each **file** in those directories is one extension (not a subdirectory), matched by
\`.mjs\` / \`.js\` / \`.cjs\` / \`.ts\`. The id defaults to the file's basename, so
\`my-thing.mjs\` becomes extension id \`my-thing\`.

\`.ts\` extensions need a TS loader (\`node --import tsx …\`); prefer \`.mjs\` for a
portable extension.

## Module shape

The default export can be any of three shapes — pick the first:

\`\`\`js
// 1. An ExtensionAPI object (simplest — one file, no factory)
export default {
  id: "my-ext",
  name: "My Extension",
  version: "1.0.0",
  description: "What it does",
  activate(ctx) { /* register things here */ },
};

// 2. A factory (use when activation needs async setup or per-instance state)
export default {
  async create() {
    const config = await loadSomething();
    return { id: "my-ext", name: "My Extension", version: "1.0.0", description: "…",
             activate(ctx) { /* … */ } };
  },
};

// 3. A bare activate function (id falls back to the file basename)
export default function activate(ctx) { /* … */ }
\`\`\`

\`id\` / \`name\` / \`version\` / \`description\` are required on the object forms; the
loader fills defaults when they are missing. Keep \`id\` stable — it names the
\`<ctx kind=…>\` section, the UI slots, and the enable/disable entry.

\`deactivate()\` is optional and runs when the extension is disabled or destroyed.

\`order\` is an optional number that declares **where this extension runs** — **lower runs
first**, absent means \`0\`. It sequences the flow-sensitive surfaces: interceptor dispatch,
message-transformer chaining, turn-context section position, and same-named tool resolution
(where the **highest** order wins, because a later-running extension supersedes). Leave it
unset unless you have a reason — an undeclared extension keeps the position it would have had,
and only extensions that declare one are reordered. Two rules to keep straight:

- **\`order\` is a dispatch rule** (which position you run in). It is unrelated to the loader's
  **resolution rule** for a duplicated \`id\` above, where the *later* directory wins.
- A cancelling interceptor (\`return false\`, or set \`skipDefault\`) stops **every** interceptor
  after it. If you are a permission gate, declare a small \`order\` (e.g. \`-100\`) so nothing can
  pre-empt you — and know that your own denial suppresses later extensions.

\`\`\`js
export default {
  id: "my-gate",
  name: "My Gate",
  version: "1.0.0",
  description: "Denies a tool before anything else sees it",
  order: -100, // run before every default-ordered extension
  activate(ctx) { /* … */ },
};
\`\`\`

## Copy-paste skeleton

This registers a tool, a command, a hook, and a per-turn section:

\`\`\`js
export default {
  id: "my-ext",
  name: "My Extension",
  version: "1.0.0",
  description: "Example: one tool, one command, one hook, one context section",

  activate(ctx) {
    const { z } = ctx; // use ctx.z — never import zod yourself

    // --- a tool the model can call ---------------------------------------
    ctx.registerTool({
      name: "my_lookup",
      description: "Look up a record by id.",
      inputSchema: z.object({ id: z.string().describe("Record id") }),
      outputSchema: z.object({ value: z.string() }),
      execute: async (input, { abortSignal }) => {
        return { value: await fetchRecord(input.id, abortSignal) };
      },
      present: { text: (r) => \`→ \${r?.value ?? ""}\`, category: "reads" },
    });

    // --- a slash command the user can run --------------------------------
    ctx.registerCommand({
      name: "my-status",
      description: "Show extension status",
      async execute(args) {
        ctx.ui.notify("my-ext: ok", "success");
        return "my-ext: ok"; // returned text is shown to the user
      },
    });

    // --- react to (or block) agent activity ------------------------------
    ctx.registerInterceptor("tool:before:run_command", (event) => {
      if (isForbidden(event.payload.args)) {
        event.skip = true;                       // cancel the call
        event.reason = "Blocked by my-ext";
        return;
      }
      // event.modifiedArgs = { ... }            // rewrite args (ignored for approval-gated tools)
    });

    // --- per-turn context the model sees ---------------------------------
    ctx.registerContextProvider({
      content: () => (enabled ? "current_tenant: acme" : undefined),
      disabledContent: () => "my-ext is disabled — tenant context unavailable.",
    });
  },
};
\`\`\`

## What a handler can reach

Every handler also receives the extension context as a **trailing argument** — \`(event, ctx)\`,
\`(input, opts, ctx)\`, \`(args, ctx)\`, section producers \`(ctx)\` — and it reads live facts at call
time (never a snapshot):

| Member | Meaning |
|---|---|
| \`ctx.sessionId\` / \`ctx.isIdle()\` / \`ctx.mode\` / \`ctx.model\` | Live session facts (\`mode\` is \`normal\` / \`auto\` / \`plan\`). |
| \`ctx.signal\` | The active run's \`AbortSignal\` (\`undefined\` when idle). Forward it to long work. |
| \`ctx.getMessages()\` | A copy of the model-visible conversation; mutating it cannot reach the wire. |
| \`ctx.getContextUsage()\` | \`{ fillTokens, limitTokens }\` (the footer's reading), or \`undefined\` when unknown. |
| \`ctx.getSystemPrompt()\` | The effective system prompt for the run. |
| \`ctx.llm.complete({ messages \\| prompt, system?, schema?, model?, maxOutputTokens? })\` | One-shot model call outside the turn (text, or schema-validated \`data\`). Uses the session's connection; \`model\` must be one it offers. Tokens are charged to the session automatically; a per-run budget bounds runaway use. Rejections are \`ExtensionLlmError\` with \`code\` \`"no-adapter" \\| "unknown-model" \\| "budget-exceeded" \\| "bad-request"\`. |

Observable turn/message events: \`turn:start\`/\`turn:end\` (one model turn), \`message:start\`/
\`message:end\` (one assistant message; \`firstOutput\` marks the run's first).

## The registration channels

Every registration lives on \`ctx\` and is scoped to this extension: disabling the
extension unregisters everything it added.

### \`ctx.registerTool(def)\` — a tool the model calls

| Field | Required | Notes |
|---|---|---|
| \`name\` | yes | The name the model calls. Prefix it to avoid clashing with built-ins. |
| \`description\` | yes | What the model reads to decide when to call it. Be specific. |
| \`inputSchema\` | yes | Any Standard-Schema / JSON-Schema shape (Zod via \`ctx.z\`, plain JSON Schema object, etc.). |
| \`execute(input, opts, ctx)\` | yes | \`opts\` carries \`toolCallId\`, \`abortSignal\`, and \`agentId\`; \`ctx\` is the live context. Must return an object. |
| \`outputSchema\` | no | Schema for the returned value. |
| \`present\` | no | How the call is displayed — see "Tool display" below. |
| \`toModelOutput(ctx)\` | no | Transform what the model sees (e.g. drop fields the UI needs but the model does not). Must be **idempotent**: open it with \`if (isProjectedModelContent(output)) return output;\` — a re-projection can be handed the projection's own output, and reading its fields off that puts \`undefined\` on the wire (\`validate:model-output-idempotency\`). |
| \`lazy\` | no | \`true\` hides it from the initial request; the model discovers it by name. Saves per-turn tokens for rarely-used tools. |

Honour \`abortSignal\` in long-running work so Esc cancels promptly.
\`opts.agentId\` is the **running** agent's id (a subagent gets a different one than the
registrar) — key per-agent resources off it, not off a value captured at activation.

### \`ctx.registerCommand(cmd)\` — a slash command

\`\`\`js
ctx.registerCommand({
  name: "my-thing",                 // becomes /my-thing
  description: "One line for the autocomplete menu",
  async execute(args, ctx) {        // args is the split remainder; "" -> []
    return "text shown to the user"; // or void for no message
  },
  // Optional: a browseable secondary menu, shown after "/my-thing "
  getOptions: (args) => [{ label: "alpha", value: "alpha", description: "…" }],
  // Optional: inject the returned text as a user message, starting a model turn
  injectMessage: (args, result) => (args[0] ? \`Act on \\\`\${args[0]}\\\` now.\` : undefined),
});
\`\`\`

Command names must not collide with a **built-in** slash command — a conflicting
extension command is skipped with a console warning (\`/new\`, \`/compact\`, \`/mode\`,
\`/models\`, \`/resume\`, \`/rename\`, \`/usage\`, \`/help\`, \`/quit\`, \`/settings\`).
Prefer a short prefix such as \`/my-\`.

### \`ctx.registerInterceptor(hook, handler)\` — observe or intercept

\`\`\`js
const off = ctx.registerInterceptor("tool:after:edit_file", async (event, ctx) => {
  await audit(event.payload.args);
});
// off() unregisters just this handler.
\`\`\`

\`handler\` may be sync or async; returning \`false\` (or setting \`event.skipDefault = true\`) stops
the REMAINING handlers only. To deny a tool call, set \`event.skip = true\` — that is the tool gate;
a \`return false\` that relies on stopping the default action silently lets the tool run.

Hook names support a \`prefix:*\` wildcard: \`tool:before:*\` observes **every** tool call.
Match is on the literal prefix, so \`tool:before:run_*\` works too.

| Hook | Payload / control |
|---|---|
| \`session:start\` | \`{ cwd, sessionId }\` — fires once after bootstrap. |
| \`session:shutdown\` | \`{ sessionId }\` — fires on teardown. |
| \`before_agent_start\` | \`{ prompt, sessionId }\` — once per user turn, before turn context is collected. **Observe-only**: there is no field to append prompt or context here; use \`registerContextProvider\` for model-visible text. |
| \`tool:before:<name>\` | \`{ toolName, args, sessionId }\`. Set \`event.skip = true\` to cancel (add \`event.reason\` to explain), or \`event.modifiedArgs = …\` to rewrite the arguments. The rewrite is **refused** for approval-gated tools and for \`task\`: their approval/safety decision (or the pre-forked child) was already made from the original arguments, so the call runs unchanged and the refusal is logged. |
| \`tool:after:<name>\` | \`{ toolName, args, result, durationMs }\`. Set \`event.payload.modifiedResult = …\` to replace the result the model receives. |
| \`tool:error:<name>\` | \`{ toolName, args, error }\`. Observe-only; use it to log or alert. |

### \`ctx.events.observe(type, handler)\` — react to what happened

Interceptors **change** an operation; observers **read** one. They are two dispatch modes with
similar-looking names, so mind which you want:

| | \`ctx.registerInterceptor(hook, h)\` / \`ctx.events.on\` | \`ctx.events.observe(type, h)\` |
|---|---|---|
| Mode | async, ordered, awaited | sync, fire-and-forget |
| Can change the run | yes — cancel, rewrite args, replace a result | no — read-only |
| Names | the six hook names above | the agent's observer events (\`llm:response\`, \`subagent:completed\`, \`session:usage\`, …) |

\`\`\`js
const off = ctx.events.observe("llm:response", (event) => {
  console.log(event.payload.model, event.payload.costUsd);
});

// Broad: every observable event (streaming chunks and the extension-UI channel are excluded).
ctx.events.observeAny((event) => exporter.push(event));

// Retained events (usage / todos / plan / mode / state / messages …) replay their current
// value once on subscribe, so a late observer does not have to wait for the next change.
ctx.events.observe("session:usage", ({ payload }) => render(payload));
ctx.events.observe("session:usage", handler, { replay: false });  // opt out of the replay
const usage = ctx.events.retained("session:usage");               // on-demand read, no subscription
\`\`\`

- Both accessors return a disposer, and disabling the extension unsubscribes everything anyway.
- **Treat a payload as read-only.** It is the same object every other consumer sees, so
  mutating it corrupts live session state.
- A throwing or rejecting handler is contained and reported as \`agent:extension-error\`; it can
  never abort the run.

### \`ctx.registerContextProvider({ content, disabledContent, sections })\` — per-turn context

\`\`\`js
ctx.registerContextProvider({
  content: () => "…injected while enabled…",         // string | undefined
  disabledContent: () => "…notice while disabled…",
  // Optional named sections: each gets its own <ctx kind="<id>:<name>"> and its own
  // content hash, so a changing selection never re-injects a stable index.
  sections: [
    { name: "index", content: () => renderIndex() },
    { name: "selection", content: () => renderSelection(), disabledContent: () => "…off…" },
  ],
});
\`\`\`

Section names must be slugs (\`[A-Za-z][A-Za-z0-9._-]*\`) — the name becomes part of the
\`<ctx kind=…>\` tag. A section without \`disabledContent\` is simply absent while the
extension is disabled; a throwing producer is skipped and reported without affecting the
other sections.

The base section is emitted each user turn as \`<ctx kind=<extension id>>\`, so it is
prompt-cache friendly (\`undefined\` or an empty string injects nothing, and a section only
re-injects when its content changes). All callbacks are re-evaluated every turn — read live
state in them instead of caching a string at activation.

Keep it small and stable: this text is sent on **every** turn.

### \`ctx.registerMessageTransformer(fn)\` — rewrite the model-facing messages

Runs on **every model call** of a run (including after tool results), and its return value
affects that call only — it is wire-only and never persisted:

\`\`\`js
ctx.registerMessageTransformer((c) => {
  if (c.modelHasVision) return;                    // model can see images already
  return c.messages.map(stripImages);              // this call only
});
\`\`\`

\`c\` exposes \`messages\`, \`phase\` (\`"init"\` | \`"iteration"\`), \`agentId\`, \`unsupportedPartTypes\`,
\`capabilities\` (\`null\` = unknown, which is *not* the same as empty), and per-capability
flags \`modelHasVision\` / \`modelHasReasoning\` / \`modelHasToolCalling\` / … Return \`void\` to
leave the messages alone. One transformer per extension — registering again replaces it.

Use it for media-to-text, redaction, or trimming. Do **not** use it for pruning or
compaction; that is core's job.

## Tool display (\`present\`)

\`present\` decides how a completed call looks. It is declared once, in core, and shipped
with the message — so declare display here rather than in the host.

| Field | Effect |
|---|---|
| \`text(output)\` | The one string the call shows. In compact display it is one clamped line **and the row is kept** — keep it short and single-line. |
| \`category\` | Fold bucket: \`reads\` \\| \`edits\` \\| \`searches\` \\| \`commands\` \\| \`tasks\` \\| \`other\`. |
| \`label(input)\` | Short text after the count in a folded summary (a filename, a query). Without it the row is just \`my_tool ×2\`. |
| \`summary(output)\` | Header text, e.g. \`3 matches\`. |
| \`keepRow\` | Never fold this row (structured / interactive results). |
| \`detailed\` | Render a detailed result block in full display. |
| \`clientSide\` | The host supplies the result. |
| \`labelKey\` | Declarative label source for hosts that cannot call \`label\`. |

Every function must be **pure** — a function of the stored output (or parsed input) only.
The rendered value is persisted with the session and replayed on restore, so a timestamp,
a random value, or wall-clock state would corrupt the saved transcript.

## Decorating another tool's output

\`ctx.registerToolOutputDecorator(toolName, decorator)\` wraps the **model-facing** output of a tool
you do not own (for example the built-in LSP extension appending diagnostics to \`write_file\`
results). The decorator receives \`(ctx, next)\` and returns \`ModelToolContent\`; call \`next()\` for
the undecorated value. It is agent-scoped, removed when your extension is disabled or destroyed,
and the returned disposer removes it earlier. Unlike \`present\`, it changes what the **model** sees,
not what the user sees — keep it for information the model must act on.

## Drawing into the host UI

\`\`\`js
ctx.ui.render("footer", "my-badge", "my-ext: ready");        // raw text (ANSI allowed)
ctx.ui.render("footer", "my-tree", {                          // or a layout tree
  type: "row", gap: 1,
  children: [{ type: "text", value: "my-ext" }, { type: "text", value: "ok" }],
});
ctx.ui.render("footer", "my-badge", null);                    // null removes the slot
ctx.ui.notify("done", "success");                             // transient toast
const view = ctx.ui.getContext();                             // model/status/usage/workspace/mode
\`\`\`

- \`payload\` is raw text (ANSI + newlines preserved) or a \`text\` / \`row\` / \`column\` /
  \`box\` tree. It crosses a process boundary for remote sessions, so it must be **plain
  JSON-serializable data — never functions or components**.
- \`"footer"\` is currently the only surface hosts implement. \`key\` scopes your slot so
  extensions never overwrite each other; slots are attributed to the extension and
  cleared when it is disabled.
- Use \`notify\` for one-off events and \`render\` for anything that should persist.
- \`ctx.ui.subscribe("context", handler)\` pushes UI-context changes instead of polling.

## Runtime access

\`\`\`js
ctx.cwd                    // workspace root path (string)
ctx.env                    // this extension's config map (ExtensionConfig.config strings)
ctx.coreEnv.rootPath       // same root, via the runtime abstraction
await ctx.coreEnv.fs.readFile("notes.md")
await ctx.coreEnv.runCommand("git", ["status"])   // or the command API the host provides
await ctx.coreEnv.fetch("https://…")
ctx.z                      // the host's zod — always use this, never \`import "zod"\`
ctx.logger.info("…")       // / .warn / .error → the agent log
ctx.registerFlush(async () => { await saveState(); })  // awaited before teardown releases resources
ctx.registerExitFlush(() => saveStateSync())           // sync, for process exit / crash
ctx.events.on("session:start", handler)            // intercept (the six hook names)
ctx.events.observe("llm:response", handler)        // observe (observer events)
ctx.events.retained("session:usage")               // current retained value
\`\`\`

\`ctx.coreEnv\` is the runtime-agnostic environment: filesystem, shell, fetch, path
utilities, env vars, and \`rootPath\`. Going through it keeps the extension working when
the agent runs against a remote workspace instead of the local disk — prefer it over
importing \`node:fs\` or \`node:child_process\` directly.

## Load it and verify

\`\`\`bash
# Load from an extra directory
codent --extension-dirs ./my-extensions

# or persistently
AGENT_EXTENSION_DIRS=./my-extensions codent
\`\`\`

Then, in the session:

1. **Ctrl+Y** — the extensions panel lists each extension with its state
   (\`active\` / \`error\`), tool count, and command count. Toggle one to enable/disable it;
   a load error is shown here.
2. Run your slash command, or ask the agent to call your tool.
3. Read \`${AGENT_DATA_DIR}/logs/<sessionId>/agent.log\` for \`ctx.logger\` output and load failures.

A failing extension never kills the session — it is reported and skipped. That also means
a typo can look like "nothing happened", so check the panel and the log first.

## Gotchas

- **Schemas:** use \`ctx.z\`. Importing your own zod can produce a second copy whose schema
  objects the host does not recognise.
- **Command collisions:** a name that clashes with a built-in slash command is silently
  skipped (console warning only). Prefix your commands.
- **Do not capture per-run state at activation.** Activation happens once; a tool may run
  for a subagent. Read live values per call (\`opts.agentId\`, \`ctx.ui.getContext()\`).
- **\`present\` and context providers must be pure / re-evaluated** — see their sections.
- **Keep injected context small.** \`registerContextProvider\` text is sent every turn.
- **Long work:** respect \`abortSignal\` so Esc cancels promptly.
- **Don't duplicate a built-in tool name.** Prefer a prefix (\`my_ext_lookup\`).
`;
