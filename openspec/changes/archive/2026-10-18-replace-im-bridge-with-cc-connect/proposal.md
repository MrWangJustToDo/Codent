## Why

`@codent/im-bridge` is a second integration path: it talks to `AgentSession` directly, re-implements
platform adapters, session journalling, run rendering and interaction buttons, and must be extended
once per IM platform (Telegram today; Slack/Discord/Feishu later). Meanwhile `@codent/acp` now
exposes the full generic surface — sessions (`new` / `load` / `resume` / `list` / `delete` / `fork`),
streaming updates, tool calls with diffs, permissions, `ask_user` via elicitation, model / mode /
thinking-depth config options, commands, per-session MCP servers — explicitly so an external ACP
client (editor **or IM bot**) can drive it.

Maintaining both paths is duplicated cost, and only the ACP one is generic. `cc-connect` already
implements 13 IM platforms with the domestic + foreign coverage we need (Feishu/Lark, DingTalk,
WeCom, WeChat, QQ, Telegram, Slack, Discord, LINE, Matrix, …), plus allowlists, role-based command
ACL, rate limits, a web admin, cron and attachments. Its generic `type = "acp"` agent takes a
`cmd` + `args`, so `codent acp` plugs in with configuration only.

## What Changes

- **Remove `@codent/im-bridge`** — the workspace package, `im-bridge.mjs`, the root
  `build:im-bridge` / `dev:im-bridge` / `start:im-bridge` scripts, and its validators.
  **BREAKING** for anyone running `pnpm start:im-bridge`; git history keeps the implementation.
- **IM integration becomes an external ACP client**: `cc-connect` → `codent acp` (stdio). The
  repository ships the recipe, not the bridge.
- Add a checked-in cc-connect example (`docs/cc-connect.example.toml`) and an integration guide
  (`docs/acp-im.md`) covering model/env, `work_dir`, platform blocks, filtering, and the ACP
  behaviour each platform relies on.
- Correct the ACP README: `session/load` / `resume` now return `modes` + `configOptions` (the
  "known limitation" is stale), and document the IM usage (one process per workspace, `work_dir`
  as the ACP root, elicitation/permission mapping).
- Update `AGENTS.md` and `README.md`: drop the package row, the build/run scripts, and the
  "in-repo bridge" phrasing; name the ACP→IM path instead.
- No change to the ACP protocol surface or to `@codent/core`.

## Capabilities

### New Capabilities

- `acp-im-integration`: the supported way Codent reaches IM — an external ACP client
  (`cc-connect`) driving `codent acp`; the configuration the repository ships; the ACP behaviour an
  IM client may rely on; and the rule that no in-repo IM bridge is built or maintained.

### Modified Capabilities

None — the ACP agent's behaviour is unchanged; this change retires a sibling host and documents
the external-client path that `acp-agent-host` already anticipates ("can be spawned as a subprocess
by an ACP client — an editor or an IM bot").

## Impact

- **Removed**: `packages/im-bridge/**` (source, scripts, validators, package manifest),
  `im-bridge.mjs`, root scripts `build:im-bridge` / `dev:im-bridge` / `start:im-bridge`.
- **Added**: `docs/acp-im.md`, `docs/cc-connect.example.toml`.
- **Docs**: `AGENTS.md` (package table, host lists, script list, built-in-name guard note),
  `README.md` (package table, IM section), `packages/acp/README.md` (stale limitation + IM note).
- **Dependencies**: none added to the monorepo; `cc-connect` is an external runtime the operator
  installs (`npm i -g cc-connect`).
- **Operators**: replace `pnpm start:im-bridge` with a cc-connect service whose `codent acp`
  command points at the workspace.
