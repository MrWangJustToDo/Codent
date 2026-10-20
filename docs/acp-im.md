# ACP → IM integration (cc-connect)

Codent reaches chat platforms through **an external ACP client**, not a bridge inside this
repository. The supported integration is:

```
IM platform ──cc-connect channel──▶ cc-connect ──ACP/stdio──▶ codent acp ──▶ AgentSession
```

`cc-connect` owns every platform connection, access policy, rendering and delivery. `codent acp`
owns the agent: sessions, tools, approvals, model/mode selection, persistence. The only contract
between them is ACP v1.

The former `@codent/im-bridge` package has been retired (archived change:
`openspec/changes/archive/2026-10-18-replace-im-bridge-with-cc-connect/`). This document is the
replacement recipe.

## Prerequisites

- **Codent ACP entry**: the release host, `npm i -g codent-cli`, command `codent acp`.
  The standalone `codent-acp` bin exists in `@codent/acp`, but that package is **not published on
  its own** — build it from this repo (`pnpm --filter @codent/acp build`, then
  `node packages/acp/dist/bin.mjs`) if you need it. It does **not** load `.env`.
- **cc-connect** (MIT, Go): `npm i -g cc-connect`, Homebrew, or a GitHub release binary. Pin a
  version you have verified; the projection details below are bridge-version-specific.
- **A Codent build that includes the current ACP surface.** Published `codent-cli` betas may predate
  the `session/load`/`resume` selector and `/models` merge work described here; build from this
  repository until a matching release exists.
- **A workspace**: the project directory the agent should see. It becomes the ACP workspace root and
  hosts `.agents/` (sessions, logs, memory, config).
- **Model access**: an API key, or `.agents/config/models.json`.

## Install and configure

1. Install cc-connect and start it once to create `~/.cc-connect/config.toml`:

   ```bash
   npm i -g cc-connect
   cc-connect            # prints the web admin at http://localhost:9820
   ```

   Configure in the web admin, or copy [`docs/cc-connect.example.toml`](./cc-connect.example.toml)
   to `~/.cc-connect/config.toml`.

2. The agent block is the integration:

   ```toml
   [[projects]]
   name = "codent"

   [projects.agent]
   type = "acp"

   [projects.agent.options]
   work_dir = "/absolute/path/to/workspace"
   cmd = "codent"
   args = ["acp"]
   display_name = "Codent"
   ```

   `env` (model credentials) also belongs under `[projects.agent.options]`; a project has no
   top-level `env`.

3. Add one `[[projects.platforms]]` block per chat platform (Telegram and Feishu are in the example;
   DingTalk, WeCom, Slack, Discord, Matrix, QQ, LINE, Weibo, … use the same shape).

4. Run cc-connect as a service (`cc-connect daemon install`, systemd, or launchd) and verify with
   `/whoami` or `/status` in a DM.

## Model configuration

`codent acp` resolves the model locally. The planes, in the order the bootstrap checks them:

1. **`--remote-provider` / `REMOTE_PROVIDER`** — a provider server supplies the connection **and**
   its model list. When present it wins; do not combine it with `--model`.
2. **explicit flags** (`--model`, `--style`, `--base-url`, `--api-key`) — authoritative, and the
   on-disk `models.json` is skipped;
3. **`.agents/config/models.json`**;
4. **`.env`** (`MODEL` / `MODEL_STYLE` / `BASE_URL` / `API_KEY`).

Important consequences for IM:

- **Use `codent acp`, not `codent-acp`, if you rely on `.env`.** `.env` loading is the release
  host's step; the standalone bin sees only the real process environment plus `models.json`.
- **A switchable model list needs `.agents/config/models.json` (or a multi-model remote provider).**
  The flags / `.env` planes still advertise a `model` option, but with a single fixed value: that is
  information (which model is running), not a choice.
- Alternatively pass credentials through `env = { ... }` under `[projects.agent.options]`.

On the ACP side, `session/load` and `session/resume` return `modes` + `configOptions`, so a client
that reads them keeps the selectors across a restart. cc-connect, as reviewed, only consumes the
legacy `modes` field — so **`/mode` survives, while a model/thinking-depth picker UI does not appear
in chat**; use the agent's `/models` command instead (see below).

## Workspace and process model

- `work_dir` is sent as each session request's `cwd`, which is that session's **workspace root**
  (required and absolute). The ACP process `cwd` only supplies the default for `session/list` when
  the request omits a `cwd`.
- One `[[projects]]` = one workspace. cc-connect starts an ACP process **per chat/session** (idle
  processes may be recycled) with that `work_dir`; platforms under one project share the **workspace
  and its persisted sessions**, not one live session.
- A session starts with an ACP handle equal to its on-disk session id (`ses_…`). cc-connect's
  `/new`, `/list`, `/switch` map to ACP `session/new`, `session/list`, `session/load`. It does
  not call `session/resume`.
- `session/new` returns a **stable ACP handle** (initially the disk id). An in-session `/clear`,
  `/clone` or `/resume` keeps the handle and reports the new disk id in
  `session_info_update._meta.diskSessionId`; `session/list` / `session/delete` use disk ids, and
  `session/load` accepts either.
- `/list` pages at 50 sessions by default and cc-connect reads only the first page; a workspace with
  more sessions needs `/switch <id>` or a narrower workspace.
- `session/load` replayed history includes assistant/tool records; cc-connect suppresses the replayed
  **user** messages, so the restored transcript is not a full chat mirror.
- Within one project, `/list` / `/switch` can reach any persisted session in that workspace,
  including one started from another platform. Use separate `[[projects]]` when platforms must not
  share sessions.

## Platforms

| Category | Platforms |
|---|---|
| Foreign mainstream | Telegram, Slack, Discord, Matrix, LINE, Google Chat |
| Domestic mainstream | Feishu/Lark, DingTalk, WeCom, WeChat, QQ / QQ Bot, WPS, Weibo |
| Protocol/adapter | Webhook, Bridge WebSocket (external adapters in any language), Management API, Web admin |

**Enterprise caveat:** Feishu/Lark, DingTalk and WeCom use official APIs (WebSocket / Stream, no
public IP in the recommended modes). **Personal WeChat and QQ (NapCat / OneBot) are unofficial** —
treat them as best-effort and do not use them for enterprise deployments. For Lark, `type = "lark"`
is the canonical spelling (`type = "feishu"` with the Lark domain also works).

## Access control, filtering and rate limits

These belong to cc-connect; Codent does not re-implement them:

- `allow_from` (per platform) — allowed sender ids; **default is `*`**, so set it explicitly in
  production.
- `admin_from` (per project) — who may run privileged commands: `/dir`, `/shell`, `/restart`,
  `/upgrade`, `/commands addexec`, `/cron addexec`. It is **project-level and shared by every
  platform** in that project. Never set `"*"` unless every allowed user may run shell on the host.
- `allow_chat` / `group_only` / mention rules — **Feishu/Lark only**; Telegram uses
  `group_reply_all` instead.
- `banned_words` — blocked before reaching the agent.
- `[rate_limit]` / `[outgoing_rate_limit]` — per-session inbound and per-platform outbound pacing.
- `[projects.users.roles.*]` — per-user command ACL and rate limits.
- `filter_external_sessions = true` — hide sessions created by the Codent TUI in the same `work_dir`
  from `/list` / `/switch`.

Use `/whoami` or `/status` in chat to learn your platform user id.

## Interaction mapping (cc-connect as reviewed)

| ACP surface | What actually happens in chat |
|---|---|
| `agent_message_chunk` / `agent_thought_chunk` | streaming reply / thinking (subject to the display mode) |
| `tool_call` / `tool_call_update` | tool rows; streamed command output where supported; long tool text is subject to `[display] tool_max_len` |
| `session/request_permission` | approve / deny buttons (four standard options) |
| `elicitation/create` (`ask_user`) | cc-connect does **not** declare the elicitation capability, so the fallback runs: the question and its numbered options are posted as an agent message and the tool stays pending. The next plain-text message answers it (the tool result), rather than starting a new turn; a slash command is still a command. |
| `modes` / `set_mode` | `/mode` works (cc-connect reads the legacy field and calls `session/set_mode`) |
| `configOptions` (`model`, `thought_level`) | not projected by cc-connect; `/model` targets its own provider registry. Use the agent's `/models` command (it is forwarded as a prompt). |
| `available_commands_update` | not projected; `/help` lists cc-connect's commands only. Agent commands such as `/models` still work when typed (unknown commands are forwarded). |
| `plan` update | rendered as a thinking text block by cc-connect, not a plan/todo card |
| `compaction_update` / `notice` | only for clients that advertise the capability; cc-connect does not |
| `subagent_update` / child sessions | only for clients that advertise `subagents`; cc-connect does not, so live subagent progress is not projected. The parent `task` row still arrives as `tool_call_update` with the formatted result (summary + `limit reached` / `cancelled` / `stalled`), so chat users see what the delegation produced. A client that does advertise it receives the child's transcript as ordinary `session/update` frames carrying the child session id — no protocol extension and no cc-connect change beyond declaring the capability. |
| Images / audio | cc-connect saves inbound images under `<work_dir>/.cc-connect/attachments/` and appends the local path to the prompt text — it does **not** send ACP `image` blocks. The model must `read_file` that path; audio needs cc-connect's `[speech]` transcription. |

Because these projections are cc-connect behaviour, re-run the checklist after upgrading it.

## Verification checklist

Run these after configuring; do not declare the migration done until all pass.

1. **Prompt / streaming** — send a message; the reply streams (or updates in place) and finishes.
2. **Tools** — ask for a file read and a command; tool rows and their results appear.
3. **Approval** — trigger a write; approve/deny buttons appear; each resolves the run.
4. **`ask_user` fallback** — trigger it; the question appears as an agent message and the tool ends
   cancelled (cc-connect does not implement the elicitation form).
5. **Model** — `/models` (forwarded to the agent) lists and switches a model when `models.json`
   exists; a single-model setup reports one fixed value.
6. **Mode / resume** — `/mode` switches the mode; restart cc-connect, then `/list` + `/switch` restores
   the conversation with `/mode` still working (assistant/tool records replay; user messages are
   suppressed).
7. **Images** — send a photo to a vision model; confirm the model `read_file`s the attachment path
   that cc-connect appended. A text-only model sees the path, not the image.
8. **Access control** — a non-allowlisted user is rejected; an allowlisted admin can run a
   privileged command; a non-admin cannot.
9. **Cross-platform sessions** — confirm whether `/list`/`/switch` reaching another platform's
   session is acceptable for this deployment; split into separate projects if not.
10. **Long output** — a large tool result is rendered according to `[display]` settings; raise
    `tool_max_len` / disable truncation if the default is too small.

## Migration from the retired bridge

- `IM_BRIDGE_*` environment variables and the Codent-side `TELEGRAM_BOT_TOKEN` are **no longer
  read**. The bot token moves into the cc-connect platform block; model credentials move to
  `.env` / `models.json` / `env` under `[projects.agent.options]`.
- Per-chat session state lived under `.agents/im-bridge/`; cc-connect keeps its own state under
  `~/.cc-connect` and the workspace's `.cc-connect/`. Old bridge sessions are not imported.

## Troubleshooting

- **The agent never answers** — run `codent acp` manually from the same `work_dir` and environment;
  confirm stdout carries only JSON-RPC (diagnostics go to stderr) and that a model resolves.
- **No model choice** — add `.agents/config/models.json`; the flags/`.env` planes advertise one
  fixed value by design.
- **`/models` appears to do nothing** — it is not a cc-connect command, so it is forwarded to the
  agent as a prompt. Check that `models.json` exists and is readable, and that the message was not
  consumed as a cc-connect command.
- **A write has no approval prompt** — check the selected cc-connect `/mode` and whether the bridge
  forwards `session/request_permission`.
- **`ask_user` becomes a normal message** — expected; cc-connect does not implement elicitation.
- **Images are not understood** — cc-connect passes a file path, not image content; use a model that
  can read files (and check the attachment directory is inside the workspace).

## References

- ACP agent surface and coverage: [`packages/acp/README.md`](../packages/acp/README.md)
- cc-connect configuration reference:
  <https://github.com/chenhg5/cc-connect/blob/main/config.example.toml>
- Agent Client Protocol: <https://agentclientprotocol.com>
