/**
 * Native screen + input control for `CoreEnv.computer` (`@codent/node`).
 *
 * The whole capability is one lazily loaded native addon — `@jitsi/robotjs`, whose N-API prebuilds
 * cover linux-x64/arm64, darwin (universal) and win32. It is an **optional** dependency: the probe
 * below runs once at env creation and returns `null` when the addon is missing, when there is no
 * display server (headless CI, a container without `DISPLAY`), or when the OS refuses the connection.
 * `createNodeEnv` then simply omits `env.computer`, so the computer-use extension registers nothing —
 * no degraded half-mode in which the model clicks into a void.
 *
 * Everything here is synchronous (robotjs is), and every failure at CALL time degrades to a thrown
 * `Error` inside the tool, which the model can read — not a crash of the agent loop.
 *
 * Platform notes the user has to know:
 * - macOS: the app running Node needs **Accessibility** (input) and **Screen Recording** (capture).
 *   Screen Recording is detectable (an all-black frame, warned about once); Accessibility is NOT —
 *   the display still reports a size and clicks are dropped by the OS without an error.
 *   A process WITHOUT the permission still reads `getScreenSize` / `getMousePos` / `screenshot`
 *   perfectly, so an experiment run from a plain shell looks like "the addon is broken" (the pointer
 *   never moves). Run such an experiment inside the host process that actually holds the permission.
 *   The coordinate space is the same as `getScreenSize` (logical points): `capture()` returns the
 *   backing store (2x on a Retina panel), while `moveMouse` / `scrollMouse` / `getMousePos` stay in
 *   points — which is why the display scaling in this adapter needs no Retina correction.
 * - Linux: needs X11. Wayland reports a screen but refuses injection, so `getScreenSize()` is the
 *   probe that decides presence here too.
 */
import { errorMessage, truncateText } from "@codent/core";
import { execFile, spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { promisify } from "node:util";

import { encodeScreenPng } from "./png.js";

import type { ScreenBitmap } from "./png.js";
import type {
  CoreEnvComputer,
  CoreEnvComputerActionOptions,
  CoreEnvComputerEnvironment,
  CoreEnvImageRegion,
  CoreEnvMouseButton,
} from "@codent/core";

/** The slice of `@jitsi/robotjs` this adapter uses. */
export interface NodeComputerRobot {
  getScreenSize(): { width: number; height: number };
  getMousePos(): { x: number; y: number };
  moveMouse(x: number, y: number): void;
  mouseClick(button?: string, double?: boolean): void;
  mouseToggle(down?: string, button?: string): void;
  scrollMouse(x: number, y: number): void;
  keyToggle(key: string, down: string): void;
  /**
   * Press `key` with `modifier` attached as the event's flags.
   *
   * The third argument is not optional in spirit: on macOS `keyToggle(key, down)` calls
   * `CGEventSetFlags(event, 0)`, so a modifier "held" by a previous event does not travel with this
   * one. `keyTap` is the only way to express a chord (Cmd+V, Ctrl+A) through this backend.
   */
  keyTap(key: string, modifier?: string | string[]): void;
  typeString(text: string): void;
  /** Linux only: which X display to talk to. Absent on other platforms' builds. */
  setXDisplayName?(name: string): void;
  screen: {
    capture: (x?: number, y?: number, width?: number, height?: number) => ScreenBitmap;
  };
}

export interface CreateNodeComputerOptions {
  /**
   * Model-facing screen size. Defaults to the real screen scaled down to fit
   * {@linkMAX_DISPLAY}; screenshots are captured at the real size and box-filtered down to this.
   */
  display?: { width: number; height: number };
  /** The robot that drives the machine. Defaults to a lazily required `@jitsi/robotjs`. */
  robot?: NodeComputerRobot;
  /**
   * The platform whose INPUT semantics to use. Defaults to `process.platform`.
   *
   * Exposed because the capability is host-supplied (a host may drive another machine's screen) and
   * because the non-ASCII typing channel differs per platform — the matrix is only assertable on a
   * Linux CI if the branch is reachable.
   *
   * It changes typing / scroll units / the reported `environment` only. Presence probing still follows
   * the RUNNING OS, because the native addon is built for it: a host that emulates another platform
   * must still provide a `robot`.
   */
  platform?: NodeJS.Platform;
  /** Writes text to the pasteboard for macOS `type`. Defaults to `pbcopy`. */
  writePasteboard?: (text: string, signal?: AbortSignal) => Promise<void>;
}

/**
 * Biggest screenshot the model ever sees. Bigger captures cost vision tokens for detail the provider
 * downscales anyway; the model's coordinates come back in this space and are scaled up here.
 */
const MAX_DISPLAY = { width: 1280, height: 800 };

/**
 * `KeyboardEvent.key` names whose robotjs spelling is not simply lowercase.
 *
 * Everything else round-trips: single characters stay as they are (`"a"`, `"1"`, `"/"`), and named
 * keys lowercase to the name robotjs knows (`"Enter"` → `"enter"`, `"PageUp"` → `"pageup"`).
 *
 * The aliases are the DOM / Electron spellings models actually send. robotjs matches its table with
 * `strcmp`, so `Return`, `Esc` and `Spacebar` were hard failures ("Invalid key code specified.")
 * with no hint that `enter` / `escape` / `space` were meant — and inside a batch the failure landed
 * after earlier steps had already run. `Cmd` / `Ctrl` / `Option` matter when a modifier is pressed
 * as a KEY rather than carried as a chord flag.
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
  cmd: "command",
  ctrl: "control",
  option: "alt",
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
 * A single character is always accepted: robotjs resolves it through the layout's char→keycode
 * table, which is also why the case is the model's business (`["Shift", "a"]`).
 */
function assertPressable(key: string): string {
  const mapped = toRobotKey(key);
  if (mapped.length === 1 || ROBOT_KEY_NAMES.has(mapped)) return mapped;
  throw new Error(
    `"${key}" is not a key name this host can press. Use a KeyboardEvent.key name — "Enter", ` +
      `"Escape", "Tab", "PageUp", "ArrowUp" — or a single character.`
  );
}

function toRobotButton(button: CoreEnvMouseButton) {
  if (button === "back" || button === "forward") {
    throw new Error(`This computer has no "${button}" mouse button.`);
  }
  return button;
}

/**
 * The modifier names a chord may carry, mapped to the backend's flag spelling.
 *
 * `KeyboardEvent.key` names are what the model sends (`Meta`, `Control`, `Alt`, `Shift`), the
 * backend wants `command` / `control` / `alt` / `shift`, and a few aliases are common enough that
 * rejecting them would just teach the model to retry (`Cmd`, `Option`, `Ctrl`).
 */
const ROBOT_MODIFIERS = new Map<string, string>([
  ["control", "control"],
  ["ctrl", "control"],
  ["shift", "shift"],
  ["alt", "alt"],
  ["option", "alt"],
  ["meta", "command"],
  ["command", "command"],
  ["cmd", "command"],
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

function currentEnvironment(platform: string): CoreEnvComputerEnvironment {
  if (platform === "win32") return "windows";
  if (platform === "darwin") return "mac";
  return "linux";
}

/**
 * robotjs scrolls in pixels on macOS, in whole wheel notches on Linux, and in 120 units per notch on
 * Windows — passing pixels straight through made Linux scroll ~100x too far.
 */
function scrollUnits(pixels: number, platform: string) {
  if (pixels === 0 || platform === "darwin") return pixels;
  const notches = pixels / 100;
  if (platform === "win32") return Math.round(notches * 120);
  return Math.sign(pixels) * Math.max(1, Math.round(Math.abs(notches)));
}

function fitDisplay(screen: { width: number; height: number }) {
  const scale = Math.min(1, MAX_DISPLAY.width / screen.width, MAX_DISPLAY.height / screen.height);
  return { width: Math.round(screen.width * scale), height: Math.round(screen.height * scale) };
}

/** A zoom may be larger than the fit-to-display frame (it exists to read detail) but not unbounded. */
const MAX_ZOOM_PX = 1568;

/** Keep an aspect-correct width under `max`; never upscales. */
function fitWidth(bitmap: ScreenBitmap, max: number) {
  const width = Math.min(bitmap.width, max);
  return { width, height: Math.max(1, Math.round((bitmap.height * width) / bitmap.width)) };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/** Smallest overridden display: below this the screenshot is unreadable and every click collapses. */
const MIN_DISPLAY = 64;

/**
 * The display size to report, from a caller-supplied override when it is sane.
 *
 * A zero/negative/fractional override used to divide by zero (`Infinity` coordinates, which robotjs
 * truncates to 0) or make the PNG encoder throw — an options-validation bug that only shows up as
 * "clicks land in the corner". The override is also bounded at both ends: it is the input to the PNG
 * encoder, so a terabyte frame asked it to allocate terabytes and a 1x1 frame collapsed every click
 * onto (0,0).
 */
function normalizeDisplay(
  requested: { width: number; height: number } | undefined,
  screen: { width: number; height: number }
) {
  if (requested && Number.isInteger(requested.width) && Number.isInteger(requested.height)) {
    // Bounded: the model-facing frame is the input to the PNG encoder, so `{width: 1e6}` asked it to
    // allocate terabytes, and `{width: 1}` collapsed every click onto (0,0).
    const maxWidth = MAX_DISPLAY.width * 4;
    const maxHeight = MAX_DISPLAY.height * 4;
    if (
      requested.width >= MIN_DISPLAY &&
      requested.height >= MIN_DISPLAY &&
      requested.width <= maxWidth &&
      requested.height <= maxHeight
    ) {
      return requested;
    }
  }
  return fitDisplay(screen);
}

/** The live screen size, for callers that must not use a size cached at creation time. */
function currentScreenSize(robot: NodeComputerRobot): { width: number; height: number } | null {
  try {
    const size = robot.getScreenSize();
    return size.width > 0 && size.height > 0 ? size : null;
  } catch {
    return null;
  }
}

/** Require the optional addon at probe time (not at module load) so a missing binary cannot throw. */
function loadRobot(): NodeComputerRobot {
  return createRequire(import.meta.url)("@jitsi/robotjs") as NodeComputerRobot;
}

/**
 * Is there a display server this addon could possibly talk to?
 *
 * `@jitsi/robotjs` is X11-only on Linux, so an absent `DISPLAY` is final — and it must be checked
 * BEFORE the addon loads. The failure mode is not an exception: with no display, `getScreenSize()`
 * dereferences a NULL `Display*` inside the addon and takes the whole process down, so a headless
 * `codent` would die at startup for merely creating its env.
 */
function hasDisplayServer(): boolean {
  if (process.platform === "darwin" || process.platform === "win32") return true;
  return Boolean(process.env.DISPLAY);
}

/** Load the addon in a child and report `WIDTHxHEIGHT`; never returns for a broken display. */
const PROBE_SCRIPT = `
const robot = require(process.argv[1]);
if (process.argv[2] && robot.setXDisplayName) robot.setXDisplayName(process.argv[2]);
const size = robot.getScreenSize();
process.stdout.write(Math.round(size.width) + "x" + Math.round(size.height));
`;

/** A hung X server should cost one startup, not the session. */
const PROBE_TIMEOUT_MS = 5_000;

/**
 * Ask a **child process** whether this machine really has a usable screen.
 *
 * The probe exists because a claimed-but-broken display (stale `DISPLAY=:0` from an ssh session, a
 * stopped X server, Wayland without XWayland) makes the addon's own calls crash the host process
 * rather than throw: nothing on this side can catch that, so presence has to be decided somewhere
 * allowed to die. Same reasoning as the isolate driver's subprocess probe.
 *
 * Memoized per process: the answer is a property of the machine, and a host that builds several envs
 * (ACP builds three) would otherwise pay one blocking subprocess each time.
 */
let probedScreen: { width: number; height: number } | null | undefined;

function probeScreenSize(): { width: number; height: number } | null {
  if (probedScreen !== undefined) return probedScreen;
  probedScreen = runScreenProbe();
  return probedScreen;
}

function runScreenProbe(): { width: number; height: number } | null {
  try {
    const entry = createRequire(import.meta.url).resolve("@jitsi/robotjs");
    const display = process.env.DISPLAY;
    const result = spawnSync(
      process.execPath,
      display ? ["-e", PROBE_SCRIPT, entry, display] : ["-e", PROBE_SCRIPT, entry],
      { encoding: "utf8", timeout: PROBE_TIMEOUT_MS, windowsHide: true }
    );
    if (result.status !== 0) return null;
    const match = /^(\d+)x(\d+)$/.exec((result.stdout ?? "").trim());
    if (!match) return null;
    return { width: Number(match[1]), height: Number(match[2]) };
  } catch {
    return null;
  }
}

/**
 * Point the addon at the display the environment actually names.
 *
 * `XGetMainDisplay()` opens a hardcoded `":0.0"` FIRST and only falls back to `XOpenDisplay(NULL)`
 * (i.e. `$DISPLAY`) when that fails, so on a machine running more than one X server — `DISPLAY=:1`,
 * `ssh -X` (`localhost:10.0`), a nested session — a working `:0.0` silently wins and every capture
 * and click lands on the OTHER screen. Nothing errors; the model just acts on the wrong desktop.
 */
function applyDisplayName(robot: NodeComputerRobot): void {
  if (process.platform !== "linux" || !robot.setXDisplayName) return;
  const display = process.env.DISPLAY;
  if (display) robot.setXDisplayName(display);
}

/**
 * Collapse a capture to a display-sized PNG, warning once when it looks like no pixels arrived.
 *
 * An all-black frame is the one capture failure the host cannot see otherwise: it is a VALID PNG, so
 * the model gets a black rectangle and starts guessing. On macOS it is almost always the missing
 * Screen Recording permission (the OS returns black rather than failing); a locked or asleep display
 * looks identical, which is why the message names both.
 *
 * Only full-screen captures are judged: a dark region zoomed on purpose is legitimate, and the
 * process-wide "warned" flag means one false positive would silence the real warning forever.
 */
function encodeCapture(bitmap: ScreenBitmap, width: number, height: number): Uint8Array {
  return encodeScreenPng(bitmap, width, height);
}

/** Reported once per process: a permission problem repeated per screenshot drowns the log. */
let warnedBlankCapture = false;

/** Does this text contain a code point robotjs' Linux path would truncate? */
function hasNonAscii(text: string): boolean {
  for (const char of text) {
    if ((char.codePointAt(0) ?? 0) > 0x7f) return true;
  }
  return false;
}

/** Outside the BMP: the 16-bit key paths on macOS/Windows cannot carry these. */
function hasAstral(text: string): boolean {
  for (const char of text) {
    if ((char.codePointAt(0) ?? 0) > 0xffff) return true;
  }
  return false;
}

/** `xdotool type` remaps keysyms per character, so it types what robotjs cannot. */
const XDOTOOL_TYPE_TIMEOUT_MS = 15_000;

/** A pasteboard write talks to the window server; a hung one must not hang the turn. */
const PASTEBOARD_TIMEOUT_MS = 5_000;

const execFileAsync = promisify(execFile);

/**
 * Which channel carries non-ASCII text on `platform`.
 *
 * Pure, so the matrix is assertable on any host: the key-event path is what the IME intercepts, and
 * only macOS is in that situation — Windows' `typeString` injects Unicode directly and Linux has
 * xdotool. `refuse` is the astral case on a keyboard-only platform (a 16-bit code unit would type a
 * different character).
 */
export type NonAsciiTypeChannel = "xdotool" | "pasteboard" | "typeString" | "refuse";

export function nonAsciiTypeChannel(platform: string, text: string): NonAsciiTypeChannel {
  if (platform === "linux") return "xdotool";
  if (platform === "darwin") return "pasteboard";
  return hasAstral(text) ? "refuse" : "typeString";
}

/**
 * macOS: write the text to the pasteboard, then paste it with Cmd+V.
 *
 * This is the ONLY reliable channel for CJK and emoji on macOS. `typeString` posts key events, and a
 * focused field with an IME swallows them: a measured session typed "王恒" and the field received
 * "王" — the second character went into the composition window and was dropped. The pasteboard is
 * one text run, so the field receives the whole string and no composition is involved.
 *
 * `pbcopy` is driven from THIS process, not `run_command`: the command tool runs inside the OS
 * sandbox, where the same write failed (`printf '王恒' | pbcopy` → rc=1) because the sandboxed
 * process cannot reach the GUI session's pasteboard server.
 *
 * It REPLACES the user's clipboard content. Restoring it afterwards would be a race (the target app
 * reads the pasteboard asynchronously, and a restore that lands first pastes the wrong text), so the
 * clobber is accepted and documented rather than papered over.
 */
function copyToMacPasteboard(text: string, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let flushed = false;
    let exitCode: number | null | undefined;
    let stderr = "";
    const settle = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve();
    };
    // Both conditions: the write reaching the OS *and* a clean exit. `close(0)` alone can arrive
    // before a slow stdin flush, which would paste an empty/old clipboard and report success.
    const maybeSettle = () => {
      if (exitCode === undefined || !flushed) return;
      settle(
        exitCode === 0
          ? undefined
          : new Error(`pbcopy exited with code ${exitCode}${stderr.trim() ? `: ${stderr.trim()}` : ""}`)
      );
    };
    const child = spawn("pbcopy", [], {
      // stderr is kept: a refused pasteboard server only shows up there, and "code 1" alone is not
      // something the model (or the user) can act on.
      stdio: ["pipe", "ignore", "pipe"],
      ...(signal ? { signal } : {}),
    });
    const timer = setTimeout(() => {
      child.kill();
      settle(new Error(`pbcopy did not finish within ${PASTEBOARD_TIMEOUT_MS}ms`));
    }, PASTEBOARD_TIMEOUT_MS);
    child.once("error", (error) => settle(error));
    child.stderr?.on("data", (chunk) => {
      if (stderr.length < 2_000) stderr += String(chunk);
    });
    // EPIPE when pbcopy exits early (denied, a broken pasteboard): report it instead of an
    // unhandled stream error.
    child.stdin?.on("error", (error) => settle(error));
    child.stdin?.end(text, () => {
      flushed = true;
      maybeSettle();
    });
    child.once("close", (code) => {
      exitCode = code;
      maybeSettle();
    });
  });
}

async function typeViaPasteboard(
  robot: Pick<NodeComputerRobot, "keyTap">,
  write: (text: string, signal?: AbortSignal) => Promise<void>,
  text: string,
  signal?: AbortSignal
): Promise<void> {
  try {
    await write(text, signal);
  } catch (err) {
    if (signal?.aborted) throw err;
    throw new Error(
      `Cannot type non-ASCII text on macOS: writing the pasteboard failed (${errorMessage(err)}). ` +
        `The keyboard path cannot carry it — the field's IME swallows injected characters — so the ` +
        `text has to go through the pasteboard, and nothing else can reach it.`
    );
  }
  // ONE event with the Command flag attached. Two separate events (`command` down, then `v` down)
  // send `v` with flags=0 on macOS — `CGEventSetFlags` is set from the argument, defaulting to none —
  // so the field received a literal "v" instead of a paste.
  robot.keyTap("v", "command");
}

/**
 * Type non-ASCII text on Linux through `xdotool`, or fail with an explanation.
 *
 * Failing loudly is the point: robotjs would type a plausible-looking ASCII string instead, and a
 * model that sees the wrong text appear has no way to tell which layer mangled it. `xdotool` is the
 * same tool Anthropic's reference computer tool uses, and it is an ordinary package (`apt install
 * xdotool`), so the message names the install instead of asking the user to debug.
 *
 * Async on purpose: `spawnSync` would block the event loop for the whole typing burst (SSE
 * keepalives, the transcript) and could not be interrupted by an abort.
 */
async function typeViaXdotool(text: string, signal?: AbortSignal): Promise<void> {
  try {
    // `--clearmodifiers` releases and re-presses whatever is held (xdotool synthesizes the restore),
    // so a held Control does not turn "h" into backspace mid-word. `--` keeps text that starts with
    // "-" from being parsed as an option.
    await execFileAsync("xdotool", ["type", "--clearmodifiers", "--delay", "12", "--", text], {
      timeout: XDOTOOL_TYPE_TIMEOUT_MS,
      windowsHide: true,
      ...(signal ? { signal } : {}),
    });
  } catch (err) {
    if (signal?.aborted) throw err;
    const code = (err as NodeJS.ErrnoException).code;
    const reason = code === "ENOENT" ? "xdotool is not installed" : errorMessage(err);
    throw new Error(
      `Cannot type non-ASCII text on Linux/X11: ${reason}. The bundled input library only types ASCII ` +
        `there. Install xdotool (e.g. \`sudo apt install xdotool\`) to type other languages, or type the ` +
        `text some other way.`
    );
  }
}

/** Sample the frame (cheaply) and report the first all-black capture of this process. */
function warnIfBlank(bitmap: ScreenBitmap): void {
  if (warnedBlankCapture) return;
  const { image, bytesPerPixel } = bitmap;
  const total = bitmap.width * bitmap.height;
  // Every 97th pixel on a real frame: a desktop always has non-black UI somewhere, so a sample is
  // enough and a full scan of a 4K frame on every screenshot is not. Small frames are scanned
  // whole — with the stride they would only ever look at pixel 0.
  const stride = total > 4096 ? 97 : 1;
  for (let i = 0; i < total; i += stride) {
    const offset = i * bytesPerPixel;
    if ((image[offset] ?? 0) > 4 || (image[offset + 1] ?? 0) > 4 || (image[offset + 2] ?? 0) > 4) return;
  }
  warnedBlankCapture = true;
  console.warn(
    "[node] screen capture returned an all-black image. On macOS this means the app running codent " +
      "lacks the Screen Recording permission (System Settings → Privacy & Security → Screen Recording); " +
      "a locked or asleep display looks the same. Screen control may not work until this is granted."
  );
}

/**
 * Create the native computer capability, or `null` when this host cannot drive a screen.
 *
 * **Presence is the capability.** `null` covers every unusable host with one answer — addon not
 * installed, no `DISPLAY`/Wayland session, macOS permission refused — because a partially working
 * screen is worse than none: the model cannot tell a lost click from a slow page.
 */
export function createNodeComputer(options: CreateNodeComputerOptions = {}): CoreEnvComputer | null {
  const platform = options.platform ?? process.platform;
  const writePasteboard = options.writePasteboard ?? copyToMacPasteboard;
  let robot: NodeComputerRobot;
  let screen: { width: number; height: number };

  if (options.robot) {
    // An injected robot IS the host's answer; the probe below only asks about the real machine.
    robot = options.robot;
    try {
      screen = robot.getScreenSize();
    } catch {
      return null;
    }
  } else {
    if (!hasDisplayServer()) return null;
    try {
      // Requiring the addon is safe even without a display; only CALLING into it dereferences the
      // `Display*`, which is why the Linux probe below runs in a child.
      robot = loadRobot();
      applyDisplayName(robot);
    } catch {
      return null;
    }
    if (process.platform === "linux") {
      const probed = probeScreenSize();
      if (!probed) return null;
      screen = probed;
    } else {
      // macOS/Windows return a size or throw, so a subprocess would only add startup latency.
      try {
        screen = robot.getScreenSize();
      } catch {
        return null;
      }
    }
  }

  if (!(screen.width > 0) || !(screen.height > 0)) return null;

  const display = normalizeDisplay(options.display, screen);

  /**
   * The screen size to map coordinates against, read per call.
   *
   * `display` is FIXED (the model's coordinate space and the tool text must not move), and every
   * capture is re-fitted into it — so the image the model looks at always matches `display`. The
   * mapping must therefore follow the LIVE screen: after an undock, a resolution change or a
   * display-scaling change the capture adapts, but a size cached at creation does not, and every
   * click lands at `cached / real` of the point the model picked (half the distance for 1080p → 4K).
   */
  const liveScreen = () => currentScreenSize(robot) ?? screen;

  /** Model display point → real screen point. */
  const toScreen = (x: number, y: number, live: { width: number; height: number } = liveScreen()) => ({
    x: Math.round((x * live.width) / display.width),
    y: Math.round((y * live.height) / display.height),
  });
  /**
   * Real screen point → model display point.
   *
   * Clamped: a screen whose size is not a multiple of `display` (a 2880-wide Retina panel and a
   * 1280-wide display) maps the last pixel to `display.width` after rounding, and the model would be
   * told the pointer sits outside the frame it is looking at.
   */
  const toDisplay = (x: number, y: number, live: { width: number; height: number } = liveScreen()) => ({
    x: clamp(Math.round((x * display.width) / live.width), 0, display.width - 1),
    y: clamp(Math.round((y * display.height) / live.height), 0, display.height - 1),
  });

  const moveTo = (x: number, y: number, live: { width: number; height: number } = liveScreen()) => {
    const point = toScreen(x, y, live);
    robot.moveMouse(point.x, point.y);
  };

  const captureFull = () => {
    const bitmap = robot.screen.capture();
    // Only a full frame is judged: a deliberately dark region (a zoom) is not a permission problem.
    warnIfBlank(bitmap);
    return encodeCapture(bitmap, display.width, display.height);
  };

  return {
    display,
    environment: currentEnvironment(platform),
    // robotjs can target a region (`screen.capture(x, y, w, h)`), so zoom and cursor position are
    // real here rather than left for the model to approximate.
    capabilities: { zoom: true, cursorPosition: true },

    async screenshot(options?: CoreEnvComputerActionOptions) {
      options?.signal?.throwIfAborted();
      try {
        return captureFull();
      } catch {
        return null;
      }
    },

    async zoom(region: CoreEnvImageRegion, options?: CoreEnvComputerActionOptions) {
      options?.signal?.throwIfAborted();
      // Re-read the screen: a laptop that changed resolution (or unplugged a monitor) would
      // otherwise be clamped against the old size and robotjs can crash on an out-of-range capture.
      // The SAME live size maps the region — mixing it with the cached one (clamp live, convert
      // cached) magnified a region the model never asked for.
      const live = liveScreen();
      const start = toScreen(region.x, region.y, live);
      const end = toScreen(region.x + region.width, region.y + region.height, live);
      // robotjs does not validate the region and can crash Node on out-of-screen bounds.
      const x = clamp(start.x, 0, live.width - 1);
      const y = clamp(start.y, 0, live.height - 1);
      const width = Math.max(1, Math.min(end.x, live.width) - x);
      const height = Math.max(1, Math.min(end.y, live.height) - y);
      try {
        const bitmap = robot.screen.capture(x, y, width, height);
        // Detail, not full resolution for its own sake: an uncapped region is re-encoded at 4K and
        // then re-compressed by the tool anyway, which costs hundreds of ms for pixels nobody sees.
        const target = fitWidth(bitmap, MAX_ZOOM_PX);
        return encodeCapture(bitmap, target.width, target.height);
      } catch {
        return null;
      }
    },

    async cursorPosition(options?: CoreEnvComputerActionOptions) {
      options?.signal?.throwIfAborted();
      const position = robot.getMousePos();
      return toDisplay(position.x, position.y);
    },

    async click(x, y, clickOptions) {
      clickOptions?.signal?.throwIfAborted();
      const button = toRobotButton(clickOptions?.button ?? "left");
      const count = Math.max(1, Math.trunc(clickOptions?.count ?? 1));
      moveTo(x, y);
      // robotjs sends a real double click, which macOS needs; a triple click is three singles.
      if (count === 2) robot.mouseClick(button, true);
      else for (let i = 0; i < count; i++) robot.mouseClick(button);
    },

    async move(x, y, moveOptions) {
      moveOptions?.signal?.throwIfAborted();
      moveTo(x, y);
    },

    async mouseDown(button, downOptions) {
      downOptions?.signal?.throwIfAborted();
      robot.mouseToggle("down", toRobotButton(button));
    },

    // No signal: releasing must happen even when the action that pressed aborted.
    async mouseUp(button) {
      robot.mouseToggle("up", toRobotButton(button));
    },

    async scroll(x, y, deltaX, deltaY, scrollOptions) {
      scrollOptions?.signal?.throwIfAborted();
      const live = liveScreen();
      moveTo(x, y, live);
      // macOS scrolls in PIXELS, so a display-space delta must become screen pixels. Linux and
      // Windows scroll in whole wheel notches — LOGICAL units that already describe the gesture:
      // scaling them by the display ratio made the same `delta_y: 100` scroll three times further on
      // a 4K screen than on a 1080p one (same logical desktop, same gesture).
      const delta = platform === "darwin" ? toScreen(deltaX, deltaY, live) : { x: deltaX, y: deltaY };
      // robotjs scrolls right and down for NEGATIVE values.
      robot.scrollMouse(scrollUnits(-delta.x, platform), scrollUnits(-delta.y, platform));
    },

    async keyDown(key, keyOptions) {
      keyOptions?.signal?.throwIfAborted();
      robot.keyToggle(assertPressable(key), "down");
    },

    // No signal, for the same reason as `mouseUp`.
    async keyUp(key) {
      robot.keyToggle(assertPressable(key), "up");
    },

    async press(keys, pressOptions) {
      pressOptions?.signal?.throwIfAborted();
      // A chord is ONE event carrying its modifiers as flags. The old implementation pressed each
      // key as its own event (`keyToggle(mod,"down")` then `keyToggle(key,"down")`), and macOS sets
      // `CGEventSetFlags` from the ARGUMENT — defaulting to none — so a "held" Command never reached
      // the key: Cmd+a typed a literal "a", and a Cmd+V paste typed "v". `keyTap` is the backend's
      // only way to express the flag.
      const { key, modifiers } = splitChord(keys);
      const mapped = assertPressable(key);
      // The second argument must be OMITTED, not passed as `undefined`: robotjs branches on
      // `info.Length()`, so `keyTap(key, undefined)` takes the two-argument path and fails flag
      // validation with "Invalid key flag specified." — every modifier-less key (Escape, Enter, Tab,
      // PageDown, the arrows) threw instead of being pressed.
      if (modifiers.length > 0) robot.keyTap(mapped, modifiers);
      else robot.keyTap(mapped);
    },

    // Core asks this for every `key` entry of a batch before the first step runs. It shares
    // `splitChord` + `assertPressable` with `press`, so "would fail" and "fails" cannot disagree.
    validatePress(keys) {
      const { key } = splitChord(keys);
      assertPressable(key);
    },

    async type(text, typeOptions) {
      typeOptions?.signal?.throwIfAborted();
      // robotjs' X11 path casts each code point to a single `char` (keypress.c: `char ch = value`),
      // so CJK/accents/emoji arrive as the wrong ASCII character — silently. Linux therefore goes
      // through xdotool. macOS/Windows spell BMP code points out properly, but a focused field with
      // an IME still swallows them on macOS (a measured "王恒" arrived as "王"), so macOS goes through
      // the pasteboard instead; both keyboard paths truncate an astral code point (a 16-bit
      // `UniChar` / `wScan`), so a keyboard-path emoji is refused rather than typed as a glyph.
      if (hasNonAscii(text)) {
        const channel = nonAsciiTypeChannel(platform, text);
        if (channel === "xdotool") {
          await typeViaXdotool(text, typeOptions?.signal);
          return;
        }
        if (channel === "pasteboard") {
          await typeViaPasteboard(robot, writePasteboard, text, typeOptions?.signal);
          return;
        }
        if (channel === "refuse") {
          throw new Error(
            `Cannot type "${truncateText(text, 12)}" with the native input backend on ${platform}: ` +
              `it truncates characters outside the Basic Multilingual Plane (emoji), which would type ` +
              `the wrong character. Type ASCII/BMP text instead, or paste it.`
          );
        }
      }
      robot.typeString(text);
    },
  } satisfies CoreEnvComputer;
}
