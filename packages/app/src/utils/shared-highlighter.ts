/**
 * App-side access to the shared Shiki highlighter.
 *
 * Hosts await `initHighlighter()` before mounting the UI, so by the time a diff/code view renders
 * the instance is already available. Keep a synchronous reference here so those views can build
 * their adapter on the first render instead of rendering once with the lowlight fallback and
 * re-rendering when the async getter resolves.
 */

import {
  ensureLanguage,
  getHighlighter as getSharedHighlighter,
  initHighlighter as initSharedHighlighter,
  type Highlighter,
  type InitHighlighterOptions,
} from "ink-stream-markdown";

import { COMMON_HIGHLIGHT_LANGUAGES } from "./highlight-languages.js";

let current: Highlighter | undefined;
let ready: Promise<void> | undefined;

/** The shared instance once `initHighlighter()` has completed, otherwise `undefined`. */
export function getHighlighterSync(): Highlighter | undefined {
  return current;
}

/**
 * Initialize the shared engine and the language/theme set `DiffView` needs synchronously.
 *
 * `initHighlighter` is a singleton: if a host already initialized a different set, this only
 * fills in the diff/code-view languages and the light theme.
 */
export function initHighlighter(options?: InitHighlighterOptions): Promise<void> {
  ready ??= (async () => {
    await initSharedHighlighter({ preload: COMMON_HIGHLIGHT_LANGUAGES, ...options });
    const highlighter = await getSharedHighlighter();

    // The terminal markdown pipeline only uses github-dark; DiffView wants both themes.
    if (!highlighter.getLoadedThemes().includes("github-light")) {
      await highlighter.loadTheme("github-light");
    }
    for (const language of COMMON_HIGHLIGHT_LANGUAGES) {
      if (!highlighter.getLoadedLanguages().includes(language)) {
        await ensureLanguage(language);
      }
    }

    current = highlighter;
  })();
  return ready;
}

/** Resolve the shared instance, initializing it first if a host has not done so. */
export async function getHighlighter(): Promise<Highlighter> {
  await initHighlighter();
  return current!;
}

export { ensureLanguage };
export type { Highlighter, InitHighlighterOptions };
