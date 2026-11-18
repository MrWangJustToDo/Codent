import { defineConfig } from "tsdown";

// ============================================================================
// Fully bundled release build
// ============================================================================
//
// `codent` is published as ONE self-contained tarball: `@codent/app`,
// `@codent/core`, `@codent/node` and every pure-JS third-party dependency
// are inlined into `dist`, so the published package declares no runtime
// `dependencies` at all and no `@codent/*` sibling has to be on the registry.
//
// Two groups must stay external and are the only things a consumer installs:
//
//   1. Renderer — `@my-react/react` + `@my-react/react-terminal`. The host must
//      resolve ONE copy; two physical copies means two hook dispatchers and the
//      TUI renders nothing. See `packages/app/tsdown.config.ts` for the full
//      npm-vs-pnpm alias post-mortem.
//   2. Asset-bearing packages — they read their own assets through
//      `import.meta.url` / `require.resolve`, which only works while they keep
//      their real on-disk layout:
//        - `@anthropic-ai/sandbox-runtime` → `vendor/seccomp/*/apply-seccomp`,
//          `vendor/srt-win/*`, `vendor/java-proxy-agent/*.jar`
//        - `web-tree-sitter` → `tree-sitter.wasm`
//        - `sharp` → its `@img/sharp-*` prebuilt binding, found by path
//        - `isolated-vm` → its `prebuilds/<platform>/` addon, found by path
//        - `@jitsi/robotjs` → its `prebuilds/<platform>/` addon, required at call
//          time by the computer-use driver
//
//      Those three ship as `optionalDependencies` rather than `dependencies`.
//      A native addon cannot be inlined — the binary is not JS — and inlining
//      its loader is worse than leaving it out: the loader resolves relative to
//      itself, so an inlined copy looks for `prebuilds/` next to *our* `dist`
//      and dies with "No native build was found". Declaring them optional keeps
//      the install succeeding where no prebuilt binding exists (npm skips an
//      optional dependency it cannot build) and the call site degrades to
//      `null` instead. See `ALLOWED_OPTIONAL_EXTERNALS` in
//      `scripts/validate-self-contained.mjs`.
//
// `unpdf` (core's PDF text extractor) is deliberately NOT here: bundling it was
// verified to work. Its `import.meta.url` references are dead fallbacks behind
// `process.getBuiltinModule`, and its canvas proxy is lazy, so nothing reads a
// file next to the module — which also drops a 72 KB package from the install.

/** Bare renderer specifiers are rewritten to their real package names at resolve time. */
const RENDERER_SPECIFIERS: Record<string, string> = {
  react: "@my-react/react",
  "react/jsx-runtime": "@my-react/react/jsx-runtime",
  "react/jsx-dev-runtime": "@my-react/react/jsx-dev-runtime",
  ink: "@my-react/react-terminal",
};

const rewriteRendererSpecifiers = () => ({
  name: "rewrite-renderer-specifiers",
  resolveId(source: string) {
    const real = RENDERER_SPECIFIERS[source];
    return real ? { id: real, external: true } : null;
  },
});

export default defineConfig({
  entry: ["src/index.tsx"],
  format: ["esm"],
  platform: "node",
  dts: true,
  clean: true,
  shims: true,
  // Source maps are ~2.5x the bundle size and the app layer ships hundreds of
  // dynamically imported shiki language chunks, so a tarball with maps is
  // dominated by them. Keep the beta small; flip to `true` if stack traces in
  // the published package ever matter more than install size.
  sourcemap: false,
  plugins: [rewriteRendererSpecifiers()],
  deps: {
    // Everything that reads its own assets, plus the single-copy renderer.
    // (Listed under the REWRITTEN names — the plugin above has already replaced
    // the bare `react` / `ink` specifiers by the time this runs.)
    neverBundle: [
      "@my-react/react",
      "@my-react/react/jsx-runtime",
      "@my-react/react/jsx-dev-runtime",
      "@my-react/react-terminal",
      "@anthropic-ai/sandbox-runtime",
      "web-tree-sitter",
      // Native addons: inlining the loader breaks it (see the header note).
      // `sharp` is reached by `resizeImage`'s dynamic `import("sharp")`; the
      // `isolated-vm` entry is what `@tanstack/ai-isolate-node` (inlined)
      // resolves by path once its JS is bundled; `@jitsi/robotjs` is required
      // at call time by `@codent/node`'s `createNodeComputer`, whose N-API
      // prebuilds must stay in a real on-disk layout.
      "sharp",
      "isolated-vm",
      "@jitsi/robotjs",
    ],
    // The app / core / node layers are inlined on purpose, including their
    // dynamic `import()`s (PDF extraction, clipboard, …): those are lazy loads,
    // not optional installs, so they must ship inside the bundle rather than
    // resolve from node_modules. Native addons are the exception — they are the
    // `neverBundle` entries above.
    alwaysBundle: [/^@codent\//, /.*/],
  },
});
