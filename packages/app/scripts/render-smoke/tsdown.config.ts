/**
 * Bundles the app's source entrypoints for the headless render smoke, so the smoke can
 * mount the real `MessageList` / `Content` (mixed .ts/.tsx, not part of `dist`) while
 * sharing ONE module instance with the stores they read.
 *
 * Run through `pnpm --filter @codent/app run validate:render-smoke`.
 */
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "tsdown";

import { RENDERER_EXTERNAL, rewriteRendererSpecifiers, TYPES_EXTERNAL } from "../../tsdown.shared.ts";

const here = dirname(fileURLToPath(import.meta.url));
const src = resolve(here, "../../src");

export default defineConfig({
  // The same renderer rewrite the two package builds apply. Without it this bundle keeps the
  // bare `ink` / `react` specifiers that `src` writes, and Node resolves neither: the app has
  // no `ink` dependency to resolve (its package.json points that name at the fork), and the
  // bare names only ever resolved in-repo through the pnpm aliases `f8a7c83` removed.
  //
  // The failure mode is why this matters: an unresolvable specifier kills the smoke at IMPORT
  // time, so it reports `ERR_MODULE_NOT_FOUND` instead of a bad frame, and every frame
  // assertion in the file goes unreported. A broken harness reads as "a check failed".
  plugins: [rewriteRendererSpecifiers()],
  entry: [
    `${src}/messages/MessageView.tsx`,
    // Mounted directly by the smoke to pin the compact summary's fold window.
    `${src}/messages/CompactionSummaryView.tsx`,
    `${src}/components/MessageList.tsx`,
    // Mounted directly to pin that the exit summary sits BELOW the footer behind its own
    // top border — the layout the user asked for, which nothing else renders.
    `${src}/components/ExitSummary.tsx`,
    // Mounted to pin the task list's cursor memory across a list↔detail round-trip.
    `${src}/components/SubagentPanel.tsx`,
    // Mounted to pin that the resume picker scrolls its window to follow the cursor instead of
    // slicing the first N rows and letting the cursor walk off the rendered set.
    `${src}/components/SessionPicker.tsx`,
    `${src}/components/WorkspaceModeHeader.tsx`,
    // Mounted to pin the image preview's zoom/pan wiring: the component must ask the HOST for a
    // source window (not render bigger and crop), and the window it asks for has to match the pane.
    `${src}/components/WorkspaceImagePreview.tsx`,
    `${src}/context/core-env-context.ts`,
    // The zoom state lives in the panel store because the keys and the drawing are in different
    // components; the smoke drives the same store the keys write to.
    `${src}/hooks/use-workspace-panel.ts`,
    // The keybinding context type the chat's handlers are built from.
    // The surface input hooks and their scope: the smoke mounts probes through the real primitive
    // to assert that a screen's keystroke reaches only that screen's handlers.
    // Mounted to pin that the first-run wizard's keys only work inside a scope.
    `${src}/components/ConfigEditor.tsx`,
    `${src}/hooks/input/index.ts`,
    `${src}/context/input-scope-context.ts`,
    `${src}/hooks/use-config.ts`,
    `${src}/hooks/use-subagent-panel.ts`,
    // The smoke wraps the compact-summary fixture in this provider, so the view it mounts is
    // the finished checkpoint rather than the live summary `MessageViewWithCompact` injects.
    `${src}/context/static-context.ts`,
    `${src}/layout/Content.tsx`,
    `${src}/layout/Header.tsx`,
    `${src}/layout/WelcomePanel.tsx`,
    `${src}/hooks/use-static.ts`,
    `${src}/hooks/use-static-heights.ts`,
    `${src}/hooks/use-agent.ts`,
    `${src}/hooks/use-flatten-cache-cleanup.ts`,
    `${src}/hooks/use-dynamic.ts`,
    `${src}/hooks/use-diff-renderer.ts`,
    `${src}/hooks/use-size.ts`,
    `${src}/hooks/use-agent-status.ts`,
    `${src}/hooks/use-workspace-info.ts`,
    `${src}/hooks/use-theme.ts`,
    `${src}/hooks/use-transcript-display.ts`,
    `${src}/utils/get-messages.ts`,
    `${src}/utils/message-flat-cache.ts`,
    `${src}/utils/project-transcript.ts`,
    // Pure formatter for the task row's turn readout, so the smoke can pin the
    // string without mounting the whole tool row.
    `${src}/messages/task-turns.ts`,
    `${src}/hooks/use-tool-elapsed.ts`,
  ],
  outDir: resolve(here, "dist"),
  format: ["esm"],
  dts: false,
  clean: true,
  shims: true,
  deps: {
    neverBundle: [
      // The rewritten renderer names, not the bare ones this config used to list. The plugin
      // above rewrites `react` / `ink` to these, so listing the bare spellings would leave the
      // real specifiers free to be inlined — and an inlined renderer would be a SECOND copy,
      // which is the two-hooks-dispatchers bug this repo keeps re-learning.
      ...RENDERER_EXTERNAL,
      ...TYPES_EXTERNAL,
      "@codent/core",
      "chalk",
      "lodash-es",
      "diff",
      "@m234/nerd-fonts",
    ],
    // `ink-stream-markdown` is deliberately NOT in the list above, unlike in the package
    // builds. It imports the bare `react` / `ink` names itself, so leaving it external means
    // Node runs a SECOND module — its own copy, resolved through pnpm's `react@19.2.8` /
    // `ink@7.1.0` peers — and two Reacts is exactly the dispatcher mismatch that shows up as
    // `Cannot read properties of null (reading 'useMemo')`. Inlined, its imports go through
    // the rewrite plugin above like any other and one renderer survives. A real host does the
    // same thing for the same reason (`@codent/cli` inlines it too).
    alwaysBundle: ["ink-stream-markdown"],
  },
});
