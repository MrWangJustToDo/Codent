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

# or the standalone bin (build this package from source; it is not published on its own)
codent-acp

# configure the model directly (authoritative; skips .agents/config/models.json)
codent acp --model anthropic/claude-3.5-sonnet --base-url https://openrouter.ai/api/v1 --api-key sk-or-...
codent-acp --model anthropic/claude-3.5-sonnet --base-url https://openrouter.ai/api/v1 --api-key sk-or-...
```

`codent acp` is intercepted in the release host **before** the terminal UI boots, because a headless
protocol requires stdout to carry only JSON-RPC frames. The development host `@codent/cli` intercepts
the same subcommand; the standalone `codent-acp` bin (built from this package) and the in-process API
below are the other two ways in.

Launch flags reach `AcpAgentDefaults` and apply to every session this host creates (session-specific
values still arrive over the protocol): `--model` / `--style` / `--base-url` / `--api-key` /
`--remote-provider` (the model connection), `--system` / `-s` (prompt for the process root),
`--max-iterations`, `--max-concurrent-tasks`, `--extension-dirs`, `--mcp-config` and `--sandbox`
(`local` = OS sandbox, `native` = none; `SANDBOX_ENV` is the fallback). `--resume` / `--continue` do
not apply: the ACP client chooses the session. Both entry points also report their own package
version as `agentInfo.version`.

The workspace root for a session is the ACP request's **`cwd`** (`session/new`, `load`, `resume`
and `fork` carry one; when absent it falls back to the process root). It is normalized and must be
absolute; each session builds its own CoreEnv rooted there, so relative tool paths, `.agents/**`
and `session/list` follow the session's workspace. The process `cwd` is only the default for
`session/list` without a `cwd` and for reads that happen before a session exists.

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

- the option is advertised whenever a model catalog is readable. A `.agents/config/models.json`
  catalog (or a multi-model remote provider) yields a **switchable** list; the explicit-flags and
  `.env` planes yield a single-entry catalog, so the same option is advertised with one fixed value —
  information, not a fake choice, and not an absent selector.
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
- **The runtime provider is registered once; model switching never re-registers it.** One ACP
  process serves many sessions and the provider registry is process-wide, so a switch must not
  change another session's connection. The connection travels in the `model.set` payload instead —
  which makes "one session's switch is invisible to the others" a property of the design rather
  than of discipline.

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

`session/new` returns a **stable ACP handle**. It starts equal to the disk session id (`ses_…`), so
existing clients are unaffected, but it is not the same identity: `/new`, `/clone` and `/resume`
replace the underlying conversation while the client keeps using the same handle (ACP has no
"session id changed" notification). `session_info_update._meta.diskSessionId` reports the current
disk id; `session/list` and `session/delete` address disk ids, and `session/load` accepts either a
handle or a disk id. The agent id is never exposed — `session/load` / `list` / `delete` address a
*persisted conversation*, and using the agent id made every disk-enumerated session miss its live
bridge.

| Request | Behaviour |
|---|---|
| `session/new` | `Host.create` in `cwd`; returns the stable handle, `modes`, and `configOptions`; seeds state **after** the response |
| `session/load` | restore **and** replay the stored transcript including tool results (no model call); replay once per live session |
| `session/resume` | restore and prime cursors from the snapshot; **no** transcript replay |
| `session/close` | stop, settle pending interactions, release the runtime; tolerates an unknown id (the desired state is already true) |
| `session/list` | the persisted sessions for the request's `cwd` (default root when omitted), cursor-paged; advertised only for a host that can enumerate them |
| `session/delete` | idempotent: success whether the session was live, removed, or already gone |
| `session/fork` | clones the source's transcript into a new session and re-keys the same subscription; restores a cold source first |
| `session/prompt` | serialized per session; resolves when the **turn** ends (see below) |
| `session/cancel` | settles pending approvals/questions and aborts the run; the prompt answers `cancelled`, never an error |

Four ordering facts are load-bearing, and each was a shipped bug before it was a rule:

- **Replay happens before subscribing; resume primes instead.** A session hands its retained values
  to a *new* subscriber, so subscribing first emitted the whole conversation live and the replay
  emitted the assistant half of it again — a duplicated, mis-ordered transcript. `load` replays
  first; `resume` primes every cursor from the snapshot before subscribing, so the retained delivery
  emits nothing.
- **An already-live session is reused, never re-created.** A second `host.create` over the same disk
  log means two writers, and the previous projector would keep its subscription, so every update
  went out twice under one session id with two sets of cursors racing. A live `load`/`resume` with a
  different `mcpServers` list is refused (servers are fixed at creation).
- **The replay reports the user turn; the live path does not.** A client that submitted a prompt
  renders it itself, so echoing it live duplicates the turn. On `load` the client has nothing, so
  the replay emits `user_message_chunk` for the stored user turns and their attachments.
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
it is approving is not a decision anyone can make. `allow_always` / `reject_always` are remembered
per session and keyed by tool identity (for `run_command`, the leading program, so allowing `git`
does not allow `rm`); a matching future approval is answered without another dialog. `ask_user`
becomes an `elicitation/create` form. When the client does not advertise `elicitation.form`, the
question (and its numbered options) is posted as an agent message and **the turn is handed back**
(`end_turn`) with the tool still pending: the next plain-text prompt becomes its answer
(`addToolResult`, numbered options map to their labels) and resumes the run. That prompt is routed
**outside the prompt queue** — a parked `ask_user` keeps the status ACTIVE, so an answer queued behind
that turn could never be dequeued (it was a deadlock, not a pause). A slash command is still a
command: it force-submits, which settles the parked question as cancelled.

Every suspend point settles. A client-cancelled permission dispatches `respondApproval(false)`; a
declined/cancelled/failed elicitation settles the tool as `cancelled`; `session/cancel` and
connection close settle every outstanding approval/question before stopping the run; and an
unanswered interaction times out (5 minutes by default, `interactionTimeoutMs` on `AcpAgentOptions`)
with a notice. This is what makes `session/prompt` bounded — core's `stop` deliberately skips an
approval the user has not answered, so leaving it pending parked the next prompt forever.

The host also **reconciles** its open requests against each `interaction` snapshot: an approval that is
no longer pending was answered without the client — core answers every pending approval when auto mode
turns on — so its outstanding `request_permission` is cancelled. Without that the client keeps a dialog
for a tool that already ran, and its late answer re-decides the approval (a `deny` after the call
completed).

`session/update` notifications are capability-gated where the protocol says so: `compaction_update`
only for clients declaring `session.compaction`, `notice` only for `session.notices`. Every subagent frame is gated on `subagents`.

## Subagents

Delegated work (`task` tool calls) is surfaced on two surfaces, and which one a client sees depends on
its capability:

- **Without `clientCapabilities.subagents`** every `subagent_update` and every child `session/update`
  is withheld. The parent's `task` row still carries the final result, so a client that only renders
  the main transcript loses nothing but the live exploration.
- **With `subagents: {}`** the parent announces a child with `subagent_update` (id, title,
  description, current `state`, and `_meta.taskPhase`) **before** any frame tagged with that child id.
  Later snapshots patch only the fields that moved; a destroyed child is forgotten, not reported as
  `idle`. The announcement comes from the `subagents` snapshot, and it is flushed before the child
  projector is attached — including under `session/new`'s deferred-emit window, where the child's own
  projector would otherwise beat the announcement to the client.

Only **user-visible delegations** are announced: rows without a `parentTaskToolCallId` (compaction /
memory summarizers, internal workers) stay invisible. This is enforced by `isUserVisibleTaskRow` in
core, not by a host-side name check.

The two surfaces:

| Surface | What the client gets |
|---|---|
| child session (id from `subagent_update`) | the child's ordinary transcript, tagged with the CHILD session id: `agent_message_chunk`, `agent_thought_chunk`, `tool_call` / `tool_call_update`, usage. The child's prompt is `session_message` (sender = parent, recipient = child), not a `user_message_chunk`, because the client did not type it. |
| parent `task` row | the result of record: `tool_call_update.content` is core's `formatToolOutput(output, "task")` (summary + `limit reached` / `cancelled` / `stalled` / `cached` status line). While the task summary streams, the row is updated in place with the accumulated text (tool `content` replaces; it does not append). The raw task object is never sent as `rawOutput`, and a summary chunk that arrives after the final result is dropped. |

Child sessions are **parent-owned**:

- `session/list` never contains a child (children have no disk session).
- `session/load` / `resume` / `prompt` / `fork` with a child id return `invalid params`; `close` and
  `delete` are idempotent no-ops. `delete` is screened BEFORE the catalog, because
  `host.deleteSession` resolves the id as a live agent and would destroy the child.
- Closing the parent stops the child projectors but never destroys the children; their lifecycle
  belongs to core.
- A `session/load` / `resume` of a live parent **re-announces** its still-live children after the
  response without replaying their history (the client keeps what it already rendered); a child
  announced after attach is new and replays its own prompt and early output. A `fork` is a new
  parent: its children are re-announced under the new id, never left streaming under the retired one.
- A child projector subscribes only to its transcript/tools/usage and the compaction stream — no
  `interaction`, `extensions`, or top-level selector channels — and it does not overwrite the roster
  title with its internal agent name.
- `session/load` replays a historical `task` row formatted, from either persisted shape (the call
  part's `output`, or the result part's raw-JSON `content`). Without `subagents`, that row is still
  the only result surface, so the raw object never comes back on replay.

Known limitation: under `--client-env`, the client-backed environment is per **ACP session** (one id
getter), so a child's `fs/*` / `terminal/*` requests are attributed to the parent session id. The
subagent transcript/tool updates themselves carry the child id; only the client-env request
attribution is shared until the env gains a per-child binding.

The task's own `capabilities.cancel` is deliberately not advertised: a subagent is cancelled with its
parent's turn (`session/cancel`), not through a per-child cancel request.


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
| `session/new` / `load` / `resume` / `close` | ✅ (`cwd` is the session root; load replays once incl. tool results; resume primes without replay; a live id is reused) |
| `session/list` / `session/delete` | ✅ (disk catalog filtered by `cwd`; delete is idempotent; only when the host provides the store) |
| client `fs/*` / `terminal/*` | ✅ with `--client-env` (opt-in; `.agents/**` and free-text commands stay local; `exists`/`stat` use local metadata first, remote-only files via the client read, `readdir` local) |
| `session/fork` | ✅ (`session.clone`; restores a cold source; rebinding keeps updates off the source id) |
| `session/prompt` / `cancel` / `set_mode` / `set_config_option` | ✅ (StopReason mapped; cancel → `cancelled`; `set_config_option` dispatches on the option's `category` — the write side of the `mode`, `model` and `thought_level` selects we advertise, each sharing its own entry point) |
| `user_message_chunk` | ✅ replay only (one per stored user turn, stable `messageId`, attachments included); the live path does not echo the prompt |
| `agent_message_chunk` / `agent_thought_chunk` | ✅ incremental (stable `messageId`) |
| `tool_call` / `tool_call_update` | ✅ kind / title / locations / streamed output; a write or edit carries its `diff` — sent as soon as the input is resolvable, and again with the result text, since an update replaces what the client holds; a denied call is `failed`, not `completed` |
| `plan` (from todos) | ✅ always the complete entry list |
| `available_commands_update` | ✅ built-in catalog + extension commands, re-sent when the extension set changes |
| `current_mode_update` / `config_option_update` / `session_info_update` / `usage_update` | ✅ (`config_option_update` on `set_mode`, `set_config_option` and legacy `set_model`, always carrying the WHOLE option set; `session_info_update._meta.diskSessionId` follows a rebind) |
| model selector (`configOptions`, `category: "model"`) | ✅ whenever a model catalog is readable: a single-model plane advertises one fixed value; `.agents/config/models.json` (or a multi-model provider) yields a switchable list. The legacy `models` field and `session/set_model` are still served for older pickers — `set_model` answers with the updated `models` + `configOptions`, and `load`/`resume` carry `models` too, so a picker cannot stay on the previous model |
| thinking-depth selector (`configOptions`, `category: "thought_level"`) | ✅ for a model that advertises reasoning levels; absent otherwise |
| `session/request_permission` | ✅ approvals → four-option round-trip; cancel/timeout/disconnect settle as a denial; `allow_always` / `reject_always` are remembered per session |
| `elicitation/create` | ✅ `ask_user` (multi-select included); without form support the question is posted as text and the turn ends so the next prompt can answer it; decline/cancel/empty-accept/failure settle as a cancelled tool result |
| `compaction_update` / `compaction_summary_chunk` / `notice` | ✅ gated by the client capability (open as `in_progress`, stream the summary, close as `completed` / `failed` / `cancelled`) |
| `subagent_update` + child sessions | ✅ gated by `subagents` (announce → patch; child transcripts under the child id; the parent `task` row is the formatted result) — see [Subagents](#subagents) |
| child ownership | ✅ children are absent from `session/list`; `load` / `resume` / `prompt` / `fork` refuse a child id; `close` / `delete` are no-ops and never destroy one |
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

## IM clients (cc-connect)

The same stdio ACP host is the IM integration surface: an external ACP client (for example
[cc-connect](https://github.com/chenhg5/cc-connect), `[projects.agent] type = "acp"`) spawns
`codent acp` in the workspace and drives sessions, streaming, permissions and `ask_user` over ACP.
There is no Codent-specific IM bridge; the integration is configuration plus this protocol.

- The `cwd` each session request carries is that session's workspace root (`work_dir` on the bridge
  side); the process `cwd` is only the default when `session/list` omits one.
- cc-connect starts one ACP process per chat/session (idle processes may be recycled); every process
  uses the project's `work_dir`, so platforms under one project share the workspace and its persisted
  sessions — not one live session.
- `.env` is loaded by the release host (`codent acp`), not by the standalone `codent-acp` bin.
- A **switchable** model list needs `.agents/config/models.json` (or a multi-model remote provider);
  the flags / `.env` planes advertise a single fixed value.

Full recipe and verification checklist:
[docs/acp-im.md](https://github.com/MrWangJustToDo/Codent/blob/main/docs/acp-im.md).

## Package layout

| Module | Responsibility |
|---|---|
| `agent.ts` | the ACP app: handler registration, the session-id → bridge map, prompt turns, stop reasons, bridge lifecycle |
| `stdio.ts` | the stdio transport (stdin backpressure, stdout EPIPE/flush) |
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
pnpm --filter @codent/acp run validate:acp:conformance # cancel/timeout/resume/load/fork/cwd regressions
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
  a fresh agent via `Host.create`). A live `load`/`resume` with a different list is refused, because
  a live session's servers are fixed at creation. `session/fork` rejects the field for a live source
  (it reuses that agent), but restores a cold source first.
- **ACP v1 has no directory listing or metadata method.** `exists` / `stat` use local metadata first;
  for a file that exists only on the client, `stat` derives `size` from one `fs/read_text_file` (the
  whole file crosses the wire) and reports `mtime` as epoch (`new Date(0)`) because the real mtime is
  unknown — freshness/TTL consumers treat that as stale, never as "just updated". `readdir` (used by
  `list_file` / `tree`) always uses the local fallback, even under `--client-env`. A genuinely remote
  workspace therefore needs those directory tools to run where the files are.
- `session/fork` restores a source created by an earlier process (it is no longer limited to a
  session live in this process), but the forked conversation still runs in this process.
- **Model switching may switch the provider.** Selecting a model option applies that entry's
  `style` / `baseURL` / `apiKey`, the same thing `/models` does in the TUI. Because a switchable list
  only exists on the `models.json` (or multi-model remote-provider) paths, those are the only
  configurations in which it can happen.
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
  that cannot see the roots it asked for. `cwd` is the session's workspace root when present
  (normalized, absolute); an absent value falls back to the process root and a relative one is
  refused.
