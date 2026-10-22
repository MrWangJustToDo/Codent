/**
 * MessageList - Renders a list of UIMessages with their parts.
 *
 * Uses AI SDK's UIMessage format with parts (text, reasoning, tool-*, etc).
 * Static messages are capped to limit terminal output and improve performance.
 */

import { Box, Text, StaticRender, measureElement } from "ink";
import { useCallback, useEffect, useRef } from "react";

import { StaticContext } from "../context/static-context.js";
import { TranscriptDisplayContext } from "../context/transcript-display-context.js";
import { useAgent } from "../hooks/use-agent.js";
import { useDiffRenderer } from "../hooks/use-diff-renderer.js";
import { useDynamic } from "../hooks/use-dynamic";
import { useSize } from "../hooks/use-size.js";
import { useStatic } from "../hooks/use-static";
import { useStaticHeights } from "../hooks/use-static-heights.js";
import { useTheme } from "../hooks/use-theme.js";
import { useTranscriptDisplay } from "../hooks/use-transcript-display.js";
import { MessageView } from "../messages";
import { COLORS } from "../theme/colors.js";
import { encodeToolCallState } from "../utils/dedupe-tool-calls";
import { countSourceMessages, getMessages } from "../utils/get-messages";
import { flattenNamespaceFor } from "../utils/message-flat-cache.js";

import { CursorFlush } from "./CursorFlush";

import type { UIMessage } from "@tanstack/ai";
import type { DOMElement } from "ink";
import type { JSX } from "react";

// ============================================================================
// Constants
// ============================================================================

/**
 * Rendered-line budget for the completed (static) region.
 *
 * Counted in *lines*, not messages: the cached region is a fixed-size leaf in the Yoga tree, so
 * what matters is how much vertical space it occupies. A message-count cap silently overshoots
 * whenever rows grow taller than one line.
 *
 * Which window this relates to, precisely — three different ones exist, and only the third is
 * what the value was chosen against:
 *
 *  1. the worker's screen: the terminal viewport (~40 lines);
 *  2. the FIRST write after a full repaint: keeps the trailing `maxScrollbackLength + rows`
 *     lines and discards the rest from the top (`TerminalWriter.writeLines`);
 *  3. the append / scroll-back window: keeps the trailing `maxScrollbackLength` (1000) lines and
 *     drops the oldest.
 *
 * 1200 is chosen against (3) only. It is deliberately ABOVE that window so the trailing rows the
 * user is looking at stay complete; overshooting means the top of the region stops being
 * reachable, which is bounded and is the better trade than dropping the newest rows.
 *
 * (2) is a different cost and is ACCEPTED: the first paint after a full repaint discards the top
 * of a region taller than `1000 + rows`. Measured with the 60-turn fixture the whole region is
 * ~438 lines (2.20 lines/row), well inside that window, so it only bites transcripts far larger
 * than a typical session.
 */
export const MAX_STATIC_LINES = 1200;

/**
 * Lines charged to a row whose height has never been measured.
 *
 * `onRender` fires after layout, so on a cold mount (resume, `/new`, first paint) no row
 * has a height yet. Charging the *average* keeps the budget honest; charging zero — or
 * assuming a truncated row is one line — would select far more rows than fit and drop more
 * history than the message-count cap this replaces.
 */
export const PROVISIONAL_ROW_LINES = 12;

/**
 * Lines the worker's screen model keeps. Recorded here because `MAX_STATIC_LINES` is chosen
 * relative to it; deliberately NOT changed (raising it would copy the whole session's rows
 * into the worker's screen buffer for no benefit — growth within the window never evicts
 * history, only a single frame taller than the window does).
 */

/**
 * How many messages enter the static derivation (`getMessages`). Bounds the per-render
 * cost — digest, flatten and tool fingerprint — by a constant instead of by session
 * length. The window start snaps back to a user-message boundary, so the effective
 * count can exceed this slightly.
 */
const STATIC_INPUT_WINDOW = 120;

/** Fallback namespace when no session is bound yet (pre-bootstrap renders). */
const FLATTEN_NAMESPACE_FALLBACK = "transcript";

// ============================================================================
// Props
// ============================================================================

export interface MessageListProps {
  messages: UIMessage[];
}

function computeDynamicListSignature(messages: UIMessage[]): string {
  return messages
    .map((m) => {
      const part = m.parts[0];
      if (!part) return m.id;
      if (part.type === "tool-call") {
        const tool = part as { id?: string; state?: string; output?: unknown; approval?: { approved?: boolean } };
        return `${m.id}:${encodeToolCallState(tool)}`;
      }
      if (part.type === "text") {
        const content = (part as { content?: string }).content ?? "";
        return `${m.id}:text:${content.length}:${content.slice(0, 24)}`;
      }
      return `${m.id}:${part.type}`;
    })
    .join("|");
}

/**
 * Pick the trailing rows whose measured heights fit `MAX_STATIC_LINES`.
 *
 * Selection is strictly by position from the end, and a row's height comes from the store
 * when it has one and from {@link PROVISIONAL_ROW_LINES} otherwise. Because the provisional
 * value is stable, a row's inclusion does not depend on whether a measurement has landed:
 * selections cannot oscillate as `onRender` fires after each frame.
 *
 * Rows only. The marker's message count is derived once in the component as
 * `staticSourceTotal - countSourceMessages(visibleRows)` — mixing a row-side count in here is how
 * the fold/partial-message edge cases appeared in the first place.
 */
export function selectVisibleRows(
  rows: UIMessage[],
  heights: Record<string, number>
): { visibleCount: number; droppedCount: number } {
  let used = 0;
  let visibleCount = 0;
  for (let i = rows.length - 1; i >= 0; i--) {
    const cost = heights[rows[i].id] ?? PROVISIONAL_ROW_LINES;
    if (visibleCount > 0 && used + cost > MAX_STATIC_LINES) break;
    used += cost;
    visibleCount++;
  }
  return { visibleCount, droppedCount: rows.length - visibleCount };
}

// ============================================================================
// Main Component
// ============================================================================

export const MessageList = ({ messages }: MessageListProps) => {
  const mode = useTranscriptDisplay((s) => s.mode);
  // Namespace by the owning agent so this transcript's snapshot cannot be evicted by a
  // subagent preview (and vice versa). `session` is the live AgentSession handle for the
  // active agent; before it is bound, fall back to a shared slot.
  const session = useAgent((s) => s.session);
  const namespace = session ? flattenNamespaceFor(session.id) : FLATTEN_NAMESPACE_FALLBACK;
  const { staticMessages, staticSignatures, dynamicMessages, staticSourceTotal } = getMessages(messages, {
    mode,
    window: STATIC_INPUT_WINDOW,
    namespace,
  });

  const theme = useTheme((s) => s.theme);
  const width = useSize((s) => s.state.screenWidth);
  const heights = useStaticHeights((s) => s.heights);
  // Diff renderer choice reaches rows through `ToolInputView` -> `MessageDiffView`, which is a
  // subscription inside the row rather than a prop, so it has to be part of the row's cache
  // deps: without it, switching the diff renderer (`/settings diff lite|full`) leaves every cached diff row
  // rendering through the previous renderer (and with a different height, the stale height).
  // Re-caching every row on a diff switch is correct — the switch does affect every diff row.
  const diffMode = useDiffRenderer((s) => `${s.mode}:${s.key}`);

  // Record a row's measured height after layout. Rows are `<StaticRender>` leaves, so this is
  // the only place their real height is observable: once a row is cached, its inner Yoga subtree
  // is detached, so a ref inside it measures `NaN` and the wrapper around it measures 0 lines.
  // The node handed to `onRender` is the cache leaf itself, and its height is computed BEFORE the
  // subtree is detached.
  const onRowRender = useCallback((id: string, node: DOMElement) => {
    useStaticHeights.getActions().recordHeight(id, measureElement(node).height);
  }, []);

  // Gating the first publication on a known width is load-bearing, not defensive. `onRender`
  // first fires on a pre-layout pass where the leaf reports `width 0` and a nonsense height
  // (measured: `2 * columns - 2`, so 238 at 120 columns). Caching at that width yields a region
  // that is 0 lines tall — the rows are invisible — and the post-cache pass then reports width
  // 120 with height 0. Because `recordHeight` rejects non-positive heights, that first bogus
  // value would stick permanently and the line budget would spend nonsense numbers. Publishing
  // only once the width is known makes the first cache write happen at the real width, in one pass.
  const widthReady = width > 0;
  // ── Truncate static list to a LINE budget ──
  // The marker is ONE subtraction, in MESSAGES: every static-side source message (`staticSourceTotal`,
  // which already includes the input window's prefix) minus the distinct sources the visible rows
  // represent. A message therefore counts as hidden only when NO visible row stands for it:
  //   - the budget cut inside one message's parts → it has a visible row → not hidden;
  //   - a compact activity row → its `sourceMessageIds` expand, so folded history is not "hidden";
  //   - a message that produced no row (thinking-only, …) → not represented → hidden.
  // Adding a "no row" term and a "dropped rows" term instead is the same number only while no
  // message straddles the cut — and it reported a fold as truncation in compact mode.
  const { visibleCount } = selectVisibleRows(staticMessages, heights);
  const visibleStaticMessages =
    visibleCount === staticMessages.length ? staticMessages : staticMessages.slice(-visibleCount);
  const visibleStaticSignatures =
    visibleCount === staticSignatures.length ? staticSignatures : staticSignatures.slice(-visibleCount);
  const visibleStaticLength = visibleStaticMessages.length;
  const hiddenTotal = Math.max(0, staticSourceTotal - countSourceMessages(visibleStaticMessages));
  const dynamicSignature = computeDynamicListSignature(dynamicMessages);

  // Rebuild static list when the row set, the marker total or the projection changes.
  // A single row's own content is NOT an input here: each row caches itself through its own
  // `<StaticRender deps>` below, so a row advancing no longer rebuilds its siblings.
  const lastDynamicSignatureRef = useRef("");
  const lastHasStaticRef = useRef(false);
  const lastDynamicModeRef = useRef(mode);
  const retainedIdsRef = useRef<string[]>([]);
  const dynamicListRef = useRef<JSX.Element | JSX.Element[]>(
    <Box paddingX={1} marginTop={1}>
      <Text color={COLORS.muted} dimColor>
        No messages yet. Type a message to start.
      </Text>
    </Box>
  );
  const hasStatic = staticMessages.length > 0;

  // The row-set signature deliberately excludes the row contents, so `elements` must be
  // rebuilt whenever ANY row's signature moves — otherwise the frozen element objects below
  // would keep their old `deps` and a changed row would never re-cache. Rebuilding the array
  // is cheap (creating elements, not rendering them); the expensive part — Yoga layout and
  // cache invalidation — is skipped per row by `<StaticRender>`'s own deps comparison, which
  // sees an equal deps array for every row that did not change.
  const staticSetSignature = `${visibleStaticLength}|${visibleStaticMessages[0]?.id ?? ""}`;
  // This key carries every input that can change what a row renders — including `width`,
  // `theme` and `diffMode`, which are invisible at this call site but read inside the row
  // subtree (`MessageDiffView` subscribes to the diff renderer).
  //
  // Rebuilding the array is the ONLY thing that hands rows a new `deps` array, so those values
  // belong HERE and not in the per-row `deps`: in both places they are redundant (they can never
  // differ while the array identity is unchanged), and they make one toggle cost two rebuilds —
  // one when the value flips, one when the accompanying `key` bump lands. Here alone means the
  // change re-caches exactly once and never zero times.
  const elementsKey = `${staticSetSignature}|${hiddenTotal}|${mode}|${width}|${theme}|${diffMode}|${visibleStaticSignatures.join("\u0000")}`;
  const listRef = useRef<{ key: string; elements: JSX.Element[]; sigs: string[] }>({
    key: "",
    elements: [],
    sigs: [],
  });
  if (widthReady && listRef.current.key !== elementsKey) {
    const elements = visibleStaticMessages.map((item, i) => (
      <StaticRender
        key={item.id}
        width={width}
        deps={[visibleStaticSignatures[i], width, mode, theme, diffMode]}
        onRender={(node: DOMElement) => onRowRender(item.id, node)}
      >
        {() => (
          <Box paddingX={1} marginTop={1}>
            <TranscriptDisplayContext value={mode}>
              <StaticContext value={{ staticMessage: true }}>
                <MessageView message={item} />
              </StaticContext>
            </TranscriptDisplayContext>
          </Box>
        )}
      </StaticRender>
    ));

    if (hiddenTotal > 0) {
      // The marker caches with the rows it describes, and its text only changes when
      // `hiddenTotal` does — which is part of `elementsKey`.
      elements.unshift(
        <StaticRender key="truncation-marker" width={width} deps={[hiddenTotal, width, mode, theme]}>
          {() => (
            <Box paddingX={1} marginTop={1}>
              <Text color={COLORS.muted} dimColor>
                ... {hiddenTotal} older message{hiddenTotal === 1 ? "" : "s"} hidden
              </Text>
            </Box>
          )}
        </StaticRender>
      );
    }

    listRef.current = {
      key: elementsKey,
      elements,
      sigs: [
        ...(hiddenTotal > 0 ? ["truncation-marker"] : []),
        ...visibleStaticSignatures.map((sig, i) => `${visibleStaticMessages[i].id}|${width}|${mode}|${theme}|${sig}`),
      ],
    };

    // Reclaim measurements for rows that left the DERIVED row set — never for rows the budget
    // merely excluded. The distinction is load-bearing: `selectVisibleRows` decides visibility
    // FROM these heights, so pruning by the visible subset deletes the budget's own input and
    // makes the kept set oscillate (a released row reappears at its old height, changing the
    // selection again). The derived set is bounded by `STATIC_INPUT_WINDOW`, so it still cannot
    // grow for the whole session — which was the only thing this pruning had to prevent.
    const derivedIds = staticMessages.map((item) => item.id);
    if (
      derivedIds.length !== retainedIdsRef.current.length ||
      derivedIds.some((id, i) => id !== retainedIdsRef.current[i])
    ) {
      retainedIdsRef.current = derivedIds;
      useStaticHeights.getActions().retainIds(derivedIds);
    }
  }

  if (
    dynamicSignature !== lastDynamicSignatureRef.current ||
    hasStatic !== lastHasStaticRef.current ||
    mode !== lastDynamicModeRef.current
  ) {
    // Rebuild dynamic list only when live content or display mode changes.
    lastDynamicSignatureRef.current = dynamicSignature;
    lastHasStaticRef.current = hasStatic;
    lastDynamicModeRef.current = mode;

    dynamicListRef.current = dynamicMessages.length ? (
      dynamicMessages.map((message) => (
        <Box key={message.id} paddingX={1} marginTop={1}>
          <TranscriptDisplayContext value={mode}>
            <StaticContext value={{ staticMessage: false }}>
              <MessageView message={message} />
            </StaticContext>
          </TranscriptDisplayContext>
        </Box>
      ))
    ) : (
      <Box paddingX={1} marginTop={1}>
        <Text color={COLORS.muted} dimColor>
          {hasStatic ? <CursorFlush /> : "No messages yet. Type a message to start."}
        </Text>
      </Box>
    );
  }

  useEffect(() => {
    // Rows and their per-row signatures are published together: they are positional, so
    // publishing them from separate effects could pair one row with another's signature.
    // `Content` re-renders on the `list` identity this action replaces (it does not read
    // `listSet`, which the store bumps for parity with the other stores).
    useStatic.getActions().setStaticList(listRef.current.elements, listRef.current.sigs);
  }, [elementsKey]);

  useEffect(() => {
    useDynamic.getActions().setDynamicList(dynamicListRef.current);
  }, [dynamicSignature, visibleStaticLength, mode]);

  return null;
};
