/**
 * The app's only `useInput` call site.
 *
 * `@my-react/react-terminal` broadcasts every chunk to every subscribed handler: the return value is
 * discarded, there is no `stopPropagation`, and the registration order is not stable (an inline
 * handler re-subscribes on each render). `isActive` is the one exclusivity primitive it offers —
 * `false` skips the subscription entirely.
 *
 * So exclusivity is structural rather than conventional: a handler names its surface, the surface
 * comes from the screen that renders it, and a handler whose name does not match its scope is never
 * subscribed. Nothing else has to remember an early return.
 */

import { useInput } from "ink";

import { useInputScope } from "../../context/input-scope-context.js";

import type { InputSurface } from "../../context/input-scope-context.js";
import type { Key } from "ink";

export type InputHandler = (input: string, key: Key) => void;

/**
 * The activation rule, kept pure so it can be asserted without a terminal.
 *
 * A handler runs only if the screen that rendered it is the surface it named, and its sub-surface
 * is up. `null` scope (rendered outside any screen) means "inert", never "active everywhere".
 */
export function isSurfaceActive(scope: InputSurface | null, surface: InputSurface, when?: boolean): boolean {
  return scope === surface && when !== false;
}

/**
 * Register `handler` for the `surface` it belongs to.
 *
 * `when` is the sub-surface gate *within* one surface — the input mode, `quickOpen`, the subagent
 * panel's list-vs-detail view, the config wizard's text step. At most one sub-surface of a surface
 * may be active for a keystroke; reading another surface's state to decide is the pattern this
 * module removes.
 *
 * @example
 * // Workspace panel: the file tree stops handling keys while quick open is up.
 * useWorkspacePanelInput(handler, { when: !quickOpen });
 */
export function useSurfaceInput(surface: InputSurface, handler: InputHandler, options?: { when?: boolean }): void {
  const scope = useInputScope();
  useInput(handler, { isActive: isSurfaceActive(scope, surface, options?.when) });
}

/**
 * Register a handler that is deliberately *not* surface-scoped.
 *
 * Exactly one chord needs this: the process exit. Quitting is not a screen's concern, so it must
 * work with a panel, the config wizard or the resume picker on screen — before this change the
 * always-subscribed global handler happened to provide that, and moving the handlers onto their
 * screens made Ctrl+C a no-op everywhere but the chat.
 *
 * A handler here must match a chord no surface handler claims (`ctrl+c`), because the renderer's
 * broadcast means both would run. It is kept in this module so `useInput` still has one call site.
 */
export function useUnscopedInput(handler: InputHandler): void {
  useInput(handler, { isActive: true });
}
