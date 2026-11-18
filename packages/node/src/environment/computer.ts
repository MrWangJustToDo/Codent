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
 * - Linux: needs X11. Wayland reports a screen but refuses injection, so `getScreenSize()` is the
 *   probe that decides presence here too.
 */
import { errorMessage, truncateText } from "@codent/core";
import { execFile, spawnSync } from "node:child_process";
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
 */
const ROBOT_KEYS: Record<string, string> = {
  ArrowUp: "up",
  ArrowDown: "down",
  ArrowLeft: "left",
  ArrowRight: "right",
  Meta: "command",
  ContextMenu: "menu",
  " ": "space",
};

function toRobotKey(key: string) {
  return ROBOT_KEYS[key] ?? (key.length === 1 ? key : key.toLowerCase());
}

function toRobotButton(button: CoreEnvMouseButton) {
  if (button === "back" || button === "forward") {
    throw new Error(`This computer has no "${button}" mouse button.`);
  }
  return button;
}

function currentEnvironment(): CoreEnvComputerEnvironment {
  if (process.platform === "win32") return "windows";
  if (process.platform === "darwin") return "mac";
  return "linux";
}

/**
 * robotjs scrolls in pixels on macOS, in whole wheel notches on Linux, and in 120 units per notch on
 * Windows — passing pixels straight through made Linux scroll ~100x too far.
 */
function scrollUnits(pixels: number) {
  if (pixels === 0 || process.platform === "darwin") return pixels;
  const notches = pixels / 100;
  if (process.platform === "win32") return Math.round(notches * 120);
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

/**
 * The display size to report, from a caller-supplied override when it is sane.
 *
 * A zero/negative/fractional override used to divide by zero (`Infinity` coordinates, which robotjs
 * truncates to 0) or make the PNG encoder throw — an options-validation bug that only shows up as
 * "clicks land in the corner".
 */
function normalizeDisplay(
  requested: { width: number; height: number } | undefined,
  screen: { width: number; height: number }
) {
  if (requested && Number.isInteger(requested.width) && Number.isInteger(requested.height)) {
    if (requested.width > 0 && requested.height > 0) return requested;
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

const execFileAsync = promisify(execFile);

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

  /** Model display point → real screen point. */
  const toScreen = (x: number, y: number) => ({
    x: Math.round((x * screen.width) / display.width),
    y: Math.round((y * screen.height) / display.height),
  });
  /**
   * Real screen point → model display point.
   *
   * Clamped: a screen whose size is not a multiple of `display` (a 2880-wide Retina panel and a
   * 1280-wide display) maps the last pixel to `display.width` after rounding, and the model would be
   * told the pointer sits outside the frame it is looking at.
   */
  const toDisplay = (x: number, y: number) => ({
    x: clamp(Math.round((x * display.width) / screen.width), 0, display.width - 1),
    y: clamp(Math.round((y * display.height) / screen.height), 0, display.height - 1),
  });

  const moveTo = (x: number, y: number) => {
    const point = toScreen(x, y);
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
    environment: currentEnvironment(),
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
      const live = currentScreenSize(robot) ?? screen;
      const start = toScreen(region.x, region.y);
      const end = toScreen(region.x + region.width, region.y + region.height);
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
      moveTo(x, y);
      const delta = toScreen(deltaX, deltaY);
      // robotjs scrolls right and down for NEGATIVE values.
      robot.scrollMouse(scrollUnits(-delta.x), scrollUnits(-delta.y));
    },

    async keyDown(key, keyOptions) {
      keyOptions?.signal?.throwIfAborted();
      robot.keyToggle(toRobotKey(key), "down");
    },

    // No signal, for the same reason as `mouseUp`.
    async keyUp(key) {
      robot.keyToggle(toRobotKey(key), "up");
    },

    async press(keys, pressOptions) {
      pressOptions?.signal?.throwIfAborted();
      const pressed: string[] = [];
      try {
        for (const key of keys) {
          const name = toRobotKey(key);
          robot.keyToggle(name, "down");
          pressed.push(name);
        }
      } finally {
        // Release what went down even when a later key was invalid — otherwise the user's
        // keyboard is left with a modifier held.
        for (const name of pressed.reverse()) robot.keyToggle(name, "up");
      }
    },

    async type(text, typeOptions) {
      typeOptions?.signal?.throwIfAborted();
      // robotjs' X11 path casts each code point to a single `char` (keypress.c: `char ch = value`),
      // so CJK/accents/emoji arrive as the wrong ASCII character — silently. Linux therefore goes
      // through xdotool. macOS/Windows spell BMP code points out properly, but both truncate an
      // astral one (a 16-bit `UniChar` / `wScan`), so an emoji would arrive as a private-use glyph:
      // refuse it there instead of typing the wrong character.
      if (hasNonAscii(text)) {
        if (process.platform === "linux") {
          await typeViaXdotool(text, typeOptions?.signal);
          return;
        }
        if (hasAstral(text)) {
          throw new Error(
            `Cannot type "${truncateText(text, 12)}" with the native input backend on ${process.platform}: ` +
              `it truncates characters outside the Basic Multilingual Plane (emoji), which would type ` +
              `the wrong character. Type ASCII/BMP text instead, or paste it.`
          );
        }
      }
      robot.typeString(text);
    },
  } satisfies CoreEnvComputer;
}
