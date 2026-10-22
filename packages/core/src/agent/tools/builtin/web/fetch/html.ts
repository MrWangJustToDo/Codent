/**
 * HTML conversion helpers for webfetch.
 */

import * as htmlparser2 from "htmlparser2";
import TurndownService from "turndown";

/**
 * Convert HTML to Markdown using Turndown.
 */
export function convertHTMLToMarkdown(html: string): string {
  const turndownService = new TurndownService({
    headingStyle: "atx",
    hr: "---",
    bulletListMarker: "-",
    codeBlockStyle: "fenced",
    emDelimiter: "*",
  });

  turndownService.remove(["script", "style", "meta", "link", "noscript"]);
  return turndownService.turndown(html);
}

/**
 * Extract the document `<title>` text (entity-decoded), or "" when absent.
 */
export function extractHtmlTitle(html: string): string {
  const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  if (!match?.[1]) return "";
  return decodeHtmlEntities(match[1].replace(/\s+/g, " ").trim());
}

/** Decode the handful of HTML entities that show up in titles/headings. */
export function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0*39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
}

/**
 * Extract plain text from HTML using htmlparser2.
 *
 * - Strips script/style/noscript/iframe/object/embed/svg/canvas/math
 * - Preserves newlines from block-level elements
 * - Emits fenced code blocks for &lt;pre&gt; content
 */
export function extractTextFromHTML(html: string): string {
  const lines: string[] = [];
  let currentLine = "";
  let inSkippedTag = false;
  let inCodeBlock = false;
  let codeLanguage = "";
  let codeContent = "";
  let skipDepth = 0;

  const blockTags = new Set([
    "p",
    "div",
    "br",
    "hr",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "li",
    "tr",
    "td",
    "th",
    "dd",
    "dt",
    "ol",
    "ul",
    "section",
    "article",
    "nav",
    "header",
    "footer",
    "main",
    "aside",
    "blockquote",
    "details",
    "summary",
    "figure",
    "figcaption",
  ]);

  const skipTags = new Set(["script", "style", "noscript", "iframe", "object", "embed", "svg", "canvas", "math"]);

  const parser = new htmlparser2.Parser({
    onopentag(name) {
      const tag = name.toLowerCase();

      if (skipTags.has(tag)) {
        inSkippedTag = true;
        skipDepth++;
        return;
      }

      if (tag === "pre") {
        inCodeBlock = true;
        codeContent = "";
        codeLanguage = "";
        return;
      }

      if (tag === "code" && !inCodeBlock) {
        return;
      }

      if (blockTags.has(tag)) {
        flushLine();
      }
    },

    onattribute(name, value) {
      if (inCodeBlock && name === "class") {
        const match = value.match(/language-(\w+)/);
        if (match) {
          codeLanguage = match[1];
        }
      }
    },

    ontext(text) {
      if (inSkippedTag) return;

      if (inCodeBlock) {
        codeContent += text;
        return;
      }

      currentLine += text;
    },

    onclosetag(name) {
      const tag = name.toLowerCase();

      if (skipTags.has(tag)) {
        skipDepth--;
        if (skipDepth <= 0) {
          inSkippedTag = false;
          skipDepth = 0;
        }
        return;
      }

      if (tag === "pre" && inCodeBlock) {
        inCodeBlock = false;
        const lang = codeLanguage ? codeLanguage : "";
        if (codeContent.trim()) {
          lines.push("```" + lang);
          const codeLines = codeContent.split("\n");
          const trimmed = codeLines.map((l) => l.trimEnd());
          lines.push(...trimmed);
          lines.push("```");
          lines.push("");
        }
        codeContent = "";
        codeLanguage = "";
        return;
      }

      if (blockTags.has(tag)) {
        flushLine();
      }

      if (tag === "p" || tag === "li" || tag === "th" || tag === "td") {
        currentLine += " ";
      }
    },
  });

  parser.write(html);
  parser.end();
  flushLine();

  return lines
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join("\n");

  function flushLine() {
    const trimmed = currentLine.trim();
    if (trimmed) {
      lines.push(trimmed);
    }
    currentLine = "";
  }
}
