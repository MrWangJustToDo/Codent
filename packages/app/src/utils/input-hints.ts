/**
 * Rotating placeholder hints for the empty input.
 *
 * Copy is grounded in the real shortcut reference (`getKeyboardShortcutSections`
 * in utils/keyboard-labels.js) and the registered slash commands — never add a
 * chord the app does not actually handle, and keep the `/help` wording in sync
 * when a command description changes.
 *
 * Rotation is a **shuffled pass without repeats**: every hint is shown once before
 * any hint repeats, and a fresh pass never opens with the hint that is still on
 * screen. The deck lives at module scope on purpose — remounting the input
 * (session switch, panel toggle, resize) keeps the hint that was on screen
 * instead of restarting at the first one.
 */

import { KeyLabel, approveDenyLabel, modifiedEnterLabel, newlineEnterLabel } from "./keyboard-labels.js";

/** How long each hint stays on screen while the input is empty. */
export const HINT_ROTATE_INTERVAL_MS = 6000;

/** Hint copy, grouped by kind; the first entry is what a fresh session shows. */
export const INPUT_HINTS: readonly string[] = [
  // Quick-start prompts
  'Try: "Explain this codebase"',
  'Try: "Fix the bug in this module"',
  'Try: "Write tests for this function"',
  'Try: "Review my last commit"',
  'Try: "Refactor this file"',

  // Chat + input operations
  `${KeyLabel.enter} submits · ${newlineEnterLabel()} inserts a newline`,
  `${KeyLabel.enter} while running queues a follow-up`,
  `${modifiedEnterLabel()} force-submits while a run is in progress`,
  "Paste a big block and it collapses into a single label",
  `${KeyLabel.ctrlV} pastes an image · ${KeyLabel.ctrlO} expands pasted text`,
  `${KeyLabel.ctrlU} clears the input · ${KeyLabel.ctrlA} selects all`,
  `${KeyLabel.upDown} recalls history · ${KeyLabel.tab} accepts a suggestion`,
  `${KeyLabel.esc} aborts the run or dismisses a panel · ${KeyLabel.ctrlC} exits`,

  // Panels + modes
  `${KeyLabel.shiftTab} cycles Normal → Auto → Plan mode`,
  `${KeyLabel.ctrlE} workspace · ${KeyLabel.ctrlT} tasks · ${KeyLabel.ctrlY} extensions`,
  `${KeyLabel.ctrlP} reviews the plan markdown when a plan is ready`,

  // Approvals
  `${approveDenyLabel()} approves or denies a tool call`,

  // Slash commands
  `${KeyLabel.slash} opens all commands`,
  "/help lists commands and keyboard shortcuts",
  "/mode switches normal / auto / plan",
  "/models switches the model · /effort sets reasoning depth",
  "/settings sets theme, density, diff renderer and the model config",
  "/resume continues a previous session · /compact compresses context",
  "/usage shows token usage and cost · /clear starts a new session",
  "/rename retitles this session",
];

interface HintDeck {
  /** Indices left in the current pass; drawn from the end. */
  queue: number[];
  /** Hint on screen (-1 only right after a reset). */
  current: number;
}

/**
 * Module-scope deck: `current: 0` mirrors the hint the empty input renders before
 * the first rotation, so index 0 counts as already shown.
 */
const deck: HintDeck = { queue: [], current: 0 };

/** Hint to show now — what a remount picks up instead of restarting the deck. */
export function currentInputHint(): string {
  return INPUT_HINTS[deck.current >= 0 ? deck.current : 0];
}

/** Advance the deck and return the next hint (starts a new pass when exhausted). */
export function nextInputHint(random: () => number = Math.random): string {
  deck.current = drawHintIndex(random);
  return INPUT_HINTS[deck.current];
}

/** Test hook: drop all rotation state (back to a fresh session). */
export function resetInputHints(): void {
  deck.queue = [];
  deck.current = 0;
}

function drawHintIndex(random: () => number): number {
  if (deck.queue.length === 0) deck.queue = startPass(random);
  return deck.queue.pop() ?? deck.current;
}

/**
 * A full pass of every hint, shuffled — swapping the draw the deck would open
 * with when it equals the hint already on screen, so the pass stays complete
 * *and* nothing repeats back to back.
 */
function startPass(random: () => number): number[] {
  const queue = shuffle(
    INPUT_HINTS.map((_, index) => index),
    random
  );
  const last = queue.length - 1;
  if (last > 0 && queue[last] === deck.current) {
    [queue[last], queue[last - 1]] = [queue[last - 1], queue[last]];
  }
  return queue;
}

function shuffle(values: number[], random: () => number): number[] {
  for (let i = values.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [values[i], values[j]] = [values[j], values[i]];
  }
  return values;
}
