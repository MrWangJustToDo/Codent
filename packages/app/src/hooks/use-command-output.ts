import { splitStreamingLines } from "@codent/core";
import { createState } from "reactivity-store";

import type { ReactNode } from "react";

const MAX_VISIBLE = 7;

export interface CommandOutputState {
  /** Lines to display (null = hidden) */
  lines: string[] | null;
  /** Title/header for the output panel */
  title: string;
  /** Optional rendered block (e.g. a heatmap graph) shown above the lines. */
  node?: ReactNode;
  /** Current scroll offset (first visible line index) */
  scrollOffset: number;
}

export const useCommandOutput = createState(
  () => ({
    lines: null as string[] | null,
    title: "",
    node: undefined as ReactNode | undefined,
    scrollOffset: 0,
  }),
  {
    withActions: (state) => ({
      show: (title: string, content: string, node?: ReactNode) => {
        const lines = splitStreamingLines(content);
        state.title = title;
        state.lines = lines.length > 0 ? lines : [""];
        state.node = node;
        // Start at the top so help / shortcuts open from the beginning.
        state.scrollOffset = 0;
      },
      dismiss: () => {
        state.lines = null;
        state.title = "";
        state.node = undefined;
        state.scrollOffset = 0;
      },
      scrollPrev: () => {
        state.scrollOffset = Math.max(0, state.scrollOffset - 1);
      },
      scrollNext: () => {
        if (!state.lines) return;
        state.scrollOffset = Math.min(state.lines.length - MAX_VISIBLE, state.scrollOffset + 1);
      },
      hasScroll: (): boolean => {
        return (state.lines?.length ?? 0) > MAX_VISIBLE;
      },
    }),
    withDeepSelector: false,
    withStableSelector: true,
    // withNamespace: "useCommandOutput",
  }
);

export { MAX_VISIBLE as COMMAND_OUTPUT_MAX_VISIBLE };
