/**
 * The backend's keyboard vocabulary: model-facing key names → robotjs names, and chord splitting.
 *
 * Nothing here touches the screen, the platform or the addon, so it is a module of its own: the
 * tables are long, and `computer.ts` is a driver. The aliases mirror the official TanStack computer
 * tool's `keys.ts` (the OpenAI/xdotool spellings) plus the DOM/Electron names models actually send.
 */

/**
 * `KeyboardEvent.key` names whose robotjs spelling is not simply lowercase.
 *
 * Everything else round-trips: single characters stay as they are (`"a"`, `"1"`, `"/"`), and named
 * keys lowercase to the name robotjs knows (`"Enter"` → `"enter"`, `"PageUp"` → `"pageup"`).
 *
 * The aliases are the DOM / Electron spellings models actually send, plus the OpenAI/xdotool
 * spellings the official TanStack computer tool normalizes (`page_up` / `prior`, `kp_enter`,
 * `caps_lock`, side-suffixed modifiers). robotjs matches its table with `strcmp`, so `Return`, `Esc`
 * and `Spacebar` were hard failures ("Invalid key code specified.") with no hint that `enter` /
 * `escape` / `space` were meant — and inside a batch the failure landed after earlier steps had
 * already run. `Cmd` / `Ctrl` / `Option` matter when a modifier is pressed as a KEY rather than
 * carried as a chord flag.
 */
const ROBOT_KEYS: Record<string, string> = {
  arrowup: "up",
  arrowdown: "down",
  arrowleft: "left",
  arrowright: "right",
  meta: "command",
  contextmenu: "menu",
  " ": "space",
  return: "enter",
  esc: "escape",
  spacebar: "space",
  del: "delete",
  ins: "insert",
  pgup: "pageup",
  pgdn: "pagedown",
  page_up: "pageup",
  page_down: "pagedown",
  prior: "pageup",
  next: "pagedown",
  kp_enter: "enter",
  caps_lock: "capslock",
  control_l: "control",
  control_r: "control",
  shift_l: "shift",
  shift_r: "shift",
  alt_l: "alt",
  alt_r: "alt",
  meta_l: "command",
  meta_r: "command",
  super_l: "command",
  super_r: "command",
  cmd: "command",
  ctrl: "control",
  option: "alt",
  super: "command",
  win: "command",
  // `KeyboardEvent.key` spells this one `NumLock`, and the backend's name lives in the `numpad_`
  // family — without the alias it was refused as an unknown name, since "numlock" is neither a
  // one-character key nor a table entry.
  numlock: "numpad_lock",
};

function toRobotKey(key: string) {
  // Keyed lowercase: robotjs is case-sensitive, and `Return` / `return` must reach the same alias.
  return ROBOT_KEYS[key.toLowerCase()] ?? (key.length === 1 ? key : key.toLowerCase());
}

/**
 * The key names the backend accepts, mirrored from robotjs' `key_names` table.
 *
 * robotjs validates a name at the call and exposes no query API, so knowing the table is the only
 * way to fail before an event is posted — and to answer core's batch preflight. It is pinned with
 * the addon (`@jitsi/robotjs` 0.6.24); a name added upstream is a one-word addition here.
 */
const ROBOT_KEY_NAMES = new Set(
  (
    "backspace delete enter tab escape up down right left home end pageup pagedown " +
    "capslock command alt right_alt control left_control right_control shift right_shift space " +
    "printscreen insert menu audio_mute audio_vol_down audio_vol_up audio_play audio_stop " +
    "audio_pause audio_prev audio_next audio_rewind audio_forward audio_repeat audio_random " +
    "numpad_lock numpad_0 numpad_1 numpad_2 numpad_3 numpad_4 numpad_5 numpad_6 numpad_7 " +
    "numpad_8 numpad_9 numpad_+ numpad_- numpad_* numpad_/ numpad_. " +
    "lights_mon_up lights_mon_down lights_kbd_toggle lights_kbd_up lights_kbd_down " +
    Array.from({ length: 24 }, (_, index) => `f${index + 1}`).join(" ")
  ).split(" ")
);

/**
 * Map one key name, or throw before anything is pressed.
 *
 * A single ASCII character is accepted: robotjs resolves it through the layout's char→keycode table,
 * which is also why the case is the model's business (`["Shift", "a"]`). The check is `strlen(k) == 1`
 * in the addon — BYTES, not code units — so a non-ASCII character ("é") is not a single-byte key
 * name and must be refused here instead of at the step that carries it.
 */
function assertPressable(key: string): string {
  const mapped = toRobotKey(key);
  if (mapped.length === 1) {
    if (mapped.charCodeAt(0) < 0x80) return mapped;
  } else if (ROBOT_KEY_NAMES.has(mapped)) {
    return mapped;
  }
  throw new Error(
    `"${key}" is not a key name this host can press. Use a KeyboardEvent.key name — "Enter", ` +
      `"Escape", "Tab", "PageUp", "Meta" — or a single ASCII character; non-ASCII text goes ` +
      `through "type", not "key".`
  );
}

/**
 * The modifier names a chord may carry, mapped to the backend's flag spelling.
 *
 * `KeyboardEvent.key` names are what the model sends (`Meta`, `Control`, `Alt`, `Shift`), the
 * backend wants `command` / `control` / `alt` / `shift`, and a few aliases are common enough that
 * rejecting them would just teach the model to retry (`Cmd`, `Option`, `Ctrl`). The side-suffixed
 * and xdotool/OpenAI spellings are the same set the official TanStack computer tool normalizes
 * (`@tanstack/ai-computer-use`'s `keys.ts`), so a model trained on those names works here too.
 */
const ROBOT_MODIFIERS = new Map<string, string>([
  ["control", "control"],
  ["ctrl", "control"],
  ["control_l", "control"],
  ["control_r", "control"],
  ["left_control", "control"],
  ["right_control", "control"],
  ["shift", "shift"],
  ["shift_l", "shift"],
  ["shift_r", "shift"],
  ["left_shift", "shift"],
  ["right_shift", "shift"],
  ["alt", "alt"],
  ["option", "alt"],
  ["alt_l", "alt"],
  ["alt_r", "alt"],
  ["meta", "command"],
  ["command", "command"],
  ["cmd", "command"],
  ["meta_l", "command"],
  ["meta_r", "command"],
  ["super", "command"],
  ["super_l", "command"],
  ["super_r", "command"],
  ["win", "command"],
]);

/**
 * Split `["Control", "Shift", "a"]` into the key and its modifier flags.
 *
 * Leading entries must be modifiers: `press(["a", "b"])` is not a chord, and passing `"a"` as a
 * backend flag throws a message about an "Invalid key flag" that tells the model nothing.
 */
function splitChord(keys: string[]): { key: string; modifiers: string[] } {
  if (keys.length === 0) throw new Error("A key press needs at least one key name.");
  const modifiers: string[] = [];
  for (let index = 0; index < keys.length - 1; index += 1) {
    const source = keys[index]!;
    const mapped = ROBOT_MODIFIERS.get(source.trim().toLowerCase());
    if (!mapped) {
      throw new Error(
        `"${
          source
        }" is not a modifier: a chord is modifier names (Control / Shift / Alt / Meta) followed by ONE key, e.g. ["Control", "a"].`
      );
    }
    modifiers.push(mapped);
  }
  return { key: keys[keys.length - 1]!, modifiers };
}

export { assertPressable, splitChord };
