# @codent/acp

Agent-side [Agent Client Protocol](https://agentclientprotocol.com) host for Codent.

Exposes an `AgentSessionHost` over ACP on **stdio**, so an editor (Zed, JetBrains) or an ACP→IM
bridge can drive the agent with no Codent-specific host code. Unlike a bridge that talks to a
subprocess RPC, this drives the in-process `AgentSession` directly — the same session type the TUI
hosts use. There is no editor-specific vocabulary here: tool identity, tool kinds and the command
list are all derived from core's own presentation registry and command catalog, so this host cannot
drift from the one that renders a terminal.

## Serve over stdio

```bash
# from a built checkout
pnpm --filter @codent/acp build && node packages/acp/dist/bin.mjs

# or via the release host (intercepted before the TUI boots)
codent acp
codent --acp            # alias

# or via the standalone bin published by this package
codent-acp

# configure the model directly (authoritative; skips .agents/config/models.json)
codent acp --model anthropic/claude-3.5-sonnet --base-url https://openrouter.ai/api/v1 --api-key sk-or-...
codent-acp --model anthropic/claude-3.5-sonnet --base-url https://openrouter.ai/api/v1 --api-key sk-or-...
```

`codent acp` is intercepted in the release host **before** the terminal UI boots, because a headless
protocol requires stdout to carry only JSON-RPC frames. The development host `@codent/cli` does
**not** expose this subcommand (it has no `@codent/acp` dependency); the standalone `codent-acp` bin
and the in-process API below are the other two ways in.

The workspace root is the process `cwd` — the local CoreEnv is built from it (`createNodeEnv`) — so a
client should spawn the agent **inside** the workspace it wants it to see. The root is fixed at
handshake: a request's `cwd` is only a hint (a differing one is noted on stderr, never obeyed and
never an error).

## Model resolution

Four sources, read through **one pipeline** (`loadModels`) and carried on the runtime:

1. explicit `--model` / `--style` / `--base-url` / `--api-key` flags — **authoritative**, the
   on-disk `models.json` is skipped entirely (the same isolation as the TUI's `--model`);
2. `.agents/config/models.json` (read through core's `loadModels({ kind: "file" })`);
3. `--remote-provider` / `REMOTE_PROVIDER` (`loadModels({ kind: "provider" })` — the provider server
   supplies the connection **and** its selectable list: its `models.json` ids, its active model, and the
   model it serves);
4. `.env` — `MODEL` / `MODEL_STYLE` / `BASE_URL` / `API_KEY`.

With no model from any of them the process exits with a clear error rather than starting a session
that cannot run.

The result is **carried on the runtime** as a CATALOG (`CodentAgent.readModels()` — entries, never the
credential-bearing config; which model a session runs on is the session's) and the host only projects it: the `configOptions` model select, the legacy
`models` field, and both write paths (`session/set_config_option`, `session/set_model`) read that one
value. `AcpAgentOptions.modelCatalog` / `modelCatalogActiveIndex` are gone — a host that builds its own
runtime gets the list from `readModels()` instead.

A plane that names exactly one model (flags, `.env`, a provider serving one model) still advertises it, as
a single fixed value: which model is running is information, not a choice.

> `.env` loading is the **release host's** step (`codent` calls `loadEnv`), not this package's: the
> standalone `codent-acp` bin sees the real process environment plus `models.json` only. Export the
> variables, or run through `codent acp`, if you depend on a `.env` file.

`bootstrapLocalAcp({ cwd, sandbox, model, clientEnv })` performs all of it and returns the host plus
the resolved defaults, which is what an embedding host builds its `AcpAgentOptions` from.

### The model selector

ACP has **no `session/set_model`** — model selection is a `configOptions` entry with
`category: "model"`, and its write-back is `session/set_config_option`. Declaration and write path
are therefore one contract, and they live together in `src/session-config-options.ts`:

- the option is advertised **only** when source 2 was used. On the explicit-flags path and on the
  `.env` fallback a selector would offer exactly one value — a fake choice — so it is omitted rather
  than advertised.
- a value encodes the config **entry**, not just the model: `"<entryIndex>:<model>"`. A model id is
  only unique *within* an entry, and switching a model may also switch the connection (`style` /
  `baseURL` / `apiKey` of that entry). It is the same encoding the TUI's `/models` uses, so the two
  hosts cannot drift on it. Credentials are **never** advertised — only the model id, its name, and
  an entry description.
- the session's current model is always a member of `options`, inserted unencoded if it is not in
  the catalog, because the protocol requires a default for every option the agent advertises.
- the entry a connection came from is **recorded** per session (seeded at `session/new`, updated by
  every switch). A bare first-match lookup would name the wrong entry when one model id appears in
  several — and re-selecting that advertised value would then dispatch the wrong credentials. A
  resumed session that was never recorded keeps the first-match fallback rather than a wrong claim.
- switching needs **no** model metadata: if models.dev is unreachable the switch still happens, it
  just leaves capabilities unlabelled (`resolveModelInfoFromModelsDev` is best-effort by contract).
- **no process-level model provider is registered.** One ACP process serves many sessions and the
  provider registry is process-wide, so registering would let one session's switch change another's
  connection. The connection travels in the `model.set` payload instead — which makes "one session's
  switch is invisible to the others" a property of the design rather than of discipline.

The `mode` select is the `configOptions` spelling of the legacy `modes` field; both are advertised
together, sourced from the same `mode` channel. `session/set_mode` and
`session/set_config_option(mode)` are two spellings of one behaviour with a single implementation.
Every change re-sends the **whole** option set — the protocol's `ConfigOptionUpdate` has no
incremental form — while a re-set of an unchanged value stays silent, because the client's cache is
already correct.

### The thinking-depth selector

Thinking depth is a property of the **model**, so it is a `configOptions` entry beside it
(`category: "thought_level"`) rather than a separate slash command — the TUI merges the two into one
`/models` menu for the same reason. The wire value is the effort level, or `off` for "let the model
decide"; `off` is the **absence** of an effort, never a level stored under that name.

- the option exists only when the model **evidences** depth (`capabilities` includes `reasoning`
  **and** `reasoningConfig.effortValues` is non-empty — core's `offerableReasoningEfforts`). A model
  without metadata offers nothing: one fake value would be worse than no selector;
- switching to a model without depth makes the option disappear from the next advertisement, so a
  stale cache cannot offer levels the new model cannot honour;
- a level the model does not advertise is refused with an error and changes nothing.

## `--client-env` (opt-in)

By default everything — file reads/writes and commands — runs on our own local CoreEnv, and the
client's `clientCapabilities.fs` / `.terminal` are ignored. `--client-env` flips that for files and
argv execution, so an editor's native facilities are used instead (diff views, its terminal, its
permission prompts):

```bash
codent acp --client-env
codent-acp --client-env
```

What it does and does not change:

- **Per session, not per process.** Every `fs/*` and `terminal/*` request carries a `sessionId`, so
  each session gets its own env (and its own runtime — the existing "one runtime owns one env" rule,
  not a second environment registry).
- **`.agents/**` and anything outside the workspace root never reach the client.** Session logs,
  media, memory, plans and config are ours; a client that declines to serve a hidden directory would
  otherwise silently cost the agent its ability to persist a conversation.
- **Every path on the wire is absolute.** ACP's `fs/read_text_file` / `fs/write_text_file` take an
  "Absolute path to the file" and `terminal/create.cwd` "Must be an absolute path", while the tools pass
  workspace-*relative* paths. Those are resolved against the workspace root before sending, because a
  relative path belongs to no root: the client resolves it against its own cwd, refuses it as outside the
  workspace, and the write's approval prompt never resolves — every ACP-side write failed that way, as a
  hang rather than an error. The local env never needed this step (`native-fs.ts` resolves internally);
  this is the one layer that hands the filesystem to someone else, so it owes them a usable path.
- **One path resolution, and an atomic rewrite knows whose disk it is on.** A `tool_call.location` and
  the `fs/*` request that follows it describe the same file, so both come from one helper
  (`src/paths.ts`) — two implementations spelled the same file differently, and a client that followed
  a location could ask for a path the file is not at. Absoluteness is judged platform-aware (a Windows
  or UNC path is absolute, not relative), and an empty root returns the path unchanged rather than
  silently resolving against `process.cwd()`.
  Because a whole-file rewrite is `writeFile(<sibling tmp>)` + `rename`, and the *write* routes to the
  client while a `rename` could only ever run on **our** filesystem, `rename` is withheld whenever
  writes route to the client. That makes `write_file` take its direct-write branch — one write of the
  real path — instead of writing a temp file the client owns and renaming a local path that does not
  exist (ENOENT, or EXDEV across a genuinely remote client).
  The gate is **capability-level, not path-level**: with writes routed to the client, *no* path keeps
  `rename` — `.agents/**` included. So the session journal's atomic rewrite degrades to a direct
  overwrite there. Core documents that degradation itself (`session-journal.ts`: "Without rename this
  degrades to a direct overwrite … best-effort") and its fallback is a plain `writeFile`, so nothing
  is dropped — a folded log rewrite is just no longer crash-atomic. Restoring atomicity for local
  paths needs a path-aware replace in the CoreEnv contract, not a flag here.
- **Only argv-shaped execution goes to the client terminal.** ACP's `terminal/create` takes
  `command` + `args` with no shell, so `execFile` (glob / grep / tree) routes there, while `exec` and
  `run_command` — both free text — stay on the local shell. That keeps command-safety's shell
  analysis and the shell that actually runs the command the same one; inventing a `sh -c` wrapper
  would hand the command to a shell we cannot describe.
- **Approval moves only where the operation actually goes.** A workspace `write_file` / `edit_file`
  is now authorised by the client that serves the write, so the agent does not ask a second time —
  the client already did. Three things deliberately keep their prompt: writes that stayed local
  (`.agents/**`, outside the root, or a client without `fs.writeTextFile`), `delete_file` /
  `kill_command` (ACP's `fs/*` covers reading and writing text and nothing else — the write
  capability is not a licence to delete, and a signal we send ourselves cannot be credited to the
  client), and `run_command` (it runs on our own shell). Plan mode keeps them too: the client
  authorises a file operation, not the read-only phase.
- **A session that does not exist yet also falls back.** `session/new` has no id to send until core
  mints one inside `host.create`, and that call reads the workspace (your `AGENTS.md`, plus
  `.lsp.json` / `.mcp.json`). Those reads are served locally rather than refused, because refusing
  them is silent: the instruction loader catches a failed read and reports "no documentation file
  found", so every new session would lose its project instructions. The invariant is "this can never
  fail", not "the ordering must hold".
- **A missing capability falls back, it does not fail.** Read-only clients read remotely and write
  locally; a client without `terminal` falls back for every command, and `execFile` is simply absent
  (feature detection reads "unsupported" and degrades) rather than defined to throw. A terminal
  result that was killed, timed out or truncated is reported as `killed: true` so its callers fall
  back to their in-process implementation instead of reading partial output as "no matches". The
  capability matrix and every fallback decision are logged to stderr, each actionable one once
  rather than per request.

## Use in-process

```ts
import { createAcpAgent, bootstrapAcpAgent } from "@codent/acp";

const options = await bootstrapAcpAgent(); // CoreEnv + model provider + local host
const app = createAcpAgent(options);       // register handlers, then `app.connect(stream)`
```

`createAcpAgent({ host, defaults, rootPath })` accepts any `AgentSessionHost`, so a host that is
remote (`--remote-session`) can be served over ACP too. `runAcpAgentStdio(options)` wires the stdio
transport and returns the live connection (the caller owns process teardown). The rest of the
package surface is the mapping helpers (`promptBlocksToContent`, `toolCallInfo`, `mapAcpMcpServers`,
`createAcpClientEnv`, `paginateSessions`, …), exported so a validator or a sibling host can exercise
them without a transport.

## Sessions

The ACP session id **is the disk session id** (`ses_…`), never the agent id: `session/load`,
`session/list` and `session/delete` address a *persisted conversation*. `session/new` returns the
disk id, `host.create` having minted it before returning. Exposing the agent id instead made the id
from `session/new` unusable for `session/load` and made every disk-enumerated session miss its live
bridge.

| Request | Behaviour |
|---|---|
| `session/new` | `Host.create`; returns the disk id, `modes`, and `configOptions` |
| `session/load` | restore **and** replay the stored transcript (no model call); replay once per live session |
| `session/resume` | restore, no replay |
| `session/close` | stop, unregister, release the runtime; tolerates an unknown id (the desired state is already true) |
| `session/list` | the workspace's **persisted** sessions (disk catalog, cursor-paged); advertised only for a host that can enumerate them |
| `session/delete` | success = "was live (already closed) **or** its file is gone" |
| `session/fork` | clones the source's transcript into a new session and re-keys the same subscription |
| `session/prompt` | serialized per session; resolves when the **turn** ends (see below) |
| `session/cancel` | aborts in-flight requests and the run; the prompt answers `cancelled`, never an error |

Four ordering facts are load-bearing, and each was a shipped bug before it was a rule:

- **Replay happens before subscribing.** A session hands its retained values to a *new* subscriber,
  so subscribing first emitted the whole conversation live and the replay emitted the assistant half
  of it again — a duplicated, mis-ordered transcript. Replaying first also primes the cursors, which
  is what makes the retained delivery idempotent.
- **An already-live session is reused, never re-created.** A second `host.create` over the same disk
  log means two writers, and the previous projector would keep its subscription, so every update
  went out twice under one session id with two sets of cursors racing.
- **The live path reports the user turn too**, deduplicated by message id. Assistant text alone left
  nothing between two consecutive replies, which a client can only render as one merged run.
- **A prompt resolves when the *turn* ends, not when a pump returns.** A turn can suspend on an
  approval or an `ask_user`: the dispatch returns, the client answers, and a new pump resumes the
  same turn. Resolving at that point would tell the client the turn was over while its continuation
  still streamed.

`session/list` pagination is cursor-based, and the cursor encodes the **`(updatedAt, id)` pair**:
`Date.now()` has millisecond granularity and two scripted sessions can share it, so an
`updatedAt`-only boundary would drop whichever of the pair fell on the far side of a page — a
silently missing session rather than the tolerated repeat of a concurrent-write cursor. The token is
opaque, and a malformed one degrades to the first page rather than throwing, because a client cannot
fix a token it did not author.

## Updates and interactions

The `messages` channel delivers the full `UIMessage[]` on every change, so the projector keeps
per-message and per-tool **cursors** and emits only the delta: appended text only, a stable
`messageId` per message, `tool_call` on first sight then `tool_call_update` on transition. A single
frame's size is proportional to the change, not to the conversation. Tool stdout from the `tool`
channel is forwarded as `tool_call_update` content, throttled to 300 ms.

Approvals become `session/request_permission` with the standard four options and the call's real
description — the same `toolCallInfo` the transcript uses, because a prompt that cannot show *what*
it is approving is not a decision anyone can make. `ask_user` becomes an `elicitation/create` form,
and degrades to an agent message plus a cancelled tool result when the client does not advertise
`elicitation.form`. Both round-trips register a controller that `session/cancel` and `close` abort,
and neither ever throws — a closed connection is the session's problem to time out, not a reason to
fail a run.

The host also **reconciles** its open requests against each `interaction` snapshot: an approval that is
no longer pending was answered without the client — core answers every pending approval when auto mode
turns on — so its outstanding `request_permission` is cancelled. Without that the client keeps a dialog
for a tool that already ran, and its late answer re-decides the approval (a `deny` after the call
completed).

`session/update` notifications are capability-gated where the protocol says so: `compaction_update`
only for clients declaring `session.compaction`, `notice` only for `session.notices`.

## Slash commands

ACP has no "invoke command" method: a client sends `/name args` as an ordinary prompt. The host
parses it, dispatches the matching built-in `AgentSessionCommand` (or an extension's
`invokeCommand`), and returns any text the command produced — it never reaches the model as text.
The advertised set is core's `BUILTIN_COMMAND_CATALOG` filtered to `scope !== "ui"` plus the
session's extension commands, re-sent whenever the `extensions` channel moves. Dispatch keys off the
catalog's `command` field, so this host never restates a command name.

`/models` is the one command with two effects: it switches the model **and**, when a level follows
(`/models 0:gpt-5.1 high`, or `off`), the thinking depth. The switch happens first and the level is
validated against the model it switched **to** — the previous model's advertisement says nothing
about the new one. `/effort` is not advertised: depth is a property of the model, so it belongs to
the model command (and to the `thought_level` selector above).

## Coverage

| ACP surface | Status |
|---|---|
| `initialize` / `authenticate` / `logout` | ✅ capabilities negotiated; `authMethods` is empty and both auth methods accept as no-ops (no interactive auth) |
| `session/new` / `load` / `resume` / `close` | ✅ (load replays once; resume does not; a live id is reused) |
| `session/list` / `session/delete` | ✅ (disk catalog; only when the host provides the store) |
| client `fs/*` / `terminal/*` | ✅ with `--client-env` (opt-in; `.agents/**` and free-text commands stay local) |
| `session/fork` | ✅ (`session.clone`; source must be live in-process) |
| `session/prompt` / `cancel` / `set_mode` / `set_config_option` | ✅ (StopReason mapped; cancel → `cancelled`; `set_config_option` dispatches on the option's `category` — the write side of the `mode`, `model` and `thought_level` selects we advertise, each sharing its own entry point) |
| `user_message_chunk` | ✅ one per user turn, stable `messageId`; injected `<ctx>` rows are skipped |
| `agent_message_chunk` / `agent_thought_chunk` | ✅ incremental (stable `messageId`) |
| `tool_call` / `tool_call_update` | ✅ kind / title / locations / streamed output; a write or edit carries its `diff` — sent as soon as the input is resolvable, and again with the result text, since an update replaces what the client holds |
| `plan` (from todos) | ✅ always the complete entry list |
| `available_commands_update` | ✅ built-in catalog + extension commands |
| `current_mode_update` / `config_option_update` / `session_info_update` / `usage_update` | ✅ (`config_option_update` on `set_mode` **and** `set_config_option`, always carrying the WHOLE option set) |
| model selector (`configOptions`, `category: "model"`) | ✅ when `.agents/config/models.json` is the source (the protocol has no `session/set_model`) |
| thinking-depth selector (`configOptions`, `category: "thought_level"`) | ✅ for a model that advertises reasoning levels; absent otherwise |
| `session/request_permission` | ✅ approvals → four-option round-trip |
| `elicitation/create` | ✅ `ask_user` (with an agent-message fallback) |
| `compaction_update` / `compaction_summary_chunk` / `notice` | ✅ gated by the client capability (open as `in_progress`, stream the summary, close as `completed` / `failed` / `cancelled`) |
| per-session `mcpServers` | ✅ stdio / http / sse on `new` / `load` / `resume`; `acp` refused; fork refuses the field |
| `additionalDirectories` | ⛔ deliberately undeclared, refused with one shared error on all four requests that can carry it |

## Editors (Zed)

```jsonc
{
  "agent_servers": {
    "codent": { "type": "custom", "command": "codent", "args": ["acp"], "env": {} }
  }
}
```

## Package layout

| Module | Responsibility |
|---|---|
| `agent.ts` | the ACP app: handler registration, the session-id → bridge map, prompt turns, stop reasons |
| `bootstrap.ts` | local CoreEnv + model provider + runtime; builds `AcpAgentOptions` |
| `bin.ts` | the standalone `codent-acp` entry (flag parsing + stdio) |
| `projector.ts` | `AgentSession` channels → `session/update` (per-message / per-tool cursors; replay) |
| `session-config-options.ts` | the `mode` / `model` / `thought_level` selects and their write paths (`applyMode` / `applyModel` / `applyThoughtLevel`) |
| `session-status.ts` | what a client is told about a session's state: the legacy `modes` field, the disk session id, and the `StopReason` for a finished turn |
| `session-runtime.ts` | per-session runtime + late binding of the disk id (`--client-env`) |
| `sessions.ts` | disk catalog → ACP `SessionInfo`, cursor paging |
| `client-env.ts` | the client-backed `CoreEnv` |
| `approvals.ts` | which pending approvals the client already owns |
| `interactions.ts` | the two client round-trips: permission + elicitation |
| `permissions.ts` | permission / elicitation request-response mapping |
| `mcp.ts` | ACP `McpServer[]` → core `McpServerConfig` (with validation) |
| `content.ts` | prompt `ContentBlock[]` ↔ `ContentPart` mapping |
| `tools.ts` | tool kind / title / locations / structured diff |
| `commands.ts` | slash-command parsing + dispatch |
| `types.ts` | the small structural types the projector reads |

`src/index.ts` is the public surface (`package.json#exports`); nothing above is reachable by deep
import.

## Validation

```bash
pnpm --filter @codent/acp run validate:acp            # build + the whole suite
pnpm --filter @codent/acp run validate:acp:catalog    # config options, catalog, session ids
pnpm --filter @codent/acp run validate:acp:mcp        # session/new + load/resume mcpServers
pnpm --filter @codent/acp run validate:acp:client-env
pnpm --filter @codent/acp run validate:acp:terminal
pnpm --filter @codent/acp run validate:acp:bootstrap
```

The suites are an **in-process conformance run** — the official SDK's `client()` connects straight to
our `agent()` app and drives real requests — alongside pure mapping units. `validate:acp:bootstrap`
is the deliberate opposite shape: a real `createNodeEnv`, a real `CodentAgent` and a real
`host.create`, because the class of failure it covers (work core does *before* a session exists) is
invisible to a hand-built client env with a fake host. All of them run in CI through the repo-wide
validator runner, which discovers `validate-*.mjs` by glob rather than by a list.

## Known limitations

- stdio only (ACP remote HTTP/WS transports are still experimental).
- Per-session `mcpServers` REPLACE `.agents/mcp.json` for that session; they are not merged, and an
  empty or absent list falls back to the file. The `acp` transport (a client-bridged server) has no
  core entry point and is rejected explicitly rather than ignored.
- `session/resume` / `session/load` accept `mcpServers` the same way `session/new` does (both build
  a fresh agent via `Host.create`). `session/fork` rejects it, because a fork reuses the source's
  live agent and genuinely cannot swap servers.
- `session/fork` requires the source to be live **in this process** — "list a session created by an
  earlier process, then fork it" is not supported.
- **Model switching may switch the provider.** Selecting a model option applies that entry's
  `style` / `baseURL` / `apiKey`, the same thing `/models` does in the TUI. Because the selector only
  exists on the `models.json` path, that is the only configuration in which it can happen.
- `session/load` / `session/resume` responses carry **no** `configOptions` (their shape is frozen),
  so a client loses the mode and model selectors after reopening a session. Those responses do not
  carry the legacy `modes` field either. Fixing it is a separate change — it should add both at once
  rather than only the model.
- No `authMethods`, and no `providers/*`: credentials are resolved locally by the process that owns
  the workspace, so there is nothing for a client to configure or to authenticate against.
  `providers/*` is an ACP v2 draft surface in the SDK and is not advertised.
- Compaction is reported only for clients that advertise `session.compaction`, which is what the
  protocol requires: the row opens as `in_progress` (from the `state` status, so a manual `/compact`
  — which emits no lifecycle event at all — is visible too), the summarizer's stream is forwarded as
  `compaction_summary_chunk`, and the row closes as `completed` (carrying the summary), `failed`, or
  `cancelled`. Each compaction gets its own `compactionId`: the id is the protocol's upsert key, so
  reusing one would tell the client the second compaction was a patch to the first.
- `additionalDirectories` is not supported and is refused with a JSON-RPC error on every request
  that can carry it (`session/new`, `session/load`, `session/resume`, `session/fork`) — one shared
  check, one message. It is never silently ignored, so a client cannot end up talking to an agent
  that cannot see the roots it asked for. `cwd` is only a hint (the root is fixed at handshake) and
  is not forwarded.
