# Demo extensions

> **Writing a new extension?** Ask the agent — the built-in `write-extension` skill is the
> canonical guide (module shapes, all five registration channels, hook names, UI surfaces).
> Run `/skill write-extension` to load it, or just describe what you want to add. The files
> here are runnable samples of the same API, not the reference.

Sample modules for manual testing. **Not** loaded by default — core only scans `.agents/extension` and `~/.agents/extension`.

| File | What it demos | How to try |
|------|----------------|------------|
| `demo-ping.mjs` | Slash command + toast | `/ping` / `/ping hello` |
| `demo-echo-tool.mjs` | Custom tool `ext_echo` | Ask the agent to call `ext_echo` |
| `demo-guard.mjs` | `tool:before:run_command` deny | Ask agent to run `rm -rf /` |
| `demo-status.mjs` | Footer render surface (raw text + layout tree) + notification | `/ext-badge on`, `/ext-tree`, `/ext-notify` |
| `demo-turn-context.mjs` | Per-turn context via `registerContextProvider` + `before_agent_start` observer | `/ext-turn on`, then chat; `/ext-turn tab example.com` |
| `demo-pi-like.mjs` | pi-like capabilities: `session:bootstrap`/`session:shutdown`, render surface, plain JSON Schema tool, `modifiedResult`, CoreEnv access | Ask the agent to use `ext_json_echo` or `ext_echo`; `/ext-root` |

Load demos explicitly:

```bash
# env
AGENT_EXTENSION_DIRS=examples/extensions pnpm start:cli

# or CLI flag (comma-separated)
pnpm start:cli -- --extension-dirs examples/extensions
```

Project `.agents/extension` and `~/.agents/extension` still load automatically; same id later wins.

Export shape: `ExtensionAPI` object, `ExtensionFactory` (`{ create() }`), or `activate(ctx)` function (see `normalizeExtensionExport`).

Manage loaded extensions at runtime from the **extensions panel** (`Ctrl+Y`). Each extension can be toggled there; disabling deactivates it and unregisters its tools, commands, interceptors, turn-context providers, and message transformer. There is **no** `/extensions` slash command.

For tool schemas, use **`ctx.z`** (host Zod) as the convenience API. `inputSchema`/`outputSchema` are also widened to accept any Standard-Schema / JSON-Schema-compliant schema (Zod, ArkType, Valibot, or a plain JSON Schema object) — see `demo-pi-like.mjs`.

For per-turn model-visible text, use `ctx.registerContextProvider({ content, disabledContent })` — one section per extension, emitted each user turn as `<ctx kind=<extension id>>`. `before_agent_start` is an **observer** hook whose payload is only `{ prompt, sessionId }`.

## Tool display (`present`)

A registered tool declares how it is displayed through a **single `present` field**. Core owns it (so it keeps working when the host runs in another process), renders it when the tool completes, and ships the result with the message; hosts only read it.

- **`present.text(result)`** — the result string. In `full` display it renders as the tool's output block; in `compact` display (`/appearance compact`) it renders as **one clamped line** and the row is **kept** instead of being folded into an activity summary. That contract is what keeps an extension tool legible in compact mode, so keep it short and single-line (`demo-echo-tool.mjs`: `echo → hi`).
- **`present.category`** — `reads` / `edits` / `searches` / `commands` / `tasks` / `other`: the activity bucket the tool is counted in when it *is* folded.
- **`present.label(input)`** — the short text shown after the count (a filename, a query, a message). Without it, a folded tool is still named in the summary (`ext_echo ×2`) instead of an opaque `N other`.
- **Optional extras**: `keepRow` (row never folds — interactive/structured results), `detailed`, `clientSide` (the host supplies the result), `summary(output)` (header text) and `labelKey` (declarative label source for hosts that cannot call functions). See `packages/core/src/agent/tools/presentation/types.ts`.

Every `present` function must be a **pure function** of the stored result (or the parsed input): the rendered value is persisted with the session and replayed on restore.

Extensions can now also:
- Observe the agent session lifecycle via `session:bootstrap` / `session:shutdown` interceptors.
- Draw into the host UI via the single generic surface: `ctx.ui.render(surface, key, payload)` with `payload` = raw text (ANSI + newlines preserved) or a `text` / `row` / `column` / `box` layout tree. `null` removes the slot; slots are per-extension and cleared when it is disabled. `surface` is currently `"footer"` — the only surface the hosts implement — and `key` scopes the slot within it (`packages/app/src/layout/FooterExtensionSurface.tsx`).
- Push a **transient** notification with `ctx.ui.notify(message, level)` — use it for one-off events, and a render slot for anything that should persist.
- Rewrite a tool result by setting `event.payload.modifiedResult` in a `tool:after:<name>` interceptor (the middleware returns the modified result to the model).
- Access the runtime through `ctx.coreEnv` — the single source of truth for `rootPath`, filesystem, shell, fetch, path utilities, and env vars (see `demo-pi-like.mjs` `/ext-root`).
