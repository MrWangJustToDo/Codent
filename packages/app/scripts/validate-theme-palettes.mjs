/**
 * Theme palette guard.
 *
 * Three assertions, each covering a failure that is invisible at build time:
 *
 * 1. **Key parity** — both palettes export the same COLORS / BG / GRADIENT keys.
 *    `applyColorPalette` copies with `Object.assign`, which only overwrites the keys the incoming
 *    palette has: a key added to one palette alone silently keeps the previous theme's value.
 *
 * 2. **Contrast floors** — every semantic color must be readable on the surfaces it is painted on.
 *    A theme is a set of hex literals, so "looks nice in my terminal" is the only review a color
 *    normally gets; these floors turn that into a check. Values are recomputed from the source
 *    literals (no build needed).
 *
 * 3. **No module-scope palette capture** — palette values must be read at render time. A top-level
 *    `const STATUS_COLORS = { pending: COLORS.muted }` freezes whatever theme was active at import,
 *    so `/settings theme` can never repaint it — exactly how the todo tool kept rendering gemini
 *    colors under the claude theme.
 *
 * Run: pnpm --filter @codent/app run validate:theme-palettes
 */
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const appRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const themeDir = join(appRoot, "src/theme");
const PALETTE_FILES = ["colors-gemini.ts", "colors-claude.ts"];

// ============================================================================
// Color math (mirrors theme/colors.ts's interpolateColor)
// ============================================================================

function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function interpolate(color1, color2, factor) {
  const f = Math.max(0, Math.min(1, factor));
  const [r1, g1, b1] = hexToRgb(color1);
  const [r2, g2, b2] = hexToRgb(color2);
  const to = (n) => Math.round(n).toString(16).padStart(2, "0");
  return `#${to(r1 + (r2 - r1) * f)}${to(g1 + (g2 - g1) * f)}${to(b1 + (b2 - b1) * f)}`;
}

function luminance(hex) {
  const [r, g, b] = hexToRgb(hex).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

// ============================================================================
// Source parsing
// ============================================================================

/** Body of `export const NAME = { ... } as const;` from a palette file. */
function blockOf(source, name, file) {
  const match = source.match(new RegExp(`export const ${name} = \\{([\\s\\S]*?)\\n\\} as const;`));
  assert.ok(match, `missing ${name} in ${file}`);
  return match[1];
}

function hexLiterals(block) {
  const out = new Map();
  for (const m of block.matchAll(/^\s+(\w+):\s*"([^"]+)"/gm)) out.set(m[1], m[2]);
  return out;
}

/** Resolve a BG entry: a literal hex, `COLORS.<key>`, or `interpolateColor(TERMINAL_BG, <base>, f)`. */
function resolveBgEntry(expression, { terminalBg, gray, colors, key, file }) {
  const trimmed = expression.trim();
  if (/^"#[0-9A-Fa-f]{6}"$/.test(trimmed)) return trimmed.slice(1, -1);

  const colorRef = trimmed.match(/^COLORS\.(\w+)$/);
  if (colorRef) return colors.get(colorRef[1]);

  const interp = trimmed.match(/^interpolateColor\(\s*TERMINAL_BG\s*,\s*(GRAY|COLORS\.\w+)\s*,\s*([\d.]+)\s*\)$/);
  if (interp) {
    const base = interp[1] === "GRAY" ? gray : colors.get(interp[1].replace("COLORS.", ""));
    assert.ok(base, `${file}: BG.${key} interpolates over an unknown base (${interp[1]})`);
    return interpolate(terminalBg, base, Number(interp[2]));
  }

  assert.fail(`${file}: BG.${key} has an unrecognised expression — ${trimmed}`);
}

function parsePalette(file) {
  const path = join(themeDir, file);
  const source = readFileSync(path, "utf8");

  const terminalBg = source.match(/const TERMINAL_BG = "(#[0-9A-Fa-f]{6})";/)?.[1];
  const gray = source.match(/const GRAY = "(#[0-9A-Fa-f]{6})";/)?.[1];
  assert.ok(terminalBg, `${file}: missing TERMINAL_BG literal`);
  assert.ok(gray, `${file}: missing GRAY literal`);

  const colors = hexLiterals(blockOf(source, "COLORS", file));
  assert.ok(colors.size >= 7, `${file}: COLORS parsed ${colors.size} entries`);

  const bgBlock = blockOf(source, "BG", file);
  const expressions = new Map();
  for (const line of bgBlock.split("\n")) {
    const m = line.match(/^\s+(\w+):\s*(.+?),?\s*$/);
    // Skip doc-comment continuation lines and nested object syntax.
    if (!m || line.trim().startsWith("*") || line.trim().startsWith("/")) continue;
    expressions.set(m[1], m[2].replace(/,$/, ""));
  }
  const bg = new Map();
  for (const [key, expression] of expressions) {
    bg.set(key, resolveBgEntry(expression, { terminalBg, gray, colors, key, file }));
  }

  const gradientBlock = blockOf(source, "GRADIENT", file);
  const gradient = hexLiterals(gradientBlock);

  return { file, terminalBg, gray, colors, bg, gradient };
}

// ============================================================================
// 1. Key parity
// ============================================================================

const palettes = PALETTE_FILES.map(parsePalette);
const [reference, ...rest] = palettes;
for (const other of rest) {
  for (const section of ["colors", "bg", "gradient"]) {
    assert.deepEqual(
      [...other[section].keys()].sort(),
      [...reference[section].keys()].sort(),
      `${section} keys differ between ${reference.file} and ${other.file} — Object.assign would leave a stale value behind`
    );
  }
}

// ============================================================================
// 2. Contrast floors
// ============================================================================

/** Text on the base background, and on the tool-result panel (where tool rows are painted). */
const TEXT_FLOOR = 4.5;
/** Body text needs headroom above the minimum — it is read for minutes, not glances. */
const BODY_TEXT_FLOOR = 8;
/** A decorative tint has to be visible without becoming a block; below this it is invisible. */
const STROKE_FLOOR = 1.15;
/** Panel fills are meant to read as a faint group, not as a block — a lower floor than a stroke. */
const FILL_FLOOR = 1.1;

/** Colors that are painted on the user-message panel (`BG.message`), not only on the base. */
const ON_MESSAGE_PANEL = ["text", "accent", "muted"];
/** Panel fills: must separate from the base, but only faintly. */
const FILLS = ["input", "message", "toolResult", "diffContext"];
/** Lines and row washes: real strokes, so they need more separation than a fill. */
const STROKES = ["border", "rowCursor", "rowSelected", "diffAdded", "diffRemoved"];

for (const palette of palettes) {
  const { file, terminalBg, colors, bg } = palette;
  const toolResult = bg.get("toolResult");
  const message = bg.get("message");

  for (const [key, hex] of colors) {
    assert.ok(
      contrast(hex, terminalBg) >= TEXT_FLOOR,
      `${file}: COLORS.${key} (${hex}) is ${contrast(hex, terminalBg).toFixed(2)}:1 on the base background — floor ${TEXT_FLOOR}`
    );
    assert.ok(
      contrast(hex, toolResult) >= TEXT_FLOOR,
      `${file}: COLORS.${key} (${hex}) is ${contrast(hex, toolResult).toFixed(2)}:1 on BG.toolResult (${toolResult}) — floor ${TEXT_FLOOR}`
    );
    if (ON_MESSAGE_PANEL.includes(key)) {
      assert.ok(
        contrast(hex, message) >= TEXT_FLOOR,
        `${file}: COLORS.${key} (${hex}) is ${contrast(hex, message).toFixed(2)}:1 on BG.message (${message}) — floor ${TEXT_FLOOR}`
      );
    }
  }

  assert.ok(
    contrast(colors.get("text"), message) >= BODY_TEXT_FLOOR,
    `${file}: COLORS.text is only ${contrast(colors.get("text"), message).toFixed(2)}:1 on BG.message — floor ${BODY_TEXT_FLOOR}`
  );

  for (const [keys, floor] of [
    [FILLS, FILL_FLOOR],
    [STROKES, STROKE_FLOOR],
  ]) {
    for (const key of keys) {
      const hex = bg.get(key);
      if (!hex || hex === colors.get("success") || hex === colors.get("danger")) continue; // state borders reuse a semantic color
      assert.ok(
        contrast(hex, terminalBg) >= floor,
        `${file}: BG.${key} (${hex}) is ${contrast(hex, terminalBg).toFixed(2)}:1 against the base background — below the ${floor} floor, so it is invisible`
      );
    }
  }
}

// ============================================================================
// 3. No module-scope palette capture
// ============================================================================

const SOURCE_ROOT = join(appRoot, "src");
const PALETTE_REFERENCE = /\b(COLORS|BG|GRADIENT)\.[A-Za-z_$]|\b(COLORS|BG|GRADIENT)\[/;

function sourceFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...sourceFiles(path));
    else if (/\.tsx?$/.test(entry)) out.push(path);
  }
  return out;
}

/** The initializer text of a top-level `const NAME… = …` statement, plus its line number. */
function initializerAt(lines, start) {
  const header = lines[start];
  // Walk past the binding name and any type annotation to the `=`, tracking nesting.
  let depth = 0;
  let eq = -1;
  for (let i = header.indexOf("=") >= 0 ? 0 : -1; i >= 0 && i < header.length; i++) {
    const ch = header[i];
    if ("<({[".includes(ch)) depth++;
    else if (">)}]".includes(ch)) depth--;
    else if (ch === "=" && depth === 0) {
      eq = i;
      break;
    }
  }
  if (eq < 0) return null;

  let text = header.slice(eq + 1);
  let index = start;
  let open = 0;
  for (const ch of text) if ("{[(".includes(ch)) open++;
  for (const ch of text) if ("}])".includes(ch)) open--;
  while (open > 0 && index + 1 < lines.length) {
    index++;
    const next = lines[index];
    text += `\n${next}`;
    for (const ch of next) if ("{[(".includes(ch)) open++;
    for (const ch of next) if ("}])".includes(ch)) open--;
  }
  return { text, line: start + 1 };
}

/** A function initializer reads the palette when it runs, which is exactly what we want. */
function isFunctionInitializer(text) {
  const head = text.trimStart();
  return (
    /^(async\s+)?function\b/.test(head) || /^\([^)]*\)\s*(:[^=]*)?=>/.test(head) || /^[A-Za-z_$][\w$]*\s*=>/.test(head)
  );
}

const captures = [];
for (const path of sourceFiles(SOURCE_ROOT)) {
  if (path.startsWith(themeDir)) continue; // the palettes own the literals; the key map there is a `keyof`
  const lines = readFileSync(path, "utf8").split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (!/^(export )?(const|let|var) [A-Za-z_$]/.test(lines[i])) continue;
    const init = initializerAt(lines, i);
    if (!init || isFunctionInitializer(init.text)) continue;
    const head = init.text.trimStart();
    // Only value-shaped initializers: an object/array literal, or a bare palette member.
    const isValueShape = head.startsWith("{") || head.startsWith("[") || /^(COLORS|BG|GRADIENT)[.[]/.test(head);
    if (!isValueShape) continue;
    if (!PALETTE_REFERENCE.test(init.text)) continue;
    captures.push(`${relative(appRoot, path)}:${init.line}: ${lines[i].trim()}`);
  }
}

assert.deepEqual(
  captures,
  [],
  `module-scope palette values are frozen at import, so applyColorPalette can never repaint them.\n` +
    `Read COLORS/BG at render time instead (a function, or a mapping onto color *keys*):\n  ${captures.join("\n  ")}`
);

// ============================================================================
// Report
// ============================================================================

const worst = [];
for (const palette of palettes) {
  const text = [...palette.colors].map(([key, hex]) => [key, contrast(hex, palette.bg.get("toolResult"))]);
  text.sort((a, b) => a[1] - b[1]);
  worst.push(`${palette.file}: lowest contrast on BG.toolResult is ${text[0][0]} ${text[0][1].toFixed(2)}:1`);
}
process.stdout.write(`${worst.join("\n")}\nvalidate-theme-palettes: ok\n`);
