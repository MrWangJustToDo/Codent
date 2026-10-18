import { createState } from "reactivity-store";

import { getAllCommands } from "../commands";
import { COMMAND_FREEFORM_VALUE, typedArgsAfterCommand } from "../commands/utils/command-options.js";

import { applyOptionsToState, closeMenu, descend, openLevel } from "./option-levels.js";

import type { Command, CommandOption } from "../commands";

// ============================================================================
// Types
// ============================================================================

export type AutocompleteMode = "commands" | "options";

export interface AutocompleteSuggestion {
  /** Display label */
  label: string;
  /** Usage or full command string */
  usage: string;
  /** Description */
  description: string;
  /** The underlying command (for commands mode) */
  command?: Command;
  /** The option value (for options mode) */
  optionValue?: string;
  /** Freeform option — execute with typed args */
  freeform?: boolean;
  /** Divider row — rendered as a rule line, skipped by selection */
  separator?: boolean;
  /** Submenu row — selecting it opens a deeper level instead of executing */
  hasSubmenu?: boolean;
  /** The row this suggestion came from (its `getOptions` opens the next level). */
  option?: CommandOption;
}

export interface AutocompleteState {
  /** Current mode */
  mode: AutocompleteMode;
  /** Filtered suggestions */
  suggestions: AutocompleteSuggestion[];
  /** Currently selected index */
  selectedIndex: number;
  /** Whether the suggestion list is visible */
  visible: boolean;
  /** Current command when in options mode */
  currentCommand: Command | null;
  /**
   * The option rows chosen so far, root level first — the menu's stack.
   *
   * `optionPath` is the same chain as values (what the input shows), and `levels` keeps the rows of
   * each level opened, so `Esc` can restore the parent list verbatim instead of re-resolving it (a
   * re-resolution could return different rows — metadata arriving, an entry edited mid-menu — and
   * the retreat would then land somewhere the user never was).
   */
  optionPath: string[];
  levels: CommandOption[][];
  /**
   * Identifies the current level load, so a resolver that answers late cannot write into a level the
   * user already left.
   *
   * Levels are resolved asynchronously (a model's depth list needs a metadata lookup), and the user
   * may press `Esc` — or dismiss entirely — while one is in flight. Comparing a captured token is what
   * makes the continuation a no-op in that case: without it the late rows land at the END of the
   * stack (`slice(0, -1)` is positional, not keyed), so after a retreat they would replace the PARENT
   * level and leave `levels.length` and `optionPath.length` describing different depths.
   */
  loadToken: number;
}

// ============================================================================
// Initial State
// ============================================================================

const initialState: AutocompleteState = {
  mode: "commands",
  suggestions: [],
  selectedIndex: 0,
  visible: false,
  currentCommand: null,
  optionPath: [],
  levels: [],
  loadToken: 0,
};

// ============================================================================
// Helper Functions
// ============================================================================

function commandToSuggestion(cmd: Command): AutocompleteSuggestion {
  return {
    label: cmd.name,
    usage: cmd.usage,
    description: cmd.description,
    command: cmd,
  };
}

/**
 * The command a fully-typed name refers to, including aliases. Autocomplete matches on the typed prefix
 * only, so without this a user typing the alias (`/appearance`) would land in options mode with no
 * options to filter.
 */
function resolveCommandByName(name: string): Command | undefined {
  const commands = getAllCommands();
  return commands.find((c) => c.name === name) ?? commands.find((c) => c.aliases?.includes(name));
}

// ============================================================================
// State Hook
// ============================================================================

export const useAutocomplete = createState(() => ({ ...initialState }), {
  withActions: (state) => ({
    /**
     * Update suggestions based on current input.
     * Shows suggestions when input starts with "/" and has matching commands.
     */
    update: (input: string) => {
      if (!input.startsWith("/")) {
        closeMenu(state);
        return;
      }

      const spaceIndex = input.indexOf(" ");
      const optionPrefix =
        spaceIndex === -1
          ? ""
          : input
              .slice(spaceIndex + 1)
              .toLowerCase()
              .trim();

      const opened = state.mode === "options" ? state.currentCommand : null;
      if (opened) {
        // Already in the menu: the rows are the level we are on, so only re-filter when the typed
        // text still sits inside it. Typing past the level means the user is writing args by hand
        // (`/models 0:x high`), and the menu steps aside rather than match against a level it no
        // longer describes.
        // Lowercased for the same reason as the filter: the path keeps the option's spelling.
        const pathPrefix = state.optionPath.join(" ").toLowerCase();
        if (pathPrefix && !optionPrefix.startsWith(pathPrefix)) {
          closeMenu(state);
          return;
        }
        const level = state.levels[state.levels.length - 1] ?? [];
        applyOptionsToState(state, opened, level, optionPrefix);
        return;
      }

      if (spaceIndex !== -1) {
        // The command is already chosen but the option list is not open yet —
        // a typed alias, or a command submitted straight through. Open the
        // options so aliases behave like the canonical name.
        const typedName = input.slice(1, spaceIndex).toLowerCase();
        const command = resolveCommandByName(typedName);
        if (command?.getOptions) {
          state.mode = "options";
          state.currentCommand = command;
          state.optionPath = [];
          state.levels = [];
          openLevel(state, command, optionPrefix);
          return;
        }
        // Command with no options (e.g. a fully-typed `/help <args>`).
        state.suggestions = [];
        state.selectedIndex = 0;
        state.visible = false;
        return;
      }

      // Commands mode - filter by prefix (name or alias)
      state.mode = "commands";
      state.currentCommand = null;
      state.optionPath = [];
      state.levels = [];
      const prefix = input.slice(1).toLowerCase();
      const commands = getAllCommands();
      const filtered = prefix
        ? commands.filter((c) => c.name.startsWith(prefix) || c.aliases?.some((a) => a.startsWith(prefix)))
        : [...commands];

      state.suggestions = filtered.map(commandToSuggestion);
      state.selectedIndex = filtered.length > 0 ? Math.min(state.selectedIndex, filtered.length - 1) : 0;
      state.visible = filtered.length > 0;
    },

    /**
     * Select next suggestion (skips separator rows)
     */
    selectNext: () => {
      if (!state.visible || state.suggestions.length === 0) return;
      let next = (state.selectedIndex + 1) % state.suggestions.length;
      while (state.suggestions[next]?.separator && next !== state.selectedIndex) {
        next = (next + 1) % state.suggestions.length;
      }
      state.selectedIndex = next;
    },

    /**
     * Select previous suggestion (skips separator rows)
     */
    selectPrev: () => {
      if (!state.visible || state.suggestions.length === 0) return;
      let prev = (state.selectedIndex - 1 + state.suggestions.length) % state.suggestions.length;
      while (state.suggestions[prev]?.separator && prev !== state.selectedIndex) {
        prev = (prev - 1 + state.suggestions.length) % state.suggestions.length;
      }
      state.selectedIndex = prev;
    },

    /**
     * Retreat one level: a nested menu goes back to its parent instead of closing.
     *
     * Returns the input text the parent level expects, or `null` when there is no parent (the caller
     * then closes the menu, as `Esc` always did).
     */
    back: (): string | null => {
      const command = state.currentCommand;
      if (state.mode !== "options" || !command || state.levels.length === 0) return null;

      state.optionPath = state.optionPath.slice(0, -1);
      state.levels = state.levels.slice(0, -1);
      const parent = state.levels[state.levels.length - 1];
      if (!parent) {
        // The root level itself: there is no parent to retreat to.
        return null;
      }
      applyOptionsToState(state, command, parent, state.optionPath.join(" "));
      return `/${[command.name, ...state.optionPath].join(" ")} `;
    },

    /**
     * Accept the currently selected suggestion.
     * Pass `currentInput` so freeform options can use the typed suffix.
     */
    accept: (currentInput?: string): { type: "input" | "execute"; value: string } | null => {
      if (!state.visible || state.suggestions.length === 0) return null;
      const selected = state.suggestions[state.selectedIndex];
      if (!selected) return null;
      // Defensive: separators are skipped by selection; ignore if somehow selected
      if (selected.separator) return null;

      if (state.mode === "options") {
        const command = state.currentCommand;
        if (!command) return null;
        const path = state.optionPath;

        if (selected.freeform || selected.optionValue === COMMAND_FREEFORM_VALUE) {
          closeMenu(state);
          const typed = typedArgsAfterCommand(currentInput ?? "", command.name);
          return {
            type: "execute",
            value: typed ? `/${command.name} ${typed}` : `/${command.name}`,
          };
        }

        const value = selected.optionValue ?? selected.label;

        // A submenu row descends instead of executing. A level the resolver answers with no rows is
        // treated as a leaf (it executes): descending into an empty list would strand the user one
        // level deep with nothing to pick.
        if (selected.option?.getOptions) {
          const nextPath = [...path, value];
          const next = descend(state, command, selected.option.getOptions(undefined, nextPath), nextPath);
          if (next) return { type: "input", value: `/${[command.name, ...nextPath].join(" ")} ` };
        }

        closeMenu(state);
        const suffix = [command.name, ...path, value].filter(Boolean).join(" ");
        // `insertOnSelect` commands keep the input editable after selecting an
        // option (fill `/cmd <path…> <value> `) so the user can append follow-up
        // text before submitting — e.g. /skill <name> + instructions. Other
        // commands (e.g. /resume) execute immediately on selection.
        if (command.insertOnSelect) return { type: "input", value: `/${suffix} ` };
        return { type: "execute", value: `/${suffix}` };
      }

      // Commands mode
      const command = selected.command;
      if (!command) return null;

      // If command is immediate (like /help), execute it directly
      if (command.immediate) {
        closeMenu(state);
        return { type: "execute", value: `/${command.name}` };
      }

      // If command has options, switch to options mode
      if (command.getOptions) {
        state.mode = "options";
        state.currentCommand = command;
        state.optionPath = [];
        state.levels = [];
        state.selectedIndex = 0;
        openLevel(state, command, "");
        return { type: "input", value: `/${command.name} ` };
      }

      // Default: set input to command with trailing space
      closeMenu(state);

      return { type: "input", value: `/${command.name} ` };
    },

    /**
     * Dismiss suggestions
     */
    dismiss: () => {
      closeMenu(state);
    },
  }),

  withDeepSelector: false,
  withStableSelector: true,
  withNamespace: "useAutocomplete",
});
