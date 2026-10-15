# @codent/acp

Agent-side [Agent Client Protocol](https://agentclientprotocol.com) host for Codent.

Exposes an `AgentSessionHost` over ACP on **stdio**, so an editor (Zed, JetBrains)
or an ACP→IM bridge can drive the agent with no Codent-specific host code. Unlike
`pi-acp`, which bridges to a subprocess RPC, this drives the in-process
`AgentSession` directly.

## Serve over stdio

```bash
# from a built checkout
pnpm --filter @codent/acp build && node packages/acp/dist/bin.mjs

# or via the release host
codent acp          # installed via: npm i -g codent-cli

# configure the model directly (authoritative; skips .agents/config/models.json)
codent acp  --model anthropic/claude-3.5-sonnet --base-url https://openrouter.ai/api/v1 --api-key sk-or-...
codent-acp  --model anthropic/claude-3.5-sonnet --base-url https://openrouter.ai/api/v1 --api-key sk-or-...
```

The workspace root is the process `cwd` — the local CoreEnv is built from it
(`createNodeEnv`) — so a client should spawn the agent **inside** the workspace it
wants it to see.

### `--client-env` (opt-in)

By default everything — file reads/writes and commands — runs on our own local CoreEnv,
and the client's `clientCapabilities.fs` / `.terminal` are ignored. `--client-env` flips
that for files and argv execution, so an editor's native facilities are used instead
(diff views, its terminal, its permission prompts):

```bash
codent acp --client-env
```

What it does and does not change:

- **Per session, not per process.** Every `fs/*` and `terminal/*` request carries a
  `sessionId`, so each session gets its own env (and its own runtime — the existing
  "one runtime owns one env" rule, not a second environment registry).
- **`.agents/**` and anything outside the workspace root never reach the client.** Session
  logs, media, memory, plans and config are ours; a client that declines to serve a hidden
  directory would otherwise silently cost the agent its ability to persist a conversation.
- **Only argv-shaped execution goes to the client terminal.** ACP's `terminal/create` takes
  `command` + `args` with no shell, so `execFile` (glob / grep / tree) routes there, while
  `exec` and `run_command` — both free text — stay on the local shell. That keeps
  command-safety's shell analysis and the shell that actually runs the command the same one;
  inventing a `sh -c` wrapper would hand the command to a shell we cannot describe.
- **Approval moves only where the operation actually goes.** A workspace `write_file` /
  `edit_file` is now authorised by the client that serves the write, so `codent acp` does not ask
  you a second time — the client already did. Three things deliberately keep their prompt:
  writes that stayed local (`.agents/**`, outside the root, or a client without
  `fs.writeTextFile`), `delete_file` / `kill_command` (ACP's `fs/*` covers reading and writing text
  and nothing else — the write capability is not a licence to delete), and `run_command` (it runs
  on our own shell). Plan mode also keeps them: the client authorises a file operation, not the
  read-only phase.
- **A missing capability falls back, it does not fail.** Read-only clients read remotely and
  write locally; a client without `terminal` falls back for every command, and `execFile` is
  simply absent (feature detection reads "unsupported" and degrades) rather than defined to
  throw. The capability matrix and every fallback decision are logged to stderr.

Model resolution order: `--model` / `--base-url` / `--api-key` flags (authoritative, skip
`models.json`) > `.agents/config/models.json` > `.env` (`MODEL` / `BASE_URL` / `API_KEY`).

## Use in-process

```ts
import { createAcpAgent, bootstrapAcpAgent } from "@codent/acp";

const options = await bootstrapAcpAgent(); // CoreEnv + model provider + local host
const app = createAcpAgent(options);       // register handlers, then `app.connect(stream)`
```

`createAcpAgent({ host, defaults, rootPath })` accepts any `AgentSessionHost`, so a
host that is remote (`--remote-session`) can be served over ACP too.

## Coverage

| ACP surface | Status |
|---|---|
| `initialize` / `authenticate` / `logout` | ✅ (capabilities negotiated; no interactive auth) |
| `session/new` / `load` / `resume` / `close` | ✅ (load replays; resume does not) |
| `session/list` / `session/delete` | ✅ (disk catalog; only when the host provides the store) |
| client `fs/*` / `terminal/*` | ✅ with `--client-env` (opt-in; `.agents/**` and free-text commands stay local) |
| `session/fork` | ✅ (`session.clone`; source must be live in-process) |
| `session/prompt` / `cancel` / `set_mode` | ✅ (StopReason mapped; cancel → `cancelled`) |
| `agent_message_chunk` / `agent_thought_chunk` | ✅ incremental (stable `messageId`) |
| `tool_call` / `tool_call_update` | ✅ kind / title / locations / structured diff / streamed output |
| `plan` (from todos) | ✅ |
| `available_commands_update` | ✅ built-in catalog + extension commands |
| `current_mode_update` / `config_option_update` / `session_info_update` / `usage_update` | ✅ (`config_option_update` on `set_mode`) |
| `session/request_permission` | ✅ approvals → four-option round-trip |
| `elicitation/create` | ✅ `ask_user` (with an agent-message fallback) |
| `compaction_update` / `notice` | ✅ gated by the client capability |

## Editors (Zed)

```jsonc
{
  "agent_servers": {
    "codent": { "type": "custom", "command": "codent", "args": ["acp"], "env": {} }
  }
}
```

## Known limitations

- stdio only (ACP remote HTTP/WS transports are still experimental).
- Per-session `mcpServers` from `session/new` are connected over stdio, http, or sse; a
  client-supplied list REPLACES `.agents/mcp.json` for that session (it is not merged). The
  `acp` transport (a client-bridged server) is not supported and is rejected explicitly.
- `session/resume` / `session/load` accept `mcpServers` the same way `session/new` does (both build
  a fresh agent via `Host.create`). `session/fork` rejects it, because a fork reuses the source's
  live agent and genuinely cannot swap servers.
- The ACP session id is the disk session id.
- `additionalDirectories` is not supported and is refused with a JSON-RPC error on every request
  that can carry it (`session/new`, `session/load`, `session/resume`, `session/fork`) — one shared
  check, one message. It is never silently ignored, so a client cannot end up talking to an agent
  that cannot see the roots it asked for. `cwd` is only a hint (the root is fixed at handshake) and
  is not forwarded.
