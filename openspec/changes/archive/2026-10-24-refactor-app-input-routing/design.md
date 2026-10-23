## Context

The renderer's input contract (verified against `@my-react/react-terminal@0.0.31`, `dist/esm/index.mjs` for the Node entry and `web.mjs` for the browser entry):

| Property | Consequence for this change |
|---|---|
| `useInput(handler, { isActive })` only; `isActive === false` skips the subscription entirely (`index.mjs:28120`) and never enables raw mode | `isActive` is the single exclusivity primitive — the wrapper is built on it |
| `emit("input", chunk)` on a Node `EventEmitter` (`index.mjs:850`) calls **every** listener | Without a gate, all handlers see every key |
| Handler return value discarded (`index.mjs:28188`), no `stopPropagation`, no priority | A handler cannot claim a key; only the subscription set can |
| Inline handlers re-subscribe per render (effect depends on `inputHandler`) | Listener order is not a basis for design |
| `handleInput` runs before `emit` and does not prevent it | Global Ctrl+C/Esc/Tab handling is not an arbitration layer |

Current structure: `Agent.tsx` swaps the whole screen in (`WorkspacePanel` / `SubagentPanel` / `ExtensionPanel` / chat), but `useAgentInputControls()` is called before those early returns, so the five central handlers remain subscribed on every screen and rely on `isAnyPanelOpen()`; `context.ts` adds a 300 ms `lastClosedAt` debounce so the keystroke that closes a panel is not handled twice.

Scene inventory (surfaces and their screens):

| Surface | Screen | Handlers today |
|---|---|---|
| `main` | chat (Content + Footer + PlanReadyBanner + ExitSummary); also fills the slot when the config wizard (`ConfigEditorOverlay`) or resume picker (`SessionResumePicker`) swaps the tree | `keybindings/{global,normal,approval,select,freeform}.ts`; `ConfigEditor` + `TextInput` on the wizard; `SessionPicker` on the picker |
| `workspace` | `WorkspacePanel` → `WorkspaceFileMode` (+ `WorkspaceQuickOpen` overlay) | `WorkspaceFileMode` (guards `quickOpen`), `WorkspaceQuickOpen` |
| `task` | `SubagentPanel` → list or detail | `SubagentListPanel`, `SubagentDetailPanel` |
| `extension` | `ExtensionPanel` | `ExtensionPanel` |

## Goals / Non-Goals

**Goals**

- A keystroke reaches the handlers of exactly one surface, and within it exactly one sub-surface.
- Adding a panel or mode cannot re-introduce leakage by forgetting a guard: the wrong declaration is inert, and a validator fails.
- Delete the timing patch (`lastClosedAt` / `CLOSE_DEBOUNCE_MS` / `panelJustClosed`) rather than keep it in a new place.
- Keep behavior identical where it was already correct, including the `Ctrl+T` / `Ctrl+Y` / `Ctrl+E` panel toggles and the Esc cascade inside the chat.

**Non-Goals**

- No new keybindings, no re-mapping of existing keys, no configurable keymaps.
- No change to how panels render (`PanelOverlay` stays), page sizing, or the action stores.
- No attempt to give the renderer a `stopPropagation`-style arbitration: the dependency stays untouched, the app stops depending on broadcast semantics instead.
- No touch of `packages/core`; input is an app concern.

## Decisions

### D1. The scope is a component, not a store lookup

Each screen renders its subtree inside `<InputScope surface="…">`; `useSurfaceInput` reads the nearest scope and subscribes only when `scope.surface === surface` and `when !== false`.

Why not derive ownership from the panel stores (a `isAnyPanelOpen`-style table with a better name)? Because that table *is* the thing that drifted: it has to list every screen, and a screen missing from it leaks. With a scope, the declaration lives where the screen is rendered, and there is no second list to keep in sync. It also makes an impossible combination impossible: a `main` handler inside the workspace screen is inert even if the workspace screen forgets to unmount something.

Only one surface is mounted at a time (the panel branches are full swaps), so the scope and mount isolation agree today; the scope is what keeps that true when a future screen is rendered as a true overlay.

### D2. Four hooks, one primitive, no fifth category

`useMainInput`, `useWorkspacePanelInput`, `useTaskPanelInput`, `useExtensionPanelInput` are thin aliases over `useSurfaceInput(surface, handler, when?)`. The config wizard and the resume picker use `useMainInput` because they *are* the main screen while they are up — the chat is not mounted then, so they cannot collide with the chat's five mode handlers.

Keeping the count at four is a design constraint, not a naming preference: a fifth category would mean a fifth screen class, and the point of the change is that screens are enumerable. `TextInput` (only used by the wizard's text steps) also registers through `useMainInput` with `when` set by its step owner.

### D3. `when` is the only sub-surface gate

`isActive = (scope?.surface === surface) && when !== false`. Sub-surfaces pass their own predicate:

| Surface | `when` |
|---|---|
| main | `mode === "normal" \| "approval" \| "select" \| "freeform"` (one per handler) |
| workspace | `!quickOpen` for the file/diff view, `quickOpen` for the quick-open overlay |
| task | `view === "list"` / `view === "detail"` |
| extension | always |
| main (wizard) | `!isTextStep` for the wizard's navigation handler; `isTextStep && !disabled` for `TextInput` |

`when` may only read the state of the surface it belongs to. Reaching into another screen's store is exactly the pattern being removed, so the validator rejects a surface hook whose `when` reads a different panel's readonly state.

### D4. Input registration follows the screen; state sync does not

`useAgentInputControls` mixes two jobs. Only one of them is screen-bound:

- **screen-bound** — the five `keybindings/*` handlers. They move to a `ChatKeybindings` component rendered inside the chat's `InputScope`, receiving the context that `useAgentInputControls` now returns.
- **screen-independent** — approval/`ask_user` mode switching, `setClientToolWaiting`, `setLoading`, the initial prompt submit, `commandCtx`, submit handlers. They stay in `useAgentInputControls` at `Agent` level so an approval arriving while a panel is open still updates mode and the select store.

The split is asserted: the validator fails if `useAgentKeybindings` is called outside a `main` scope, or if `useAgentInputControls` still calls it.

### D5. The close-on-the-same-keystroke race is closed structurally

`panelJustClosed()` existed because a panel's own handler could close it before a later handler read the store, so "is it open" was already false for the same keystroke. With D1 the chat handlers are not subscribed at that moment; they subscribe during the render that follows the panel's close. Node's `EventEmitter` clones its listener array at emit time, so a listener added mid-emit never receives the in-flight chunk. The app suite asserts that property directly (a handler mounted by another handler's state change does not see that key) instead of asserting a debounce window.

Removing `lastClosedAt` / `CLOSE_DEBOUNCE_MS` from `use-workspace-panel`, `use-subagent-panel`, `use-extension-panel` and `use-config-editor` is part of the change; a leftover export fails the validator.

### D6. What stays exactly as-is

- Key semantics: `Ctrl+C`, `Ctrl+U`, `Ctrl+A`, `Ctrl+V`, `Ctrl+T`, `Ctrl+Y`, `Ctrl+E`, `Ctrl+P`, `Ctrl+O`, `Ctrl+Q`, `Shift+Tab`, `Tab`, `Esc` cascades, `y` / `n` approval, arrows, `+`/`-`/`0` zoom, `]`/`[` hunk jumps.
- The stores' shapes minus the removed fields, and the Esc "hide plan preview / accept autocomplete / dismiss command output / stop run" order inside `main`.
- `Agent`'s screen selection order (workspace → task → extension → chat) and the early returns for the wizard and picker.

## Risks / Trade-offs

- **A miss in the `when` predicate now means *nothing* handles the key**, where a missed guard used to mean *two* did. A dropped key is more visible than a stale one, and the smoke/validator cover the common screens; both failure modes are still failures.
- **`useMainInput` for the wizard and picker** reads oddly at first. The alternative is a fifth hook whose only purpose is to name two screens that already replace the main one.
- **React batching**: the wrapper depends on state changes flushing before the next chunk arrives. Ink delivers chunks one at a time and flushes in `batchedUpdates`; the app suite asserts the ordering rather than assuming it.
- **Raw-mode dependency**: when every handler is inactive the renderer disables raw mode entirely. Each screen has at least one active handler, so this is not reachable; it is worth a comment because it makes a wrong scope declaration fail loudly (keys stop arriving) instead of subtly.

## Implementation Notes (what the plan did not anticipate)

1. **Esc needed exactly one owner on the wizard's text steps.** `ConfigEditor` answered Esc on
   every step, and `TextInput` was mounted with no `onEscape`, so the key was delivered to both and
   only one of them acted. The split is now literal: the wizard's handler is off on text steps and
   `TextInput` receives `onEscape={onCancel}`, so the same behavior (Esc cancels from any step) has
   one handler per step. `saving` stayed an in-handler early return rather than part of `when` — it
   is a "nothing should happen right now" state, not a sub-surface, and keeping the handler
   subscribed keeps raw mode on while the save is in flight.

2. **Inert-outside-a-scope is observable, and the smoke felt it first.** `SubagentPanel` and
   `SessionPicker` are mounted directly by `render-smoke`; with no `InputScope` their handlers never
   subscribed, so seven existing frame/key checks failed the moment the wrapper landed. The fix is
   the contract working as designed — every mount that registers input declares a surface — and the
   harness now wraps those mounts (`task` / `main`).

3. **`Ctrl+E` lost its "toggle".** It read `useWorkspacePanel.view` to decide open-vs-close, which is
   a main-surface handler inspecting another surface's state. On the main screen the panel is closed
   by definition, so the branch is `open()`; `Ctrl+Y` likewise opens the extension panel.

4. **`test/panel-keyboard.test.mjs` was deleted**, not rewritten: its only subjects were
   `isAnyPanelOpen` / `panelJustClosed`. Its two properties survive as
   `test/input-routing.test.mjs` (activation matrix + emit snapshot) and the smoke's routing section,
   which asserts them through the real hooks and the real renderer.

5. **Listener order is not a contract.** The first version of the smoke's race check asserted
   `first,second`; the renderer re-subscribes an inline handler on every render, so the observed order
   was `second,first`. The check now asserts the *set* of handlers that fire, which is the property
   the design relies on.

## Review Findings (three read-only passes over the finished change)

The refactor moved `useInput` subscriptions onto the screens that own them. That is correct for
*keys a screen answers*, and it silently removed two things an always-subscribed handler had been
providing for free. Both were found by review and are fixed here.

1. **The first-run config wizard became keyboard-dead (blocking).** `packages/cli/src/host.tsx`'s
   `Bootstrap()` renders `<ConfigEditor>` directly — outside `Agent`, therefore outside every
   `InputScope`. With the scope model, `useInput` never subscribed and the renderer never enabled raw
   mode, so a fresh install could not be configured at all, and `codent` inherits the same host. The
   host now wraps it in `InputScopeProvider value="main"`. Mirrored in `validate:input-routing`
   (rule 7: a host that renders an input-owning screen must provide its scope) and in the smoke,
   which mounts `ConfigEditor` in a scope and asserts a keypress moves the style cursor.

2. **Ctrl+C stopped working outside the chat.** `HEAD`'s panel guard deliberately let `ctrl`/`meta`
   through (`if (isAnyPanelOpen() && !inputKey.ctrl && !inputKey.meta) return`), and the CLI runs with
   `exitOnCtrlC: false`, so the app's own handler was the only way out. Restricting the handlers to
   their screens deleted that path. Exiting is not a screen's concern, so it now has its own
   counter-example to the surface model: `useExitInput` (`hooks/input/use-exit-input.ts`), registered
   by `Agent` before its early returns, matching `ctrl+c` only. `keybindings/global.ts` no longer
   answers `ctrl+c`, so there is still exactly one owner.

3. **The panel toggles lost their close half.** `Ctrl+E` / `Ctrl+Y` / `Ctrl+T` opened the panels from
   the chat; with the chat as their only registration site they could no longer close, while
   `workspacePanelHint()` still printed `Ctrl+E/Esc close` in the panel footer. Each panel now answers
   its own chord (the task detail returns to the list), which follows the surface rule rather than
   punching a hole in it: the screen that is up owns the key.

4. **`approval` answered `y` for `Ctrl+Y`.** The renderer maps a control byte to its letter
   (`\x19` → `name: "y", ctrl: true`), so the unguarded `y` branch approved a pending tool on the
   same keystroke that opened the extension panel. It was order-dependent before this change (the
   old panel guard masked it most of the time); with both handlers always subscribed on the chat it
   became deterministic. `y` / `n` now ignore `ctrl`/`meta`, matching `keybindings/normal.ts`.

5. **The task list's `when` disagreed with its render condition.** `SubagentPanel` renders the list
   unless `view === "detail" && selectedSubagentId`; the gate was `view === "list"`, so a transient
   `detail`-without-id state would have shown a list with dead keys. Both now use the same predicate.

6. **The validator's delegation rule was checking nothing.** `ownFile` was assembled with a doubled
   `-input` suffix (`use--workspace-panel-input-input.ts`), so for three of the four hooks the check
   was skipped entirely — changing `useWorkspacePanelInput` to delegate to `"main"` passed. Caught by
   mutation testing the rule; fixed, and re-verified by the same mutation. Two other rules were
   strengthened the same way: the scope check now walks nested providers (a single `main` provider
   around the whole tree re-creates the original bug and used to pass), and comment stripping
   preserves line numbers and no longer treats a `/*` inside a string as a comment opener.
