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
| `session/prompt` / `cancel` / `set_mode` | ✅ (StopReason mapped; cancel → `cancelled`) |
| `agent_message_chunk` / `agent_thought_chunk` | ✅ incremental (stable `messageId`) |
| `tool_call` / `tool_call_update` | ✅ kind / title / locations / structured diff / streamed output |
| `plan` (from todos) | ✅ |
| `available_commands_update` | ✅ built-in catalog + extension commands |
| `current_mode_update` / `session_info_update` / `usage_update` | ✅ |
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
- Per-session `mcpServers` from `session/new` are not wired yet; the agent uses its
  own `.agents/mcp.json`.
- The ACP session id is the agent id; `session/load` restores the on-disk transcript
  by id.
