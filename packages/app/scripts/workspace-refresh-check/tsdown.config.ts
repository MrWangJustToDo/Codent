/**
 * Bundles the workspace panel for `validate-workspace-refresh-check.mjs`, so the check mounts the
 * shipped component rather than a copy of it.
 *
 * Same renderer-rewrite plugin as the real builds: `src` writes the bare `react` / `ink` names, and
 * the app has no such dependencies — this is what makes them resolve to the single renderer instance
 * the check's own `import "@my-react/react"` resolves to. Without it the check dies at IMPORT time
 * with `ERR_MODULE_NOT_FOUND` instead of reporting a result.
 *
 * One bundle, several entries, on purpose: the panel and the assertions must share ONE store graph.
 * Importing `src` through a second entry would resolve two copies of every store and produce false
 * results (the failure mode the render-smoke documents).
 *
 * Run through `pnpm --filter @codent/app run validate:workspace-refresh`.
 */
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "tsdown";

import { RENDERER_EXTERNAL, rewriteRendererSpecifiers, TYPES_EXTERNAL } from "../../tsdown.shared.ts";

const here = dirname(fileURLToPath(import.meta.url));
const src = resolve(here, "../../src");

export default defineConfig({
  plugins: [rewriteRendererSpecifiers()],
  entry: [
    `${src}/components/WorkspaceFileMode.tsx`,
    `${src}/context/core-env-context.ts`,
    // The panel owns the `workspace` surface; mounting it without a scope leaves every key inert.
    `${src}/context/input-scope-context.ts`,
    `${src}/hooks/use-workspace-panel.ts`,
    `${src}/hooks/use-workspace-git.ts`,
    `${src}/hooks/use-size.ts`,
    `${src}/utils/workspace-git-paths.ts`,
  ],
  outDir: resolve(here, "dist"),
  format: ["esm"],
  dts: false,
  clean: true,
  shims: true,
  deps: {
    neverBundle: [
      ...RENDERER_EXTERNAL,
      ...TYPES_EXTERNAL,
      "@codent/core",
      "chalk",
      "lodash-es",
      "diff",
      "@m234/nerd-fonts",
    ],
    alwaysBundle: ["ink-stream-markdown"],
  },
});
