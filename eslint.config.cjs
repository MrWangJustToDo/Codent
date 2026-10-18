const baseLint = require("project-tool/baseLint");
const reactLint = require("project-tool/reactLint");

module.exports = [
  ...baseLint,
  {
    ignores: [
      "dist",
      "dev",
      "scripts",
      "node_modules",
      ".pnpm-store",
      ".output",
      ".wxt",
      "**/.wxt",
      "eslint.config.cjs",
      "tmp",
      // Per-package scratch (e.g. a probe script under `packages/server/tmp/`). Bare "tmp" only matches
      // the repo root, so a gitignored probe inside a package was linted here while CI — a fresh clone
      // without it — stayed green. Keep the local gate equal to the CI gate.
      "**/tmp/**",
      "examples/extensions/**",
      ".agents/**",
    ],
  },
  // ── Build state is a lint/typecheck prerequisite ───────────────────────────
  // Both resolvers below are still asked about specifiers this config cannot
  // see through, so lint (and `pnpm typecheck`) only pass against a *built*
  // checkout. ~280 `import/no-unresolved` errors show up with every `dist/`
  // removed:
  //
  //   1. Relative `../dist/...` imports — ~190 in the `validate:*` / test /
  //      render-smoke scripts, which import their own package's build output.
  //      Each is paired with a `build &&` prefix in its package.json script;
  //      the rule cannot follow a path into a gitignored directory. The
  //      per-directory `import/no-unresolved: "off"` blocks below cover those
  //      script trees, including the `../dist/utils/*` entry-point imports in
  //      packages/app/test.
  //   2. Bare workspace specifiers (`@codent/core`, `@codent/server/client`, …)
  //      — the TS resolver follows `exports` → `./dist/index.mjs`, and the
  //      node resolver never reaches the package at all, so `alwaysTryTypes`
  //      alone does not save a dist-less tree. ~86 of these, spread across
  //      package `src/`, the extension's non-`src/` TS files, the scripts and
  //      the root host entry points.
  //
  // Turning the rule off repo-wide would buy a green clean-checkout lint at the
  // cost of the one thing it is for — catching a genuinely misspelled relative
  // import or a path that points at a file that no longer exists. CI therefore
  // builds first (see .github/workflows/ci.yml); locally, run `pnpm build`
  // before `pnpm lint` in a fresh clone.
  {
    settings: {
      "import/resolver": {
        typescript: {
          alwaysTryTypes: true,
          project: [
            "./tsconfig.json",
            "./packages/core/tsconfig.json",
            "./packages/app/tsconfig.json",
            "./packages/acp/tsconfig.json",
            "./packages/cli/tsconfig.json",
            "./packages/codent/tsconfig.json",
            "./packages/node/tsconfig.json",
            "./packages/server/tsconfig.json",
            "./packages/extension/tsconfig.json",
            "./packages/mcp-server/tsconfig.json",
          ],
        },
      },
    },
  },
  {
    // Deliberate loosening of the shared 400-line default (`project-tool/…/base.ts`). The design
    // guideline stays 400 (`.cursor/rules/040`, `AGENTS.md`); this is the enforced ceiling, and
    // the two numbers are documented together so the gap cannot read as a silent override. A
    // file that needs 800 should justify itself in its header — see the barrel of candidates in
    // `AGENTS.md` "File size".
    rules: {
      "max-lines": ["error", { max: 800, skipBlankLines: true }],
    },
  },
  // React config for app, cli, and extension packages
  {
    files: [
      "packages/app/src/**/*.{ts,tsx}",
      "packages/cli/src/**/*.{ts,tsx}",
      "packages/codent/src/**/*.{ts,tsx}",
      "packages/extension/**/*.{ts,tsx}",
    ],
    ...reactLint.reduce((acc, config) => {
      return {
        ...acc,
        ...config,
        plugins: { ...acc.plugins, ...config.plugins },
        rules: { ...acc.rules, ...config.rules },
        settings: { ...acc.settings, ...config.settings },
      };
    }, {}),
    languageOptions: {
      parserOptions: {
        ecmaFeatures: {
          jsx: true,
        },
        projectService: true,
        tsconfigRootDir: __dirname,
      },
    },
  },
  // Node.js test files and validation scripts use console/setTimeout from node environment
  {
    files: [
      "packages/app/test/**",
      "packages/app/scripts/**",
      "packages/acp/scripts/**",
      "packages/codent/scripts/**",
      "packages/core/scripts/**",
      "packages/node/scripts/**",
      "packages/server/scripts/**",
    ],
    languageOptions: {
      globals: {
        console: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        setInterval: "readonly",
        clearInterval: "readonly",
        URL: "readonly",
        process: "readonly",
        Buffer: "readonly",
        Response: "readonly",
        AbortController: "readonly",
        AbortSignal: "readonly",
      },
    },
    // Every script in these trees imports its own package's build output
    // (`../dist/dev.mjs`, `../dist/index.mjs`, `../dist/utils/*.mjs`, …), and
    // each is paired with a `build &&` prefix in its package.json script. The
    // rule cannot follow a path into a gitignored directory, and the `index.mjs`
    // segment ESM requires is itself enough to trip
    // `import/no-useless-path-segments`, so both are off here. This covers the
    // render-smoke bundle too (`packages/app/scripts/render-smoke/**`).
    rules: {
      "import/no-useless-path-segments": "off",
      "import/no-unresolved": "off",
    },
  },
  // `devtool/load.ts` dynamically imports this same directory, which resolves
  // to the gitignored `devtool/index.js` that `init.mjs` downloads during the
  // extension's `postinstall` (`wxt prepare && node init.mjs`). The file is
  // absent on a fresh checkout and in CI, where install runs with
  // `--ignore-scripts`, so the rule can never resolve it there.
  {
    files: ["packages/extension/devtool/load.ts"],
    rules: {
      "import/no-unresolved": "off",
    },
  },
  // Relax rules for packages/app — uses reactivity-store patterns where:
  // - getActions() returns stable refs (exhaustive-deps false positives)
  // - refs are read during render for perf optimization
  // - async setState in effects is the intended pattern for initialization
  {
    files: ["packages/app/src/**/*.{ts,tsx}"],
    rules: {
      "react-hooks/exhaustive-deps": "warn",
      "react-hooks/refs": "off",
      "react-hooks/set-state-in-effect": "off",
    },
  },
  // Extension components also use async bootstrap patterns in effects
  {
    files: ["packages/extension/**/*.{ts,tsx}"],
    rules: {
      "react-hooks/set-state-in-effect": "off",
    },
  },
];
