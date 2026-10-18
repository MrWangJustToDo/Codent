## 1. Retire the in-repo bridge

- [x] 1.1 Delete `packages/im-bridge/` (source, `scripts/`, `package.json`, `tsconfig`, `tsdown.config.ts`)
- [x] 1.2 Delete the root `im-bridge.mjs` entry
- [x] 1.3 Remove `build:im-bridge`, `dev:im-bridge`, and `start:im-bridge` from the root `package.json`
- [x] 1.4 Refresh the lockfile/workspace graph (`pnpm install`) and confirm no package depends on `@codent/im-bridge`

## 2. Ship the cc-connect recipe

- [x] 2.1 Add `docs/cc-connect.example.toml` with a `codent` project (`type = "acp"`, `cmd = "codent"`, `args = ["acp"]`, `work_dir`), model env, and Telegram + Feishu platform blocks
- [x] 2.2 Add `docs/acp-im.md` covering install, config, model sources (`models.json` / `.env` / flags), workspace mapping, filtering/roles/rate limits, unofficial-platform caveats, and the verification checklist
- [x] 2.3 Document the degraded `ask_user` path (no elicitation), image delivery as local paths, and the process-level image/audio capability note
- [x] 2.4 Add the migration note (`IM_BRIDGE_*` no longer read), the security defaults (`allow_from` default `*`, `admin_from = "*"` shell risk), and version-pinning guidance

## 3. Correct the ACP documentation

- [x] 3.1 Remove the stale `session/load` / `session/resume` "no configOptions" limitation from `packages/acp/README.md`
- [x] 3.2 Add a short "IM clients" note: stdio, `cwd` as root, one process per workspace, model selector only on the `models.json` path, and the pointer to `docs/acp-im.md`

## 4. Update repository docs

- [x] 4.1 `AGENTS.md`: drop the `@codent/im-bridge` package-table row and the build/start/dev script lines; update host lists and the built-in-name guard note to `app/acp`
- [x] 4.2 `README.md`: drop the package row and the "IM Bridge (Telegram)" section; replace with the ACP → cc-connect pointer
- [x] 4.3 Sweep remaining non-historical references (`packages/core` comments, `CLAUDE.md`, `.github/workflows/release.yml` comment, `eslint.config.cjs` globs) and update the ones that name the bridge as a supported host

## 5. Validate

- [x] 5.1 `pnpm build` / `pnpm typecheck` across the workspace
- [x] 5.2 `pnpm lint` and prettier on the changed files
- [x] 5.3 Run the validator suite; confirm no validator references the retired package
- [x] 5.4 `grep -rn "im-bridge"` (excluding `openspec/changes/archive` and lockfiles) returns only historical/migration mentions — no package, script, import, workspace dependency, or lint glob
- [x] 5.5 `openspec validate replace-im-bridge-with-cc-connect --strict`
