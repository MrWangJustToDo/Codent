import { Box, Text } from "ink";
import { useMemo } from "react";

import { FullBox } from "../components/FullBox.js";
import { Spinner } from "../components/Spinner.js";
import { BG, COLORS } from "../theme/colors.js";
import { getGradientStops, interpolateColor, mapCharsToGradient } from "../utils/gradient.js";
import { headerShortcutTips } from "../utils/keyboard-labels.js";
import { textDisplayWidth } from "../utils/user-message-lines.js";

import type { WorkspaceGitInfo } from "../utils/workspace-git-info.js";

// ============================================================================
// Brand mark
// ============================================================================

// prettier-ignore
const LOGO_LINES = [
  " █▀▀ █▀█ █▀▄ █▀▀ █▄ █ ▀█▀",
  " █▄▄ █▄█ █▄▀ ██▄ █ ▀█  █ ",
];

/** Rendered width of the block-letter wordmark (used for tier thresholds). */
const LOGO_WIDTH = LOGO_LINES[0].length;

/** Compact wordmark shown when the block letters would not fit. */
const NARROW_WORDMARK = "CODENT";

// ============================================================================
// Responsive tiers
// ============================================================================

export type WelcomeTier = "wide" | "compact" | "narrow";

/** Layout tier for a terminal width: full / trimmed / single-line wordmark. */
export function welcomeTierForWidth(width: number): WelcomeTier {
  if (width >= 80) return "wide";
  if (width >= LOGO_WIDTH + 8) return "compact";
  return "narrow";
}

/** Horizontal gap between two tips (Ink `gap`, in columns) for a layout tier. */
export function tipsRowGapForTier(tier: WelcomeTier): number {
  return tier === "wide" ? 3 : 2;
}

/**
 * Tips that actually fit `available` columns on one row, in priority order.
 *
 * The tiers only know the terminal has room for the *wordmark*; the tips row is a
 * different budget entirely. Five tips need 104 columns (text + gaps), so a wide-tier
 * terminal narrower than that would wrap the row onto a second line. Measuring here
 * keeps the row to one line on every width: drop from the right until it fits, and
 * never render an empty row (the first tip is always shown, wrapping in the extreme).
 */
export function fitTipsToWidth(
  tips: ReadonlyArray<{ key: string; desc: string }>,
  available: number,
  gap: number
): ReadonlyArray<{ key: string; desc: string }> {
  if (tips.length === 0) return tips;
  const firstWidth = textDisplayWidth(`${tips[0].key} ${tips[0].desc}`);
  let used = firstWidth;
  let count = 1;
  for (let i = 1; i < tips.length; i++) {
    const next = used + gap + textDisplayWidth(`${tips[i].key} ${tips[i].desc}`);
    if (next > available) break;
    used = next;
    count++;
  }
  const fitted = count >= tips.length ? tips : tips.slice(0, count);
  return fitted;
}

/** Last path segment, used as a shorter workspace label on compact terminals. */
function basename(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  const parts = trimmed.split("/");
  return parts[parts.length - 1] || trimmed;
}

// ============================================================================
// Gradient wordmark
// ============================================================================

const GradientLine = ({
  text,
  stops,
  rowOffset,
}: {
  text: string;
  stops: string[] | readonly string[];
  rowOffset: number;
}) => {
  const chars = useMemo(() => {
    const totalLen = Math.max(LOGO_WIDTH, 1);
    return [...text].map((ch, i) => ({
      ch,
      color: ch.trim() ? interpolateColor(stops, (i + rowOffset * 0.3) / totalLen) : undefined,
    }));
  }, [text, stops, rowOffset]);

  return (
    <Text>
      {chars.map((c, i) => (
        <Text key={i} color={c.color}>
          {c.ch}
        </Text>
      ))}
    </Text>
  );
};

const Wordmark = ({ tier }: { tier: WelcomeTier }) => {
  const stops = getGradientStops();

  if (tier === "narrow") {
    const chars = mapCharsToGradient(NARROW_WORDMARK, stops);
    return (
      <Text bold>
        {chars.map((c, i) => (
          <Text key={i} color={c.color}>
            {c.ch}
          </Text>
        ))}
      </Text>
    );
  }

  return (
    <Box flexDirection="column">
      {LOGO_LINES.map((line, i) => (
        <GradientLine key={i} text={line} stops={stops} rowOffset={i} />
      ))}
    </Box>
  );
};

// ============================================================================
// Meta / tips rows
// ============================================================================

/** Workspace + git line — full detail on wide terminals, trimmed on compact. */
const MetaLine = ({
  tier,
  git,
  workspacePath,
}: {
  tier: WelcomeTier;
  git: WorkspaceGitInfo | null;
  workspacePath: string;
}) => {
  const displayPath = tier === "compact" && workspacePath ? basename(workspacePath) : workspacePath;
  const branch = git ? `${git.branch}${git.dirty ? "*" : ""}` : "";
  const showSha = tier === "wide" && Boolean(git?.shortSha) && git != null && !git.branch.includes(git.shortSha);

  return (
    <Box marginTop={1} justifyContent="center" width="100%" flexShrink={0}>
      <Text wrap="truncate">
        {displayPath ? (
          <Text color={COLORS.muted} dimColor>
            {displayPath}
          </Text>
        ) : null}
        {displayPath && git ? (
          <Text color={COLORS.muted} dimColor>
            {" · "}
          </Text>
        ) : null}
        {git ? (
          <>
            <Text color={COLORS.muted} dimColor>
              git{" "}
            </Text>
            <Text color={COLORS.primary}>{branch}</Text>
            {showSha ? (
              <Text color={COLORS.muted} dimColor>
                {" · "}
                {git.shortSha}
              </Text>
            ) : null}
          </>
        ) : null}
      </Text>
    </Box>
  );
};

const TipsRow = ({ tier, innerWidth }: { tier: WelcomeTier; innerWidth: number }) => {
  const gap = tipsRowGapForTier(tier);
  const tips = useMemo(() => fitTipsToWidth(headerShortcutTips(), innerWidth, gap), [innerWidth, gap]);

  if (tips.length === 0) return null;

  return (
    <Box flexDirection="column" width="100%" flexShrink={0}>
      <Box marginTop={1}>
        <Text color={BG.border}>{"─".repeat(Math.max(0, innerWidth))}</Text>
      </Box>
      <Box marginTop={1} gap={gap} justifyContent="center" width="100%" flexShrink={0}>
        {tips.map((tip, i) => (
          <Box key={i} gap={1} flexShrink={0}>
            <Text color={COLORS.text}>{tip.key}</Text>
            <Text color={COLORS.muted} dimColor>
              {tip.desc}
            </Text>
          </Box>
        ))}
      </Box>
    </Box>
  );
};

// ============================================================================
// WelcomePanel
// ============================================================================

/**
 * Copy for the `loading` variant — what the user is waiting for during `initLoading`.
 *
 * Exported so the smoke can assert on it and so the label has exactly one home. It must name
 * what startup actually does (the workspace git probe + `adapter.initialize`); the OS sandbox is
 * NOT on the startup path — `ensureOsSandbox()` runs on the first `run_command` — so "Initializing
 * sandbox…" described a subsystem this screen never touches.
 */
export const LOADING_STATUS_TEXT = "Starting agent…";

export interface WelcomePanelProps {
  /**
   * `loading` shows a spinner, `ready` shows meta + tips, `error` shows a
   * message, `config` renders only the brand mark (onboarding header).
   */
  variant: "loading" | "ready" | "error" | "config";
  /** Current terminal width — drives the responsive tier. */
  screenWidth: number;
  git?: WorkspaceGitInfo | null;
  workspacePath?: string;
  /** Active remote planes, shown as a badge under the tagline (ready only). */
  remotePlanes?: string[];
  /** Status line for the `loading` variant. Defaults to {@link LOADING_STATUS_TEXT}. */
  loadingText?: string;
  /** Message shown by the `error` variant. */
  errorMessage?: string;
}

/**
 * Shared branded startup block. Used by the initialization/loading screen, the
 * static welcome header, and the first-run config editor so they share one look.
 * The `config` variant renders only the brand mark (no status area).
 */
export const WelcomePanel = ({
  variant,
  screenWidth,
  git = null,
  workspacePath = "",
  remotePlanes = [],
  loadingText = LOADING_STATUS_TEXT,
  errorMessage,
}: WelcomePanelProps) => {
  const tier = welcomeTierForWidth(screenWidth);
  const paddingX = tier === "narrow" ? 1 : 3;
  const innerWidth = Math.max(0, screenWidth - paddingX * 2);

  const badge = remotePlanes.join(" · ");

  const showBadge = variant === "ready" && badge.length > 0;
  const showMeta = variant === "ready" && tier !== "narrow" && (Boolean(workspacePath) || git != null);

  return (
    <FullBox flexDirection="column" key="welcome" marginBottom={1} paddingX={paddingX} paddingY={1}>
      {/* Brand mark */}
      <Box flexDirection="column" alignItems="center" width="100%">
        <Wordmark tier={tier} />

        <Box marginTop={1}>
          <Text color={COLORS.accent} italic>
            AI-Powered Coding Agent
          </Text>
        </Box>

        {showBadge && (
          <Box marginTop={1}>
            <Text color={COLORS.warning} dimColor>
              {badge}
            </Text>
          </Box>
        )}
      </Box>

      {/* Status area — the only part that differs between variants */}
      {variant === "loading" && (
        <Box marginTop={1} justifyContent="center" width="100%">
          <Spinner text={loadingText} />
        </Box>
      )}

      {variant === "error" && (
        <Box marginTop={1} flexDirection="column" alignItems="center" width="100%">
          <Text color={COLORS.danger} bold>
            Initialization Error
          </Text>
          {errorMessage ? <Text color={COLORS.danger}>{errorMessage}</Text> : null}
        </Box>
      )}

      {variant === "ready" && (
        <>
          {showMeta && <MetaLine tier={tier} git={git} workspacePath={workspacePath} />}
          <TipsRow tier={tier} innerWidth={innerWidth} />
        </>
      )}
    </FullBox>
  );
};
