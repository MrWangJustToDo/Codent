/**
 * Shiki highlighter for `@git-diff-view` (DiffView / CodeView).
 *
 * `@git-diff-view/*` ships a lowlight highlighter. The terminal renderer already runs a Shiki
 * highlighter (through `ink-stream-markdown`), so reusing that instance gives the diff/code views
 * TextMate-quality tokens without creating a second highlighter engine — and without the
 * `@git-diff-view/shiki` package's own shiki 3 dependency.
 *
 * The contract is the official shiki adapter's: `getAST` returns a HAST tree produced with both
 * themes and CSS variables, and `processAST` (from `@git-diff-view/lowlight`) turns that tree into
 * the per-line syntax objects the view renders.
 */

import { processAST } from "@git-diff-view/lowlight";

import { getHighlighter, getHighlighterSync, initHighlighter } from "./shared-highlighter.js";

import type { Highlighter } from "./shared-highlighter.js";
import type { DiffAST, DiffHighlighter } from "@git-diff-view/lowlight";

/** The highlighter surface `DiffView` / `CodeView` accept (`getHighlighterEngine` is omitted). */
export type DiffViewHighlighter = Omit<DiffHighlighter, "getHighlighterEngine">;

/** The full adapter also exposes the engine for callers that want it. */
type DiffHighlighterAdapter = DiffViewHighlighter & { getHighlighterEngine: () => unknown };

/** File-extension / diff-view language aliases → Shiki language ids. */
const LANG_ALIASES: Record<string, string> = {
  "c#": "csharp",
  "c++": "cpp",
  bat: "batch",
  cmd: "batch",
  docker: "dockerfile",
  js: "javascript",
  make: "makefile",
  plaintext: "text",
  sh: "bash",
  shell: "bash",
  ts: "typescript",
  txt: "text",
  "vue-html": "vue",
  zsh: "bash",
};

function normalizeLang(lang: string | undefined): string {
  const value = (lang ?? "").trim().toLowerCase();
  return LANG_ALIASES[value] ?? value;
}

function createHighlighterAdapter(provider: Highlighter): DiffHighlighterAdapter {
  const hasLanguage = (language: string): boolean =>
    language === "text" || provider.getLoadedLanguages().includes(language);

  let maxLineToIgnoreSyntax = 2000;
  const ignoreSyntaxHighlightList: (string | RegExp)[] = [];

  return {
    name: "shiki",
    type: "class",
    get maxLineToIgnoreSyntax() {
      return maxLineToIgnoreSyntax;
    },
    setMaxLineToIgnoreSyntax: (value: number) => {
      maxLineToIgnoreSyntax = value;
    },
    get ignoreSyntaxHighlightList() {
      return ignoreSyntaxHighlightList;
    },
    setIgnoreSyntaxHighlightList: (value: (string | RegExp)[]) => {
      ignoreSyntaxHighlightList.length = 0;
      ignoreSyntaxHighlightList.push(...value);
    },
    getAST: ((raw: string, fileName?: string, lang?: string) => {
      if (
        fileName &&
        ignoreSyntaxHighlightList.some((item) => (item instanceof RegExp ? item.test(fileName) : fileName === item))
      ) {
        return undefined;
      }

      const language = normalizeLang(lang);
      try {
        return provider.codeToHast(raw, {
          // Unknown extensions must not throw (and must not lose the line structure): Shiki's
          // `text` grammar still emits one token per line.
          lang: hasLanguage(language) ? language : "text",
          themes: { dark: "github-dark", light: "github-light" },
          cssVariablePrefix: "--diff-view-",
          defaultColor: false,
          mergeWhitespaces: false,
        }) as unknown as DiffAST;
      } catch {
        // The view falls back to unhighlighted text for this row.
        return undefined;
      }
    }) as DiffHighlighter["getAST"],
    processAST,
    hasRegisteredCurrentLang: (lang: string) => hasLanguage(normalizeLang(lang)),
    getHighlighterEngine: () => provider,
  };
}

let adapter: DiffHighlighterAdapter | undefined;
let adapterPromise: Promise<DiffHighlighterAdapter> | undefined;

function adapterFor(provider: Highlighter): DiffHighlighterAdapter {
  adapter ??= createHighlighterAdapter(provider);
  return adapter;
}

/**
 * Build the adapter synchronously when the host has already initialized the shared engine.
 *
 * Hosts await `initHighlighter()` before mounting, so this is the normal path. Returning
 * `undefined` is the fallback for callers that render before initialization; `useDiffHighlighter`
 * then loads the adapter asynchronously.
 */
export function getDiffViewHighlighterSync(): DiffHighlighterAdapter | undefined {
  const provider = getHighlighterSync();
  if (!provider || !provider.getLoadedThemes().includes("github-light")) return undefined;
  return adapterFor(provider);
}

/** Load the singleton Shiki adapter. Errors are left to the caller so a diff can degrade to text. */
export function loadDiffViewHighlighter(): Promise<DiffHighlighterAdapter> {
  const current = getDiffViewHighlighterSync();
  if (current) return Promise.resolve(current);

  adapterPromise ??= (async () => {
    await initHighlighter();
    return adapterFor(await getHighlighter());
  })();
  return adapterPromise;
}
