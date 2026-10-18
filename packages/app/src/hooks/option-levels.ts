/**
 * Loading and rendering ONE level of a slash-command option menu.
 *
 * Extracted from `use-autocomplete` so the hook stays a state machine (what mode, which command, what
 * is selected) while this module owns the part with the subtle rules — normalisation, path-prefix
 * filtering, and the async bookkeeping that keeps a late resolver answer from landing in a level the
 * user already left.
 *
 * The level stack lives on the hook's state: `levels[i]` is the rows of the level named by
 * `optionPath.slice(0, i)`, so the two must always satisfy `levels.length === optionPath.length + 1`.
 */

import { withFreeformOption } from "../commands/utils/command-options.js";

import type { AutocompleteState, AutocompleteSuggestion } from "./use-autocomplete.js";
import type { Command, CommandOption } from "../commands";

/** Leave options mode entirely (also invalidates an in-flight level load). */
export function closeMenu(state: AutocompleteState): void {
  state.mode = "commands";
  state.suggestions = [];
  state.selectedIndex = 0;
  state.visible = false;
  state.currentCommand = null;
  state.optionPath = [];
  state.levels = [];
  // A load that is still in flight must not write into the next menu.
  state.loadToken += 1;
}

/** Convert one row into what the list renders. */
export function optionToSuggestion(
  opt: CommandOption,
  command: Command,
  path: readonly string[]
): AutocompleteSuggestion {
  return {
    label: opt.label,
    usage: opt.freeform
      ? `/${command.name} <custom>`
      : `/${[command.name, ...path, opt.value].filter(Boolean).join(" ")}`,
    description: opt.description || "",
    optionValue: opt.value,
    freeform: opt.freeform === true,
    separator: opt.separator === true,
    hasSubmenu: opt.getOptions !== undefined,
    option: opt,
  };
}

/** Append the freeform row for commands that accept typed args. */
function normalizeOptions(command: Command, options: CommandOption[]): CommandOption[] {
  const hasFreeform = options.some((o) => o.freeform);
  if (command.allowCustomInput && !hasFreeform) {
    return withFreeformOption(options);
  }
  return options;
}

/**
 * Filter one level's rows against the text typed after that level's path.
 *
 * `pathPrefix` is the part of the typed text that names the level (`0:gpt-5.1`), so it is stripped
 * before matching — otherwise every row of a submenu would fail to match the text that opened it.
 */
function filterOptions(options: CommandOption[], optionPrefix: string, pathPrefix: string): CommandOption[] {
  // `optionPrefix` is the typed text, already lowercased by the caller; the path keeps the option's
  // spelling (a model id may be `Qwen/Qwen3`). Compare case-insensitively, or descending into a level
  // whose value has an uppercase letter immediately "types past" it and closes the menu.
  const prefix = pathPrefix.toLowerCase();
  const typed = optionPrefix.startsWith(prefix) ? optionPrefix.slice(prefix.length).trim() : optionPrefix;
  const filtered = options.filter((o) => {
    if (o.separator) return !typed; // drop dividers while filtering
    if (o.freeform) return true;
    if (!typed) return true;
    return o.label.toLowerCase().includes(typed) || o.value.toLowerCase().includes(typed);
  });
  const presets = filtered.filter((o) => !o.freeform);
  const freeform = filtered.filter((o) => o.freeform);
  return [...presets, ...freeform];
}

/** Render `options` as the current level, filtered by what the user has typed. */
export function applyOptionsToState(
  state: AutocompleteState,
  command: Command,
  options: CommandOption[],
  optionPrefix: string
): void {
  const path = state.optionPath;
  // `allowCustomInput` describes the command's ROOT arguments (`/cmd <custom>`). A submenu is a
  // closed set — a depth list defines every legal value — so injecting the freeform row there would
  // offer "type custom" where the resolver deliberately said "these are the choices".
  const normalized = path.length === 0 ? normalizeOptions(command, options) : options;
  const filtered = filterOptions(normalized, optionPrefix, path.join(" "));
  state.suggestions = filtered.map((o) => optionToSuggestion(o, command, path));
  // Auto-select default — prefer option with defaultSelected, then first non-freeform
  const defaultIndex = filtered.findIndex((o) => o.defaultSelected && !o.freeform);
  state.selectedIndex = defaultIndex >= 0 ? defaultIndex : Math.min(0, filtered.length - 1);
  state.visible = filtered.length > 0;
}

/**
 * Enter a level: push it on the stack and render it.
 *
 * Returns `false` only when the level is known to be EMPTY — the caller then executes the row as a
 * leaf, so a row that declares a submenu but answers nothing still does the obvious thing instead of
 * stranding the user one level deep with no rows.
 *
 * An ASYNC resolver cannot answer synchronously, so the level is entered optimistically and the
 * continuation is guarded by the load token:
 *
 * - `closeMenu` / a newer load bumps the token, so a late answer after `Esc`, `dismiss`, or a sibling
 *   load is dropped. Without that, `[...state.levels.slice(0, -1), rows]` (positional, not keyed)
 *   would overwrite the PARENT level after a retreat and leave the stack one deeper than the path.
 * - an empty answer retreats instead of leaving an empty level on screen.
 */
export function descend(
  state: AutocompleteState,
  command: Command,
  options: CommandOption[] | Promise<CommandOption[]>,
  path: string[]
): boolean {
  state.loadToken += 1;
  const token = state.loadToken;
  /** Whether this continuation still owns the menu state. */
  const current = () =>
    token === state.loadToken && state.currentCommand === command && state.levels.length === path.length + 1;

  if (options instanceof Promise) {
    state.optionPath = path;
    state.levels = [...state.levels, []];
    options
      .then((rows) => {
        if (!current()) return;
        if (rows.length === 0) {
          // An empty level is not a level: the row is a LEAF. The accept handler already wrote the
          // row's full path into the input (`/cmd <path…>`), so closing the menu leaves exactly that
          // leaf for the next Enter.
          //
          // Restoring the parent was worse than doing nothing visible: the input still named the deeper
          // path, so the parent's first row was displayed as selected while typing re-filtered the list
          // to the row that had just answered empty. Picking a model with no thinking depth then
          // re-descended forever — the model could never be switched.
          closeMenu(state);
          return;
        }
        state.levels = [...state.levels.slice(0, -1), rows];
        applyOptionsToState(state, command, rows, path.join(" "));
        // A resolver that THROWS must not become an unhandled rejection in the input path; the
        // optimistic level stays empty and the user's input still names the row's path, so Enter
        // executes it as a leaf.
      })
      .catch(() => undefined);
    return true;
  }
  if (options.length === 0) return false;
  state.optionPath = path;
  state.levels = [...state.levels, options];
  applyOptionsToState(state, command, options, path.join(" "));
  return true;
}

/** Load a command's root level (`path` = `[]`). */
export function openLevel(state: AutocompleteState, command: Command, optionPrefix: string): void {
  const options = command.getOptions?.(undefined, []);
  state.loadToken += 1;
  const token = state.loadToken;
  if (options instanceof Promise) {
    options
      .then((rows) => {
        if (token !== state.loadToken || state.currentCommand !== command) return;
        state.levels = [rows];
        applyOptionsToState(state, command, rows, optionPrefix);
      })
      .catch(() => undefined);
    return;
  }
  const rows = options ?? [];
  state.levels = [rows];
  applyOptionsToState(state, command, rows, optionPrefix);
}
