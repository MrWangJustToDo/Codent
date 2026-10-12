# codent

AI coding agent for your terminal. Local workspace, local model keys, one install.

> Published on npm as **`codent-cli`** — the installed *command* is **`codent`**.
> Currently **0.0.1-beta.5**, a pre-release. Source: [MrWangJustToDo/MyAgent](https://github.com/MrWangJustToDo/MyAgent).

`codent` is the **release host** for this monorepo: a local-only terminal CLI that ships as a
single fully bundled, self-contained tarball. `@codent/app`, `@codent/core` and
`@codent/node` are inlined into `dist`, so installing it does not pull any `@codent/*`
package from the registry.

## Install

Requires **Node.js 24+**.

```bash
npm install -g codent-cli
codent
```

```bash
npm install -g codent-cli@beta    # pin the pre-release explicitly
```

### Optional features

Two capabilities ship as `optionalDependencies`, so a platform that cannot provide them
installs cleanly and the feature reports itself as unavailable at runtime instead of
failing the install. Both print a `[node] … (degrading)` line the first time they are
needed, and neither blocks anything else.

| Feature | Needs | Without it |
|---------|-------|------------|
| Code mode (`execute_typescript`) | Node **24+** — `isolated-vm` declares `engines.node >=24` and ships prebuilds for Node 24 and 26 only | The extension registers no code-mode tools. On Node < 24 npm **skips the package silently**, so the warning says so rather than reporting a missing package |
| Image downscaling | `sharp`, which has a prebuilt binding for most platforms | Images over the vision-token budget are rejected instead of resized |

### OS sandbox (Linux)

On Linux the sandbox needs two binaries that are **not** npm packages:

```bash
sudo apt-get install -y bubblewrap socat    # Debian / Ubuntu / WSL
```

Without them `codent` starts normally but prints
`OS sandbox initialization failed (Sandbox dependencies not available: …); shell commands run unsandboxed.`
and every command runs **unsandboxed** — the agent still works, but commands are no longer
restricted to the workspace. Set `SANDBOX_ENV=native` to skip the attempt and the warning.

## Configure

First run opens a config editor and writes `.agents/config/models.json`. You can also use a
`.env` file in your project root:

```bash
MODEL_STYLE=openai          # openai | anthropic
MODEL=anthropic/claude-3.5-sonnet
BASE_URL=https://openrouter.ai/api/v1
API_KEY=sk-or-v1-xxx
maxIterations=30

# Optional — max concurrent `task` subagents (default 4)
MAX_CONCURRENT_TASKS=4

# Optional — websearch providers (Brave → Parallel → Exa → Tavily → DuckDuckGo)
BRAVE_API_KEY=...           # Brave Search API (keyed)
EXA_API_KEY=...             # Exa keyed tier (free public MCP without it)
PARALLEL_API_KEY=...        # Parallel keyed tier (free public MCP without it)
TAVILY_API_KEY=...          # Tavily (has no free tier — required to use it)
WEBSEARCH_PROVIDER=...      # pin a provider: brave | parallel | exa | tavily | duckduckgo | auto
MCP_CONFIG_PATH=...         # MCP server config
```

Priority: CLI args > env vars > defaults.

## Usage

```bash
codent "Create a hello world function"
codent -m gpt-4o -u https://api.openai.com/v1 -k sk-... "Review this code"
codent --continue           # resume the most recent session
codent --resume             # pick a session
```

`codent -h` lists every flag and keyboard shortcut.

### Agent Client Protocol (ACP)

`codent acp` (alias `codent --acp`) serves the agent over the [Agent Client Protocol](https://agentclientprotocol.com)
on stdio, so editors such as Zed or JetBrains can drive it. It is headless — stdout carries only
JSON-RPC frames, never the TUI — and is intercepted before the terminal UI boots.

An ACP client must spawn it with **cwd = the workspace root**. The model is resolved three ways, in
priority order: flags on the command (`codent acp --model … --base-url … --api-key …`, which are
authoritative and skip `models.json`), the on-disk `.agents/config/models.json`, or `MODEL` /
`BASE_URL` / `API_KEY` in `.env`. Without any of them it exits with a clear error.

```bash
codent acp --model anthropic/claude-3.5-sonnet --base-url https://openrouter.ai/api/v1 --api-key sk-or-...
```

```jsonc
// Zed settings.json — run the local codent as an ACP agent
{ "agent_servers": { "codent": { "command": "codent", "args": ["acp"] } } }
```

The development host `@codent/cli` does not expose this subcommand. The `@codent/acp` package also
publishes a standalone `codent-acp` bin (bootstrapping the same local runtime) if you prefer to
depend on it directly instead of the bundled `codent acp`.

## Difference from `@codent/cli`

> The published name is **`codent-cli`**; it is *not* `@codent/cli`. `@codent/cli` is the
> internal development host in `packages/cli` and is never published on its own, so
> `npm install -g @codent/cli` does not work. The installed *command* is `codent` either way.

This package is intentionally narrower than the development CLI in `packages/cli`:

| | published `codent-cli` | internal `@codent/cli` |
|---|---|---|
| Workspace | local Node.js only | local **or** `--remote-env` |
| Model keys | local `.env` / flags | local **or** `--remote-provider` |
| Agent loop | in-process only | in-process **or** `--remote-session` |
| Distribution | one self-contained tarball | declares `@codent/*` runtime deps |

The remote planes live in `@codent/server` and stay on the dev CLI.

## Why the bundle looks the way it does

Two groups of dependencies must stay **external**, and are the only four packages a consumer
is guaranteed to install (see `dependencies` in `package.json`):

1. **Renderer** — `@my-react/react` + `@my-react/react-terminal`. The host must resolve exactly
   one copy; two physical copies means two hook dispatchers and the TUI renders nothing. npm
   does not dedupe an alias against a real package name, which is why the app layer names the
   real packages instead of aliasing `react` / `ink` and rewrites the specifiers at build time.
2. **Asset-bearing packages** — `@anthropic-ai/sandbox-runtime` (seccomp / Windows helper
   binaries under `vendor/`) and `web-tree-sitter` (`tree-sitter.wasm`). Both locate their
   assets relative to their own module URL, which only works from a real on-disk layout.

Two more are external **and optional** (`optionalDependencies`). They are native addons, which
cannot be inlined at all — the binary is not JavaScript — and whose loader must not be inlined
either, because it resolves relative to itself and would look for `prebuilds/` beside our `dist`:

| Package | Used by | When it is missing |
|---------|---------|--------------------|
| `sharp` | `resizeImage` — downscales oversized images to fit the vision-token budget | Images over budget are rejected instead of resized |
| `isolated-vm` | `execute_typescript` (code mode) | The extension registers nothing instead of the tool |

Being optional is the point: npm installs them where a prebuilt binding exists for the platform
and skips them otherwise, so the install always succeeds and the affected feature degrades on its
own. Putting either in `dependencies` would turn "image resizing is unavailable" into "the install
fails" — `pnpm validate:self-contained` fails the build if that happens.

### tree-sitter grammars: copied in, not depended on

`tree-sitter-wasms` is a third kind. Its grammars back `code_overview` / `ast_search` /
`code_rewrite` **and** the `run_command` safety analysis, which parses each command with the `bash`
grammar to decide whether it can be auto-approved. So they are load-bearing, not optional.

They still cannot be a dependency. The package is a 50 MB aggregate of 36 grammars and the host
parses with 18 (22.8 MB) — a runtime dependency would ship the other 27.2 MB to every consumer.
They cannot be inlined either: they are `.wasm`, not JavaScript, so there is nothing for the
bundler to inline.

So they are a **build-time input**. `scripts/copy-tree-sitter-grammars.mjs` copies exactly the
grammars named by core's `LANGUAGE_TO_GRAMMAR` into `dist/tree-sitter/`, and the runtime resolves
them from there first (`grammar.ts` falls back to the installed package for the workspace layout).
The package itself never reaches the tarball — `validate:self-contained` asserts the 18 grammars are
present, because their absence is invisible at build time: the bundle is valid, and every
tree-sitter call simply returns `null` for a user.

Everything else is inlined, including dynamic `import()`s such as PDF text extraction, so those
degrade gracefully instead of failing to resolve.

`pnpm validate:self-contained` asserts all of the above against `dist`, and
`pnpm validate:runtime-specifiers` asserts that no inlined chunk reaches for a package that is
neither bundled nor declared.
