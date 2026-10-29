import chalk from "chalk";
import { Box, Text } from "ink";
import { useEffect, useRef, useState, type ReactNode } from "react";

import { useMainInput } from "../hooks/input";
import { codePointLength } from "../utils/code-point-length.js";

// ============================================================================
// TextInput — shared text input with full cursor editing (multi-line capable)
//
// A lightweight controlled input for form fields. The value renders with a
// chalk.inverse block cursor — and the caret's line also claims the TERMINAL
// cursor, so a terminal's IME candidate window follows the caret instead of
// wherever the last repaint stopped painting. Editing keys:
//   - left/right/home/end (and Ctrl+A/E/B/F) navigation; home/end and Ctrl+A/E
//     move to line edges in multi-line text, up/down move across lines
//   - insert/delete/backspace, word deletion (Ctrl+W), line deletion (Ctrl+U/K)
//   - Enter submits (calls onSubmit); Ctrl+J (the raw \n character, reliable
//     in every terminal, unlike Shift+Enter) inserts a newline
// ============================================================================

export interface TextInputProps {
  value: string;
  onChange: (value: string) => void;
  /** Called on Enter; passes the current value. */
  onSubmit?: (value: string) => void;
  onEscape?: () => void;
  placeholder?: string;
  /** Mask the rendered value (e.g. API keys). */
  mask?: boolean;
  /** Disable editing entirely (e.g. while saving). */
  disabled?: boolean;
}

/** Line start offsets for every line in `value` (index into the raw string). */
function lineStarts(value: string): number[] {
  const starts = [0];
  for (let i = 0; i < value.length; i += 1) {
    if (value[i] === "\n") starts.push(i + 1);
  }
  return starts;
}

function lineStartOf(value: string, cursor: number): number {
  const starts = lineStarts(value);
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid]! <= cursor) lo = mid;
    else hi = mid - 1;
  }
  return starts[lo]!;
}

function lineEndOf(value: string, cursor: number): number {
  const start = lineStartOf(value, cursor);
  const newline = value.indexOf("\n", start);
  return newline === -1 ? value.length : newline;
}

/** Remove the word immediately before `cursor`; returns [newValue, newCursor]. */
function deleteWordBefore(value: string, cursor: number): [string, number] {
  const before = value.slice(0, cursor);
  let end = before.length;
  while (end > 0 && /\s/.test(before[end - 1]!)) end--;
  let start = end;
  while (start > 0 && !/\s/.test(before[start - 1]!)) start--;
  return [value.slice(0, start) + value.slice(cursor), start];
}

function renderWithCursor(value: string, cursor: number, placeholder: string): string {
  if (!value) {
    if (placeholder) {
      return chalk.inverse(placeholder[0] || " ") + chalk.gray(placeholder.slice(1));
    }
    return chalk.inverse(" ");
  }
  const before = value.slice(0, cursor);
  const at = value[cursor] || " ";
  const after = value.slice(cursor + 1);
  return before + chalk.inverse(at) + after;
}

/** Multi-line rendering: one Text node per line, cursor drawn at its position.
 *
 * The line holding the caret also claims the TERMINAL cursor (`terminalCursorFocus` +
 * `terminalCursorPosition`): the inverse cell is drawn by us, but a terminal anchors the IME
 * candidate window to the physical cursor, which would otherwise be left wherever the frame
 * stopped painting — every repaint then moves the candidate window between cells.
 */
function renderMultiLine(value: string, cursor: number, anchorCursor: boolean): ReactNode[] {
  const starts = lineStarts(value);
  const nodes: ReactNode[] = [];
  for (let i = 0; i < starts.length; i += 1) {
    const lineStart = starts[i]!;
    const lineEnd = i + 1 < starts.length ? starts[i + 1]! - 1 : value.length;
    const line = value.slice(lineStart, lineEnd);
    const cursorInLine = cursor >= lineStart && cursor <= lineEnd;
    let content: string;
    let at = 0;
    if (cursorInLine) {
      at = cursor - lineStart;
      content = line.slice(0, at) + chalk.inverse(line[at] || " ") + line.slice(at + 1);
    } else {
      content = line;
    }
    // Code points, not UTF-16 units: `terminalCursorPosition` indexes the renderer's per-code-point
    // character array (see `utils/code-point-length.ts`).
    const cursorProps =
      anchorCursor && cursorInLine
        ? { terminalCursorFocus: true, terminalCursorPosition: codePointLength(line.slice(0, at)) }
        : {};
    nodes.push(
      <Text key={i} wrap="truncate-end" {...cursorProps}>
        {content || " "}
      </Text>
    );
  }
  return nodes;
}

export const TextInput = ({
  value,
  onChange,
  onSubmit,
  onEscape,
  placeholder = "",
  mask = false,
  disabled = false,
}: TextInputProps) => {
  const [cursor, setCursor] = useState(value.length);
  const cursorRef = useRef(cursor);
  cursorRef.current = cursor;

  // Keep the cursor within the current value when it changes externally.
  useEffect(() => {
    setCursor((c) => Math.min(c, value.length));
  }, [value]);

  const display = mask ? "•".repeat(value.length) : value;

  // A form field, so it never owns the keyboard on its own: its owner (`ConfigEditor`) deactivates
  // its own keys on the text steps, and the `main` scope keeps this inert on any other screen.
  useMainInput(
    (input, key) => {
      if (key.escape) {
        onEscape?.();
        return;
      }
      if (key.return) {
        // Enter sends \r (name "return") — submit.
        onSubmit?.(value);
        return;
      }

      // Ctrl+J (and some terminals' Ctrl+Enter) delivers the raw \n character
      // (name "enter", key.ctrl NOT set) — the reliable newline chord in every
      // terminal. Shift+Enter sends \x1b\r which many terminals do not
      // recognize, so it must not be relied on.
      if (input === "\n") {
        const c = cursorRef.current;
        onChange(value.slice(0, c) + "\n" + value.slice(c));
        setCursor(c + 1);
        return;
      }
      if (key.upArrow) {
        const c = cursorRef.current;
        const start = lineStartOf(value, c);
        if (start > 0) {
          const prevEnd = start - 1; // position of the newline char
          const prevStart = lineStartOf(value, prevEnd);
          const col = Math.min(c - start, prevEnd - prevStart);
          setCursor(prevStart + col);
        } else {
          setCursor(0);
        }
        return;
      }
      if (key.downArrow) {
        const c = cursorRef.current;
        const end = lineEndOf(value, c);
        if (end < value.length) {
          const nextStart = end + 1;
          const nextEnd = lineEndOf(value, nextStart);
          const col = c - lineStartOf(value, c);
          setCursor(Math.min(nextStart + col, nextEnd));
        } else {
          setCursor(value.length);
        }
        return;
      }
      if (key.leftArrow) {
        setCursor((c) => Math.max(0, c - 1));
        return;
      }
      if (key.rightArrow) {
        setCursor((c) => Math.min(value.length, c + 1));
        return;
      }
      if (key.home) {
        setCursor(lineStartOf(value, cursorRef.current));
        return;
      }
      if (key.end) {
        setCursor(lineEndOf(value, cursorRef.current));
        return;
      }
      if (key.backspace) {
        const c = cursorRef.current;
        if (c > 0) {
          onChange(value.slice(0, c - 1) + value.slice(c));
          setCursor(c - 1);
        }
        return;
      }
      if (key.delete) {
        const c = cursorRef.current;
        if (c < value.length) {
          onChange(value.slice(0, c) + value.slice(c + 1));
        }
        return;
      }

      // Ctrl shortcuts — word/line deletion and fast navigation (readline-style).
      // NOTE: react-terminal passes the letter itself (e.g. "a") for Ctrl+letter
      // combinations (with key.ctrl = true), NOT the control char (\x01). Match
      // the keybindings in hooks/keybindings/*.ts which compare input.toLowerCase().
      if (key.ctrl && input) {
        const ch = input.toLowerCase();
        const c = cursorRef.current;
        if (ch === "a") {
          setCursor(lineStartOf(value, c)); // Ctrl+A — line start
          return;
        }
        if (ch === "e") {
          setCursor(lineEndOf(value, c)); // Ctrl+E — line end
          return;
        }
        if (ch === "b") {
          setCursor((cur) => Math.max(0, cur - 1)); // Ctrl+B — back
          return;
        }
        if (ch === "f") {
          setCursor((cur) => Math.min(value.length, cur + 1)); // Ctrl+F — forward
          return;
        }
        if (ch === "d") {
          if (c < value.length) onChange(value.slice(0, c) + value.slice(c + 1)); // Ctrl+D — delete char
          return;
        }
        if (ch === "u") {
          const start = lineStartOf(value, c); // Ctrl+U — delete to line start
          onChange(value.slice(0, start) + value.slice(c));
          setCursor(start);
          return;
        }
        if (ch === "k") {
          const end = lineEndOf(value, c); // Ctrl+K — delete to line end
          onChange(value.slice(0, c) + value.slice(end));
          return;
        }
        if (ch === "w") {
          const [next, nc] = deleteWordBefore(value, c); // Ctrl+W — delete word before
          onChange(next);
          setCursor(nc);
          return;
        }
      }

      if (input && !key.ctrl && !key.meta) {
        const c = cursorRef.current;
        const next = value.slice(0, c) + input + value.slice(c);
        onChange(next);
        setCursor(c + input.length);
      }
    },
    { when: !disabled }
  );

  if (!value) {
    return (
      <Text wrap="truncate-end" terminalCursorFocus={!disabled} terminalCursorPosition={0}>
        {renderWithCursor(value, cursor, placeholder)}
      </Text>
    );
  }

  if (display.includes("\n")) {
    return <Box flexDirection="column">{renderMultiLine(display, cursor, !disabled)}</Box>;
  }
  return (
    <Text
      wrap="truncate-end"
      terminalCursorFocus={!disabled}
      terminalCursorPosition={codePointLength(display.slice(0, cursor))}
    >
      {renderWithCursor(display, cursor, placeholder)}
    </Text>
  );
};
