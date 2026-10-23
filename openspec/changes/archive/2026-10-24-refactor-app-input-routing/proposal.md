## Why

`@my-react/react-terminal`'s `useInput` **broadcasts**: every subscribed handler is called for every chunk, the handler's return value is discarded, there is no `stopPropagation`, and registration order is not stable (an inline handler re-subscribes on each render). The only exclusivity primitive it offers is `isActive`, which removes the listener entirely.

The app works around that with convention instead of structure:

- `useAgentInputControls()` runs in `Agent` **before** the early returns that swap in a panel, so all five central handlers (`global`, `normal`, `approval`, `select`, `freeform`) stay subscribed on the workspace, task, extension, config-wizard and resume-picker screens. Each one has to remember `if (isAnyPanelOpen()) return;`.
- Because a panel can close on the very keystroke it receives, `context.ts` keeps a `lastClosedAt` + `CLOSE_DEBOUNCE_MS` (300 ms) debounce so the *same* Esc does not also abort a run. That is a timing patch over a structural problem.
- Sub-surfaces repeat the pattern by hand: `WorkspaceFileMode` early-returns while `quickOpen` is set, `ConfigEditor` stops handling keys on text steps so `TextInput` can, `SubagentPanel` relies on rendering either the list or the detail.
- `TextInput` is a shared component that registers its own `useInput` with only `disabled` as a gate.

Every new panel, overlay or mode adds another guard that the next handler must not forget. The failure mode is silent: the wrong surface acts on a key, and nothing fails until a user reports it.

## What Changes

- **One scope per screen.** A surface declares itself by wrapping its subtree (`InputScope`), and its handlers are registered only from inside that scope. `Agent`'s panel branches and the chat branch each get exactly one scope; the config wizard and the resume picker are whole-tree swaps of the chat screen and therefore occupy the `main` scope.
- **Four named hooks replace every raw `useInput` in `packages/app/src`:** `useMainInput`, `useWorkspacePanelInput`, `useTaskPanelInput`, `useExtensionPanelInput`. They share one primitive (`useSurfaceInput`) that turns the scope plus a `when` predicate into `isActive`. Raw `useInput` remains allowed only inside that primitive.
- **A handler that names a surface other than its scope is inert**, not merely discouraged: the hook never subscribes. Declaring a `main` handler inside the workspace screen cannot leak.
- **Sub-surface exclusivity becomes the only kind of guard.** Mode (`normal` / `approval` / `select` / `freeform`), `quickOpen`, subagent `list` vs `detail`, and the wizard's text step are expressed as `when` predicates on the surface hook. A handler MUST NOT inspect another screen's store to decide whether to run.
- **Delete the cross-surface machinery**: `isAnyPanelOpen()`, `panelJustClosed()`, `PANEL_SURFACES`, and the per-panel `lastClosedAt` / `CLOSE_DEBOUNCE_MS` pair. The close-on-the-same-keystroke race disappears because Node's `EventEmitter` snapshots its listener list at emit time: a chat handler mounted by the panel's close never receives that keystroke.
- **Split input registration from state sync.** `useAgentInputControls` keeps the effects that must run regardless of screen (approval/`ask_user` mode switching, `clientToolWaiting`, loading, initial prompt) and returns the keybinding context; a chat-scope component registers the five mode handlers. Approvals that arrive while a panel is open keep working.
- **Structural checks**: a validator asserts no raw `useInput` outside the primitive, no `isAnyPanelOpen`/`panelJustClosed` call sites, every surface hook under a matching scope, and at most one active sub-surface per surface; the app suite asserts the activation rule and the emit-snapshot race.

## Impact

- Affected specs: **new capability** `app-input-routing`.
- Affected code: `packages/app/src/app/Agent.tsx`, `packages/app/src/hooks/input/*` (new), `hooks/use-agent-input-controls.ts`, `hooks/use-agent-keybindings.ts`, `hooks/keybindings/{context,global,normal,approval,select,freeform}.ts`, `components/{WorkspaceFileMode,WorkspaceQuickOpen,ExtensionPanel,SubagentListPanel,SubagentDetailPanel,ConfigEditor,TextInput,SessionPicker}.tsx`, `hooks/use-{workspace,subagent,extension}-panel.ts` and `hooks/use-config-editor.ts` (drop `lastClosedAt` / `CLOSE_DEBOUNCE_MS`).
- User-visible behavior is unchanged except where it was wrong: a key no longer reaches a surface that is not on screen.
- Hosts (`cli`, `codent`, `playground`, `extension`) need no change; the app export surface gains the four hooks for hosts that compose their own screen.
