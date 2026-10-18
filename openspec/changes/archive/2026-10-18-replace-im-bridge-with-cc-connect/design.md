## Context

Two IM paths exist today and only one is generic:

- `@codent/im-bridge` — a hand-written AgentSession client. `ChatAdapter` per platform (Telegram
  via grammY), `SessionResolver` journal, `RunRenderer` (ordered, grouped tool rows, in-place edits),
  `PendingInteractionStore` (approval / `ask_user` buttons), `AccessControl`. It does **not** speak
  ACP, so it cannot drive or be driven by any other agent, and every new platform is another adapter
  inside this repo.
- `@codent/acp` — the ACP v1 agent host. Its README already states the intent: "so an editor
  (Zed, JetBrains) **or an ACP→IM bridge** can drive the agent with no Codent-specific host code".

The ACP surface is now complete enough to be that bridge's only contract (verified against the
current code):

| Surface | Where |
|---|---|
| `initialize`, `prompt`, `cancel`, `session/new|load|resume|close|list|delete|fork` | `packages/acp/src/agent.ts` |
| `session/load` & `resume` return `modes` + `configOptions` | `session-status.ts` (`sessionSelectorsFor`), `agent.ts:537,547` |
| streaming text / thought / tool calls / plan / usage | `projector.ts` |
| permissions (four standard options) | `permissions.ts:17` |
| `ask_user` via `elicitation/create` (with fallback) | `permissions.ts:59`, `interactions.ts` |
| model / thought_level / mode selectors + write paths | `session-config-options.ts` |
| command catalog (`available_commands_update`) | `commands.ts` |
| image / audio / resource prompt content | `content.ts` |
| per-session `mcpServers` | `mcp.ts` |

`cc-connect` (MIT, Go) was selected over the alternatives because it is the only off-the-shelf
bridge that covers both domestic and foreign mainstream platforms **and** has a generic ACP agent:
`[projects.agent] type = "acp"` with `cmd` + `args`. Its platform set includes Feishu/Lark,
DingTalk, WeCom, WeChat, QQ / QQ Bot, Telegram, Slack, Discord, LINE, Matrix, WPS and Weibo, and its
operational layer includes `allow_from` / `admin_from`, `banned_words`, per-user roles and rate
limits.

## Goals / Non-Goals

- **Goals**: one IM integration contract (`codent acp`); no in-repo platform adapters; a checked-in,
  reviewable cc-connect recipe; docs that name the real state of the ACP surface.
- **Non-Goals**: changing the ACP protocol surface; adding ACP remote HTTP/WS transport; building or
  vendoring an ACP client in this repo; keeping `@codent/im-bridge` as a deprecated fallback
  (a dual path is the cost this change removes); replacing cc-connect with OpenClaw or a fork.

## Decisions

- **D1 — cc-connect is external, not vendored.** The operator installs it
  (`npm i -g cc-connect`, Homebrew, or a release binary) and runs it as its own service. The repo
  ships `docs/cc-connect.example.toml` + `docs/acp-im.md`. Vendoring a Go project into a pnpm
  monorepo would add a second build system and a fork to maintain.
- **D2 — delete, do not deprecate.** The package is removed with its validators and root scripts.
  Git history retains the implementation, and the repo convention rejects compatibility shims. A
  deprecated package still typechecks, lints and validates on every PR for no user.
- **D3 — `codent acp` is the contract.** stdio only; the workspace root is the process `cwd`; model
  configuration comes from `--model/--base-url/--api-key`, `.agents/config/models.json`, `.env`
  (`codent acp` loads `.env`; the standalone `codent-acp` does not), or the `--remote-provider`
  plane. A **switchable** model list needs `models.json` (or a multi-model remote provider); the
  flags / `.env` planes advertise a single fixed value, so the recipe tells operators to provide
  `models.json` when they want a choice.
- **D4 — process and workspace model.** One cc-connect project maps to one workspace:
  `work_dir` is the workspace root and the ACP process's `cwd`. cc-connect starts an ACP process per
  chat/session (idle processes may be recycled) with that `work_dir`, so platforms under one project
  share the workspace and its persisted sessions, not one live session; a second workspace is a
  second `[[projects]]`.
- **D5 — platform policy stays in cc-connect.** DM pairing/allowlists, group/mention policy, banned
  words, per-user roles and rate limits are cc-connect's; Codent does not duplicate them. For
  enterprise deployments prefer official platform APIs; personal WeChat / QQ (OneBot/NapCat) are
  unofficial and called out as such in the guide.
- **D6 — no ACP behaviour change.** Only the README correction (load/resume selectors) and IM
  usage notes. The `initialize` prompt capabilities remain permissive at the process level
  (`image/audio/embeddedContext` are advertised process-wide, while core strips a modality the
  chosen model lacks); the guide states that consequence so an operator does not read a dropped
  image as a bridge bug.
- **D7 — document the bridge's projections, not an idealised ACP client.** cc-connect, as reviewed,
  consumes `modes` but not `configOptions` / `available_commands_update`, does not declare
  elicitation, and delivers images as local file paths rather than ACP `image` blocks. The guide
  states these observed behaviours and the checklist is the source of truth after a cc-connect
  upgrade, rather than promising behaviour the bridge does not implement.

## Risks / Trade-offs

- **Third-party dependency** (Go, active, sponsor-heavy) → pin a version in the guide; the ACP
  contract is the escape hatch if it is ever replaced.
- **Bridge projection variance** → cc-connect consumes only `modes` (not `configOptions` /
  commands), does not implement elicitation, and sends images as paths; the guide states the
  observed behaviour and the checklist re-verifies after every upgrade. ACP remains the contract if
  a better bridge replaces it.
- **Model/mode pickers** → depends on how cc-connect projects ACP `configOptions`; the recipe
  provides `models.json` and tests `/models` and `/mode`, falling back to the agent's own ACP
  commands.
- **No ACP auth** → keys live in the service environment; the guide warns against exposing the
  gateway beyond trusted hosts.
- **Removal is breaking** for `pnpm start:im-bridge` users → the guide gives the replacement steps,
  and the change is a single revert if needed.

## Migration Plan

1. Install cc-connect and add the `codent` project (`type = "acp"`, `cmd = "codent"`,
   `args = ["acp"]`, `work_dir` = workspace).
2. Add Telegram + Feishu (one foreign, one domestic) and run the verification checklist.
3. Remove `@codent/im-bridge`, `im-bridge.mjs` and the root scripts in the same change; update
   docs.
4. Rollback: revert the commit (the package is restored from git history).

## Open Questions

- If cc-connect's rendering or `ask_user` fidelity proves insufficient, do we later build a thin
  in-repo ACP client reusing `@agentclientprotocol/sdk` (the deferred "Path B"), or accept the
  external bridge? Out of scope for this change; the ACP contract keeps both options open.
- First rollout is decided: **Telegram + Feishu** (one foreign, one domestic), as encoded in
  `docs/cc-connect.example.toml` and the verification checklist.
