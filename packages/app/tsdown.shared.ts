/**
 * Inputs shared by the two `@codent/app` build configurations.
 *
 * There are two builds, and the difference between them is *only* dependency handling:
 *
 *   `tsdown.config.ts`         — default (`pnpm build`). Dependencies stay external.
 *   `tsdown.config.release.ts` — release (`pnpm build:release`). Dependencies are inlined.
 *
 * The default build is the one every host in this repo consumes (playground, extension,
 * cli, codent), so it is deliberately the cheap one: a dependency is built once, by whoever
 * owns it, instead of being inlined here and then bundled *again* by each host that inlines
 * `@codent/app`. Two consequences that are easy to lose sight of:
 *
 *   - **Correctness, not just size.** A host bundler resolving `reactivity-store` picks its
 *     ESM entry (`module` field) and applies its own browser aliases. A copy that was
 *     pre-inlined here is already frozen in whatever form this build chose — on a Node
 *     platform target that is the CJS entry, whose `require("react")` cannot exist in a
 *     browser. That is the shape of the regression this split fixes.
 *   - **One renderer instance.** React must resolve to a single `@my-react/react`. The
 *     rewrite below makes that true under its *real* package name, which is what a host then
 *     externalises; see the npm-vs-pnpm alias post-mortem in `tsdown.config.ts`.
 *
 * Only `tsdown.config` + a known extension is auto-discovered, so this file is never
 * mistaken for a config entry point.
 *
 * The importers deliberately spell this import with a `.ts` extension. tsdown loads its own
 * config through Node's native TypeScript support, which does **not** apply the repo's
 * `.js`-for-`.ts` ESM convention — `"./tsdown.shared.js"` fails to resolve at load time.
 */

/**
 * The published graph must not contain the bare names `react` / `ink`.
 *
 * Our package.json points those names at @my-react/react / @my-react/react-terminal, but npm
 * does NOT dedupe an alias against the real name: a consumer ends up with two physical copies
 * of the renderer (`node_modules/@codent/app/node_modules/react` AND
 * `@my-react/react`), hence two hook dispatchers, and React silently renders nothing. pnpm
 * dedupes them — which is exactly why the repo always looked fine and only published installs
 * blanked.
 *
 * Rewritten at RESOLVE time instead of with `alias`, because `alias` also redirects TYPES:
 * `import { ReactNode } from "react"` must keep resolving to @types/react, while the runtime
 * must resolve to @my-react/react.
 */
export const RENDERER_SPECIFIERS: Record<string, string> = {
  react: "@my-react/react",
  "react/jsx-runtime": "@my-react/react/jsx-runtime",
  "react/jsx-dev-runtime": "@my-react/react/jsx-dev-runtime",
  ink: "@my-react/react-terminal",
};

/** Rewrites the bare renderer specifiers to their real package names (as externals). */
export const rewriteRendererSpecifiers = () => ({
  name: "rewrite-renderer-specifiers",
  resolveId(source: string) {
    const real = RENDERER_SPECIFIERS[source];
    return real ? { id: real, external: true } : null;
  },
});

/** The single-copy renderer, under the names the plugin above rewrote the specifiers to. */
export const RENDERER_EXTERNAL = [
  "@my-react/react-terminal",
  "@my-react/react",
  "@my-react/react/jsx-runtime",
  "@my-react/react/jsx-dev-runtime",
];

/**
 * Must stay external in both builds: `@git-diff-view/lowlight` imports the `LanguageFn` TYPE
 * from here, and the DTS pass resolves `highlight.js/types/index.d.ts`, which does not export
 * it. Keeping the package external leaves a bare reference in the .d.mts instead of trying to
 * inline a type that cannot be resolved. The RUNTIME highlighter is `lowlight`; this is a
 * type-only edge.
 */
export const TYPES_EXTERNAL = ["highlight.js"];

/** The logic layer: shared with the server and the other hosts, and not ours to inline. */
export const CORE_EXTERNAL = ["@codent/core"];

/**
 * Data / formatting / diff dependencies.
 *
 * Listed explicitly because they are `devDependencies` here: tsdown only auto-externalises
 * production dependencies, so without this a default build would inline them anyway.
 *
 * `@git-diff-view/*` belongs on this list despite its unsatisfiable
 * `peerDependencies: { react: "^19.2.0", ink: "^6.1.0" }`. That peer range is only unsafe for
 * a consumer resolving the package by *bare name* with no alias — which is why the release
 * build bundles it. Every in-repo host aliases `react` / `ink` to the fork, so leaving it
 * external defers to the host that can actually satisfy it.
 */
export const RUNTIME_DEPENDENCIES: Array<string | RegExp> = [
  /^@git-diff-view\//,
  "reactivity-store",
  "ink-stream-markdown",
  "chalk",
  "diff",
  "lodash-es",
  "@m234/nerd-fonts",
];

/** Emitted as one file per entry, so a host can pull a single helper without the whole UI. */
export const ENTRIES = [
  "src/index.ts",
  "src/utils/lite-diff.ts",
  "src/utils/lite-diff-highlight.ts",
  "src/utils/input-feedback-queue.ts",
  "src/utils/workspace-scroll.ts",
  "src/utils/workspace-path.ts",
  "src/utils/workspace-git-diff.ts",
  "src/utils/workspace-git-info.ts",
  "src/utils/workspace-git-status.ts",
  "src/utils/workspace-git-paths.ts",
  "src/utils/workspace-diff-stats.ts",
  "src/utils/workspace-diff-tree.ts",
  "src/utils/workspace-file-search.ts",
  "src/utils/workspace-reveal.ts",
  "src/utils/streaming-output-lines.ts",
  "src/utils/format-usage.ts",
  "src/utils/exit-summary.ts",
  "src/utils/exit-with-summary.ts",
  "src/utils/usage-heatmap.ts",
  "src/utils/file-icons.ts",
  "src/utils/tool-activity-summary.ts",
  "src/utils/project-transcript.ts",
  "src/utils/queue-preview.ts",
  "src/utils/keyboard-labels.ts",
  "src/utils/user-message-segments.ts",
  "src/utils/attachment-hash.ts",
  "src/utils/apply-app-config.ts",
  "src/utils/merge-tool-config.ts",
  "src/utils/get-messages.ts",
  "src/utils/user-input-helpers.ts",

  "src/utils/streaming-ingest.ts",

  // Emitted for the test suite (`test/workspace-scroll.test.mjs`), which drives the tree
  // window's reset-on-mode-switch through the real store.
  "src/hooks/use-workspace-view.ts",
];
