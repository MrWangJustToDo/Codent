import { Box, Text } from "ink";

import { COLORS } from "../theme/colors.js";
import { boundAnsiText } from "../utils/ansi.js";

import type { ExtensionRenderPayload } from "@codent/core";
import type { ReactNode } from "react";

/**
 * Hard bounds so a misbehaving extension cannot exhaust the layout budget.
 * Payloads cross a process boundary, so nothing here is trusted.
 */
const MAX_DEPTH = 8;
const MAX_NODES = 200;
/** Visible characters per text node (code points, not UTF-16 units — see `boundAnsiText`). */
const MAX_TEXT_LENGTH = 2000;
const MAX_SPACING = 8;

/** The closed set of layout primitives the generic renderer understands. */
const NODE_TYPES = new Set(["text", "row", "column", "box"]);

/**
 * Sanitize, bound and style-terminate one text value (`boundAnsiText` owns the three rules).
 *
 * The reset is part of every rendered text, not just truncated ones: an extension that closes its
 * own styling is the normal case, and one that does not must not tint the footer below it.
 */
function limitText(value: string): string {
  return boundAnsiText(value, MAX_TEXT_LENGTH);
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
