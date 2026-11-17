/**
 * Theme colors — Claude Code style.
 *
 * Warm, earthy palette inspired by Claude Code's terminal aesthetic:
 * coral/orange accents on a deep brown-black base, with amber and
 * terracotta tones replacing the cool blues/purples of the gemini theme.
 * `accent` is the deliberate exception — a muted teal. A fully warm set put
 * `primary`, `warning` and `accent` inside one hue arc, so inline code read as
 * a link; the single cool counterpoint is what keeps the roles apart.
 *
 * Every value here clears 4.5:1 against the base background **and** against
 * `BG.toolResult` (where tool rows are painted); `pnpm --filter @codent/app run
 * validate:theme-palettes` recomputes it, so a "nicer" hex that fails contrast is
 * a failing check rather than a later complaint.
 *
 * This file exports the SAME symbols as `colors.ts` (GRADIENT, COLORS, BG,
 * interpolateColor), so you can switch themes by changing a single import
 * path — no other code changes needed.
 *
 * Usage:
 * ```tsx
 * import { COLORS, BG } from "../theme/colors-claude.js";
 *
 * <Text color={COLORS.primary}>Active</Text>
 * <Text color={COLORS.muted} dimColor>Secondary</Text>
 * <HalfLinePaddedBox backgroundColor={BG.input}>...</HalfLinePaddedBox>
 * ```
 */

// ============================================================================
// Color Utilities
// ============================================================================

function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function rgbToHex(r: number, g: number, b: number): string {
  return "#" + ((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1);
}

/**
 * Linearly interpolate between two hex colors.
 * @param color1 - First hex color (e.g. "#000000")
 * @param color2 - Second hex color (e.g. "#8B949E")
 * @param factor - Blend factor: 0 = color1, 1 = color2
 */
export function interpolateColor(color1: string, color2: string, factor: number): string {
  const f = Math.max(0, Math.min(1, factor));
  const [r1, g1, b1] = hexToRgb(color1);
  const [r2, g2, b2] = hexToRgb(color2);
  return rgbToHex(Math.round(r1 + (r2 - r1) * f), Math.round(g1 + (g2 - g1) * f), Math.round(b1 + (b2 - b1) * f));
}

// ============================================================================
// Brand Gradient (Header logo only)
// ============================================================================

/** Warm gradient: amber → coral → terracotta */
export const GRADIENT = {
  cyan: "#D97757", // amber-coral (reuses the "cyan" slot name for compat)
  purple: "#C89668", // warm gold
  pink: "#E8A87C", // soft terracotta
} as const;

// ============================================================================
// Base Palette
// ============================================================================

/**
 * Terminal base background — deep warm brown-black.
 * Background colors for input/messages are interpolated from this.
 */
const TERMINAL_BG = "#1A1816";
/** Warm gray used for interpolating subtle background tints. */
const GRAY = "#9B8B7A";

// ============================================================================
// Semantic Colors
// ============================================================================

export const COLORS = {
  /** Primary — coral orange. Active state, titles, emphasis, links. */
  primary: "#E0805F",
  /** Accent — muted teal. The one cool counterpoint to the warm palette: inline code, special
   *  tags, user prefix. Without it every accent lands in the same 15–40° hue arc as `primary` and
   *  `warning`, so an inline code span reads as a link. */
  accent: "#6FAFB1",
  /** Success — sage green. Completed, approved, ✓. */
  success: "#7DA88A",
  /** Warning — golden amber. Waiting, approval needed, ?. */
  warning: "#D4A04C",
  /** Danger — rose red. Errors, denied, ✗. Deliberately on the other side of `primary`'s hue: a
   *  warm brick next to a warm coral left "error" and "active" indistinguishable. */
  danger: "#EA6469",
  /** Muted — warm gray. Secondary text, placeholders, dim info. */
  muted: "#A6957F",
  /** Text — warm off-white. Primary text content. */
  text: "#E8DDD3",
} as const;

// ============================================================================
// Background Colors
// ============================================================================

export const BG = {
  /**
   * Input box background — warm brown-black blended ~15% toward warm gray.
   * Subtle enough to distinguish from the main background without
   * being a heavy color block.
   */
  input: interpolateColor(TERMINAL_BG, GRAY, 0.15),
  /**
   * User message background — same family as input but slightly lighter
   * (~20%) so user messages stand out marginally from the input prompt.
   */
  message: interpolateColor(TERMINAL_BG, GRAY, 0.2),
  /**
   * Rich tool-result block background — same warm-gray family but fainter
   * than the user message (~10%) so structured tool output reads as a
   * grouped block without competing with user messages.
   */
  toolResult: interpolateColor(TERMINAL_BG, GRAY, 0.1),
  /** Default border / divider color — warm brown-black blended ~25% toward warm gray. */
  border: interpolateColor(TERMINAL_BG, GRAY, 0.25),
  /** Border for approved state */
  borderSuccess: COLORS.success,
  /** Border for denied state */
  borderDanger: COLORS.danger,
  /** File tree row — keyboard cursor (primary tint). */
  rowCursor: interpolateColor(TERMINAL_BG, COLORS.primary, 0.32),
  /** File tree row — open preview file (accent tint). */
  rowSelected: interpolateColor(TERMINAL_BG, COLORS.accent, 0.26),
  /** LiteDiff unchanged/context-line background — neutral gray grouping tint
   *  so the whole diff block reads as one region (transparentBody container
   *  paints nothing behind it). */
  diffContext: interpolateColor(TERMINAL_BG, GRAY, 0.1),
  /** LiteDiff added-line background — subtle green tint. */
  diffAdded: interpolateColor(TERMINAL_BG, COLORS.success, 0.16),
  /** LiteDiff removed-line background — subtle red tint. */
  diffRemoved: interpolateColor(TERMINAL_BG, COLORS.danger, 0.16),
} as const;
