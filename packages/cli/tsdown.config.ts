import { defineConfig } from "tsdown";

// Same resolve-time rewrite as @codent/app: the published graph must not contain the bare
// names `react` / `ink`, because npm does not dedupe an alias against the real package name
// and the consumer then gets two physical copies of the renderer (two hook dispatchers → the
// TUI renders nothing). See the note in packages/app/tsdown.config.ts for the measurements.
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
  // Three entries: `index.tsx` is the bin (injects @codent/server factories);
  // `host.tsx` is the server-free library entry the self-contained release host
  // (`codent-cli`) imports so it can inline the shared host logic without
  // pulling in @codent/server; `args.ts` is emitted for `scripts/validate-cli-args.mjs`
  // (the parser has no other owner-visible surface, and it is the seam that used to
  // drop `--sandbox=native` silently).
  entry: ["src/index.tsx", "src/host.tsx", "src/args.ts"],
  format: ["esm"],
  dts: true,
  clean: true,
  shims: true,
  plugins: [rewriteRendererSpecifiers()],
  deps: {
    // The logic layer and the rendering primitives stay real dependencies, named directly:
    // core owns the agent loop and is shared with the server, and the renderer must resolve to
    // ONE copy in the host process. @codent/acp is the ACP host the bin serves over stdio.
    neverBundle: [
      "@codent/core",
      "@codent/node",
      "@codent/server",
      "@codent/acp",
      "@my-react/react",
      "@my-react/react/jsx-runtime",
      "@my-react/react/jsx-dev-runtime",
      "@my-react/react-terminal",
    ],
    alwaysBundle: ["@codent/app"],
  },
});
