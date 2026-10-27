/**
 * Split a leading YAML frontmatter block from a markdown document.
 *
 * One definition for the two document loaders (`skills/skill-loader.ts`,
 * `memory/memory-manager.ts`), which each carried the same delimiter scan and had already started
 * to disagree on the failure shapes. Schema validation stays with each loader — this only owns
 * "where does the YAML end and the body begin".
 *
 * A document without a leading `---` or without a closing `\n---` has no frontmatter (`null`);
 * callers keep their own fallback body in that case.
 */
export interface FrontmatterSplit {
  /** YAML text between the delimiters, trimmed. */
  yaml: string;
  /** Everything after the closing delimiter, trimmed. */
  body: string;
}

export function splitFrontmatter(text: string): FrontmatterSplit | null {
  if (!text.startsWith("---")) return null;
  const endIndex = text.indexOf("\n---", 3);
  if (endIndex === -1) return null;
  return { yaml: text.slice(4, endIndex).trim(), body: text.slice(endIndex + 4).trim() };
}
