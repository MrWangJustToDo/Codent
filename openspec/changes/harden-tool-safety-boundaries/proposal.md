# Change: Harden tool safety boundaries (command read-only + workspace containment)

## Why

A grouped audit of `@codent/core`'s built-in tools (`docs/tool-audit-findings.md`) found three
source-verified security defects:

- The command-safety analyzer labels several commands **read-only by name**, so write-capable
  forms are auto-approved with no prompt: `env rm -rf src`, `find . -delete`,
  `sed -e "w /tmp/pwn" f`, `git diff --output=/repo/x`.
- The search tools (`glob` / `grep` / `tree`) never check their `path` against the workspace
  root and run with **no `cwd`**, so `path:"/etc"` or `path:"../../.."` reads outside the
  workspace (and these are the auto-approved read-only tools), while the default `path:"."`
  searches `process.cwd()` instead of the workspace root.
- The Node filesystem confinement is **lexical only**, so an in-root symlink pointing outside
  the workspace escapes it for both reads and writes.

## What Changes

- **command-safety**: read-only classification rejects write-capable forms of `env`, `find`,
  `sed`, and `git … --output`.
- **workspace-containment**: search-tool paths must resolve inside the workspace root, the
  search binaries run with `cwd = rootPath`, and the Node fs gate resolves symlinks before
  confirming containment.

## Impact

- Affected specs: `command-safety-portability` (ADDED requirement) and a new
  `workspace-containment` capability.
- Affected code: `command-analyzer.ts`; `exec-args.ts` / `search-command.ts` /
  `glob-tool.ts` / `grep-tool.ts` / `tree-tool.ts`; `native-fs.ts`.
- Behavior (intended, not an API break): a handful of previously auto-approved commands now
  require approval, and a search `path` outside the workspace is now rejected rather than
  searched.
