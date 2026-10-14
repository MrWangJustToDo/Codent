import { Box, Text } from "ink";

import { COLORS } from "../theme/colors.js";

import type { ExtensionRenderPayload } from "@codent/core";
import type { ReactNode } from "react";

/**
 * Hard bounds so a misbehaving extension cannot exhaust the layout budget.
 * Payloads cross a process boundary, so nothing here is trusted.
 */
const MAX_DEPTH = 8;
const MAX_NODES = 200;
const MAX_TEXT_LENGTH = 2000;
const MAX_SPACING = 8;

/** The closed set of layout primitives the generic renderer understands. */
const NODE_TYPES = new Set(["text", "row", "column", "box"]);

/**
 * Keep SGR styling (`ESC [ … m`) — extensions legitimately colorize their output
 * — while neutralizing destructive terminal control sequences (screen clear,
 * cursor movement/positioning, window title, OSC 8 hyperlinks) that could wreck
 * the host layout.
 */
export function sanitizeAnsi(text: string): string {
  // OSC sequences (hyperlinks, window title): ESC ] … BEL | ESC \
  // Note: the terminator is optional, so a truncated OSC swallows the remainder
  // of that text rather than leaving half an escape sequence on screen.
  // eslint-disable-next-line no-control-regex -- ANSI escapes are control characters by definition.
  let out = text.replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?/g, "");
  // CSI sequences: keep SGR (`m`), drop cursor/screen/erase codes.
  // eslint-disable-next-line no-control-regex -- ANSI escapes are control characters by definition.
  out = out.replace(/\u001b\[([0-9;?]*)([A-Za-z])/g, (_match, params: string, final: string) =>
    final === "m" ? `\u001b[${params}m` : ""
  );
  // Any remaining two-character escape (ESC 7, ESC c, …) is destructive too — but `[` is excluded
  // here, because this pass runs over the SGR the line above just KEPT: `\u001b[33m` starts with
  // `ESC[`, so matching it would leave the literal `33m` on screen and strip the color the
  // sequence exists to apply. A real CSI always has its parameters, so it was consumed above.
  // eslint-disable-next-line no-control-regex -- ANSI escapes are control characters by definition.
  out = out.replace(/\u001b(?!\[)[\s\S]/g, "");
  return out;
}

/** Sanitize, then bound the length; a truncated payload gets a reset suffix. */
function limitText(value: string): string {
  const clean = sanitizeAnsi(value);
  if (clean.length <= MAX_TEXT_LENGTH) return clean;
  return `${clean.slice(0, MAX_TEXT_LENGTH)}\u001b[0m`;
}

function asRecord(node: unknown): Record<string, unknown> | null {
  return typeof node === "object" && node !== null ? (node as Record<string, unknown>) : null;
}

function spacing(value: unknown): number | undefined {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return Math.min(Math.floor(n), MAX_SPACING);
}

/**
 * Recursive walk of one payload. Unknown node types are ignored entirely (never
 * rendered as their type name), over-budget subtrees are dropped, and depth is
 * capped — the rest of the tree still renders.
 */
function renderNode(node: unknown, depth: number, budget: { remaining: number }, key: string): ReactNode {
  if (budget.remaining <= 0) return null;
  budget.remaining -= 1;

  if (typeof node === "string") return <Text key={key}>{limitText(node)}</Text>;

  const record = asRecord(node);
  const type = record?.type;
  if (!record || typeof type !== "string" || !NODE_TYPES.has(type)) return null;
  if (depth >= MAX_DEPTH) return null;

  if (type === "text") return <Text key={key}>{limitText(String(record.value ?? ""))}</Text>;

  const children = Array.isArray(record.children) ? record.children : [];
  const rendered = children.map((child, index) => renderNode(child, depth + 1, budget, `${key}.${index}`));
  const gap = spacing(record.gap);

  if (type === "row") {
    return (
      <Box key={key} flexDirection="row" gap={gap}>
        {rendered}
      </Box>
    );
  }
  if (type === "column") {
    return (
      <Box key={key} flexDirection="column" gap={gap}>
        {rendered}
      </Box>
    );
  }
  // `box`: an optional bordered / padded container around its children.
  const padding = spacing(record.padding);
  const bordered = record.border === true;
  return bordered ? (
    <Box key={key} flexDirection="column" borderStyle="round" borderColor={COLORS.muted} paddingX={padding}>
      {rendered}
    </Box>
  ) : (
    <Box key={key} flexDirection="column" paddingX={padding}>
      {rendered}
    </Box>
  );
}

/**
 * The single generic renderer for extension surfaces. Accepts raw text (ANSI and
 * line breaks preserved) or a `text` / `row` / `column` / `box` tree. Rendering
 * failures are contained: a broken payload renders nothing instead of throwing
 * into the host tree.
 */
export const ExtensionRenderSurface = ({ payload }: { payload: ExtensionRenderPayload }) => {
  // The traversal is defensive already, but a payload from an untrusted
  // extension must never throw into the host tree.
  let rendered: ReactNode = null;
  try {
    rendered = renderNode(payload, 0, { remaining: MAX_NODES }, "n");
  } catch {
    rendered = null;
  }
  return <>{rendered}</>;
};
