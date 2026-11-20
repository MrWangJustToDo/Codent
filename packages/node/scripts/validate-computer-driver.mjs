/**
 * The native computer driver: capture → PNG, and model-space coordinates → real screen pixels.
 *
 * Everything is asserted through an **injected fake robot**, which is the whole point: the machine
 * running this test has no display (CI, containers), and `@jitsi/robotjs` cannot even open one
 * there. The two halves that can break silently are covered:
 *
 * - **The PNG encoder.** `robotjs` hands back raw BGRA, so a channel swap or a wrong row length
 *   produces a valid-looking file whose colors are wrong or whose image is sheared. The check
 *   inflates the IDAT stream and reads exact bytes instead of trusting the header.
 * - **The coordinate mapping.** The model sees `display` (≤1024×800) and the OS sees the physical
 *   screen; if the driver stops scaling, every click lands at the wrong place, which looks like a
 *   slow app rather than a bug.
 *
 * Plus the degradation contract: no display ⇒ `null` ⇒ `createNodeEnv` omits `computer` ⇒ the
 * computer-use extension is never loaded.
 *
 * Run: pnpm --filter @codent/node run validate:computer-driver
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { inflateSync } from "node:zlib";

import {
  createNodeComputer,
  createNodeEnv,
  encodeScreenPng,
  nonAsciiTypeChannel,
  typeChannel,
} from "../dist/index.mjs";

/** Reported distinctly from a pass — a shrunken run must not read as a green one. */
const SKIP_MARKER = "[validator-skip]";

// ============================================================================
// PNG encoding
// ============================================================================

/** Parse a PNG far enough to check its structure and read the pixels back. */
function readPng(bytes) {
  const buffer = Buffer.from(bytes);
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  for (let i = 0; i < signature.length; i++) {
    assert.equal(buffer[i], signature[i], "PNG signature");
  }

  let offset = 8;
  let width = 0;
  let height = 0;
  const idat = [];
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString("latin1", offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    // The CRC is what a decoder validates FIRST. A hand-written table that is wrong produces a file
    // whose signature, chunk layout, dimensions and pixels all read correctly here and are rejected
    // by every real decoder — exactly the "valid-looking" failure this suite exists to catch.
    assert.equal(
      buffer.readUInt32BE(offset + 8 + length),
      crc32(buffer.subarray(offset + 4, offset + 8 + length)),
      `${type} chunk CRC`
    );
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      assert.equal(data[8], 8, "8 bits per channel");
      assert.equal(data[9], 2, "RGB, no alpha");
    } else if (type === "IDAT") {
      idat.push(data);
    } else if (type === "IEND") {
      offset += 12 + length;
      continue;
    }
    offset += 12 + length;
  }

  const rows = inflateSync(Buffer.concat(idat));
  assert.equal(rows.length, height * (1 + width * 3), "one filter byte plus three channels per pixel");
  return { width, height, rows };
}

/** Real CRC-32 (as PNG spells it): bitwise reference, deliberately not the encoder's table. */
const CRC_TABLE = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** A raw BGRA bitmap, the shape `robotjs.screen.capture()` returns. */
function bitmap(width, height, pixel) {
  const image = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b] = pixel(x, y);
      const i = (y * width + x) * 4;
      image[i] = b; // blue first
      image[i + 1] = g;
      image[i + 2] = r;
      image[i + 3] = 255;
    }
  }
  return { width, height, byteWidth: width * 4, bytesPerPixel: 4, image };
}

/** Read one pixel out of the inflated rows. */
function pixelAt({ width, rows }, x, y) {
  const base = y * (1 + width * 3) + 1 + x * 3;
  return [rows[base], rows[base + 1], rows[base + 2]];
}

{
  // Channel order: BGRA in, RGB out. A swap here is invisible in the file structure.
  const red = readPng(
    encodeScreenPng(
      bitmap(2, 1, () => [255, 0, 0]),
      2,
      1
    )
  );
  assert.deepEqual(pixelAt(red, 0, 0), [255, 0, 0]);
  const blue = readPng(
    encodeScreenPng(
      bitmap(1, 1, () => [0, 0, 255]),
      1,
      1
    )
  );
  assert.deepEqual(pixelAt(blue, 0, 0), [0, 0, 255]);
  const mixed = readPng(
    encodeScreenPng(
      bitmap(1, 1, () => [10, 20, 30]),
      1,
      1
    )
  );
  assert.deepEqual(pixelAt(mixed, 0, 0), [10, 20, 30], "red/green/blue are not permuted");

  // Downscale is a box filter: a 4×4 half-black/half-white screen at 2×2 keeps both halves.
  const halved = readPng(
    encodeScreenPng(
      bitmap(4, 4, (x) => (x < 2 ? [0, 0, 0] : [255, 255, 255])),
      2,
      2
    )
  );
  assert.equal(halved.width, 2);
  assert.equal(halved.height, 2);
  assert.deepEqual(pixelAt(halved, 0, 0), [0, 0, 0]);
  assert.deepEqual(pixelAt(halved, 1, 0), [255, 255, 255]);

  // Every source pixel is averaged in, not sampled: one black pixel in a 2×2 block greys the block.
  const averaged = readPng(
    encodeScreenPng(
      bitmap(2, 2, (x, y) => (x === 0 && y === 0 ? [0, 0, 0] : [255, 255, 255])),
      1,
      1
    )
  );
  const [r] = pixelAt(averaged, 0, 0);
  assert.ok(r > 180 && r < 200, `expected ~191 from averaging three white and one black pixel, got ${r}`);
}

// ============================================================================
// Coordinate mapping + input dispatch (fake robot)
// ============================================================================

/** A 2560×1440 screen: 2.5× the model's 1024×576 display. */
const SCREEN = { width: 2560, height: 1440 };

function fakeRobot(overrides = {}) {
  const calls = [];
  const robot = {
    getScreenSize: () => SCREEN,
    getMousePos: () => ({ x: 640, y: 400 }),
    moveMouse: (x, y) => calls.push(["moveMouse", x, y]),
    mouseClick: (button, double) => calls.push(["mouseClick", button, double]),
    mouseToggle: (down, button) => calls.push(["mouseToggle", down, button]),
    scrollMouse: (x, y) => calls.push(["scrollMouse", x, y]),
    keyToggle: (key, down) => calls.push(["keyToggle", key, down]),
    // robotjs branches on `info.Length()`, so the ARGUMENT COUNT is part of the contract: an explicit
    // second argument of `undefined` takes the two-argument path and fails flag validation with
    // "Invalid key flag specified." — a modifier-less key then throws instead of being pressed. A fake
    // that only records arguments cannot see that, so it throws here exactly as the addon does.
    keyTap: (...args) => {
      // The addon validates the flag argument BEFORE posting any event, so a permissionless probe sees
      // the same failure the real call would.
      if (args.length > 1 && args[1] === undefined) throw new Error("Invalid key flag specified.");
      // Record the REAL argument count (`...args`), not a fixed triple: whether the flag argument was
      // present at all is the property this fake has to expose.
      calls.push(["keyTap", ...args]);
    },
    typeString: (text) => calls.push(["typeString", text]),
    screen: {
      // The driver always captures the whole screen, so the region arguments are ignored here.
      // A bright frame on purpose: an all-black one trips the permission diagnostic.
      capture: (_x = 0, _y = 0, w = SCREEN.width, h = SCREEN.height) => bitmap(w, h, () => [200, 210, 220]),
    },
    ...overrides,
  };
  return { robot, calls };
}

{
  const { robot, calls } = fakeRobot();
  const computer = createNodeComputer({ robot });
  assert.ok(computer, "an injected robot means the capability exists, display or not");

  // The model's space is the screen fitted into 1024×800 — here 1024×576, 2.5× the real screen.
  assert.deepEqual(computer.display, { width: 1024, height: 576 });
  assert.equal(
    computer.environment,
    process.platform === "darwin" ? "mac" : process.platform === "win32" ? "windows" : "linux"
  );
  assert.deepEqual(computer.capabilities, { zoom: true, cursorPosition: true });

  // A `display` override is bounded: it is the input to the PNG encoder, so an absurd size asked for
  // terabytes and a 1x1 frame collapsed every click onto (0,0). Sane values are honoured.
  {
    const { robot } = fakeRobot();
    const bound = (display) => createNodeComputer({ robot, display }).display;
    assert.deepEqual(bound({ width: 640, height: 400 }), { width: 640, height: 400 }, "a usable override");
    assert.deepEqual(bound({ width: 1, height: 1 }), { width: 1024, height: 576 }, "a 1x1 frame is refused");
    assert.deepEqual(
      bound({ width: 1_000_000, height: 1_000_000 }),
      { width: 1024, height: 576 },
      "a terabyte frame is refused"
    );
    assert.deepEqual(bound({ width: 640.5, height: 400 }), { width: 1024, height: 576 }, "non-integers too");
  }

  // Screenshot: full screen in, display-sized PNG out.
  const shot = readPng(await computer.screenshot());
  assert.equal(shot.width, 1024);
  assert.equal(shot.height, 576);

  // Click: display point → physical pixel, then the platform's click call.
  await computer.click(100, 50);
  assert.deepEqual(calls.at(-1), ["mouseClick", "left", undefined]);
  assert.deepEqual(calls.at(-2), ["moveMouse", 250, 125], "coordinates are scaled to the real screen");

  calls.length = 0;
  await computer.click(10, 10, { button: "right", count: 2 });
  assert.deepEqual(calls, [
    ["moveMouse", 25, 25],
    ["mouseClick", "right", true],
  ]);

  // A 3-click is three singles: macOS reads robotjs's double as two, and a triple as three.
  calls.length = 0;
  await computer.click(1, 1, { count: 3 });
  assert.equal(calls.filter(([name]) => name === "mouseClick").length, 3);

  // back/forward are not robotjs buttons; failing loudly beats clicking the left button instead.
  await assert.rejects(() => computer.click(1, 1, { button: "back" }), /no "back" mouse button/);

  // Cursor position comes back in display space (the inverse mapping).
  assert.deepEqual(await computer.cursorPosition(), { x: 256, y: 160 });

  // Scroll: pixels on macOS (a display-space delta scaled to the real screen), whole notches
  // elsewhere. Notches are LOGICAL units, so the same gesture must not scroll further just because
  // the panel is denser — scaling them by the display ratio made `delta_y: 200` four notches here
  // and two on a 1080p screen (same logical desktop, same swipe).
  calls.length = 0;
  await computer.scroll(100, 100, 0, 200);
  const scroll = calls.at(-1);
  assert.equal(scroll[0], "scrollMouse");
  const expected =
    {
      darwin: -500, // pixels: the display-space delta scaled to the 2.5x screen
      win32: -240, // 120 units per notch
      linux: -2, // whole notches
    }[process.platform] ?? -2;
  assert.equal(scroll[2], expected, `scroll units on ${process.platform}`);

  // Keys: `KeyboardEvent.key` names → robotjs names. A chord is ONE event with its modifiers as
  // FLAGS — pressing them as separate events sends the key with flags=0 on macOS
  // (`CGEventSetFlags` is set from the argument), so Cmd+a typed a literal "a".
  calls.length = 0;
  await computer.press(["Control", "a"]);
  assert.deepEqual(calls, [["keyTap", "a", ["control"]]], "one chord, modifier attached as a flag");

  const keyNames = async (keys) => {
    calls.length = 0;
    await computer.press(keys);
    return calls.filter(([name]) => name === "keyTap").map(([, key]) => key);
  };
  // A modifier-less key must reach the backend as ONE argument. robotjs branches on argument count
  // and rejects an explicit `undefined` flag, so `press(["Escape"])` used to throw
  // "Invalid key flag specified." instead of pressing anything — every plain key was dead.
  calls.length = 0;
  await computer.press(["Escape"]);
  assert.equal(calls.length, 1, "one event for a plain key");
  assert.deepEqual(calls[0], ["keyTap", "escape"], "no flag argument when the chord has no modifier");
  assert.deepEqual(await keyNames(["Enter"]), ["enter"]);
  assert.deepEqual(await keyNames([" "]), ["space"]);
  assert.deepEqual(await keyNames(["ArrowUp"]), ["up"]);
  assert.deepEqual(await keyNames(["Meta"]), ["command"]);
  // A lone uppercase letter is Shift+lower on every backend: `keyTap("A")` is a no-op on macOS
  // (the char→keycode table holds the UNSHIFTED character) and carries an unpacked Shift high byte
  // on Windows (`VkKeyScan`). Lowercase letters/digits stay one-argument taps.
  calls.length = 0;
  await computer.press(["A"]);
  assert.deepEqual(calls, [["keyTap", "a", ["shift"]]], "a lone uppercase is Shift+lower");
  assert.deepEqual(await keyNames(["a"]), ["a"]);
  // Any other single character is TEXT, not a key: the X11 path loses the Shift level (`!` → `1`)
  // and macOS/Windows cannot press it through keyTap. Refused with a pointer at `type`.
  await assert.rejects(() => computer.press(["/"]), /is a character, not a key/);
  await assert.rejects(() => computer.press(["!"]), /Use `type` for text/);
  await assert.rejects(() => computer.keyDown("!"), /is a character, not a key/);

  // Aliases models actually send. robotjs matches its table with `strcmp`, so `Return`, `Esc` and
  // `Spacebar` used to fail with "Invalid key code specified." while `enter` / `escape` / `space`
  // worked — and inside a batch the failure landed after earlier steps had already run.
  assert.deepEqual(await keyNames(["Return"]), ["enter"]);
  assert.deepEqual(await keyNames(["Esc"]), ["escape"]);
  assert.deepEqual(await keyNames(["Spacebar"]), ["space"]);
  assert.deepEqual(await keyNames(["Cmd"]), ["command"]);
  // The launcher guidance names the platform key: Super on X11 and the Win key on Windows are the
  // same backend key as macOS Command (`keycode.h` maps all three to `K_META`).
  assert.deepEqual(await keyNames(["Super"]), ["command"]);
  assert.deepEqual(await keyNames(["Win"]), ["command"]);
  // The DOM spelling of a key the backend only knows as `numpad_lock` — a name that is neither a
  // single character nor a table entry, so it needs its own alias rather than the lowercase fallback.
  assert.deepEqual(await keyNames(["NumLock"]), ["numpad_lock"]);
  // Names the backend already knew keep working (the mirror of its table must not reject them).
  assert.deepEqual(await keyNames(["F13"]), ["f13"]);
  assert.deepEqual(await keyNames(["numpad_5"]), ["numpad_5"]);

  // The official TanStack tool normalizes these spellings too (its `keys.ts`): xdotool/OpenAI key
  // names and side-suffixed modifiers must work as a KEY and as a chord flag.
  assert.deepEqual(await keyNames(["page_up"]), ["pageup"]);
  assert.deepEqual(await keyNames(["prior"]), ["pageup"]);
  assert.deepEqual(await keyNames(["next"]), ["pagedown"]);
  assert.deepEqual(await keyNames(["kp_enter"]), ["enter"]);
  assert.deepEqual(await keyNames(["caps_lock"]), ["capslock"]);
  assert.deepEqual(await keyNames(["control_l"]), ["control"]);
  calls.length = 0;
  await computer.press(["control_l", "a"]);
  assert.deepEqual(calls, [["keyTap", "a", ["control"]]], "a side-suffixed modifier is a chord flag");

  // A single uppercase letter in a MODIFIED chord is the lowercase physical key: the modifier decides
  // the case. Without a modifier it is left alone (a lone "A" is covered above).
  for (const [keys, expected] of [
    [
      ["Control", "A"],
      ["keyTap", "a", ["control"]],
    ],
    [
      ["Shift", "A"],
      ["keyTap", "a", ["shift"]],
    ],
    [
      ["Control", "Shift", "A"],
      ["keyTap", "a", ["control", "shift"]],
    ],
  ]) {
    calls.length = 0;
    await computer.press(keys);
    assert.deepEqual(calls, [expected], `${keys.join("+")} lowers the letter`);
  }

  // An unknown name is refused BEFORE anything is posted, with a message that names a usable
  // spelling — robotjs' own "Invalid key code specified." says nothing about what to send instead.
  calls.length = 0;
  await assert.rejects(() => computer.press(["Hyper"]), /not a key name this host can press/);
  assert.deepEqual(calls, [], "no event is posted for a name the backend cannot press");

  // Non-ASCII is not pressable as a single character (the one-byte path cannot carry it): refused
  // before an event, with the same pointer at `type` as any other text character.
  calls.length = 0;
  await assert.rejects(() => computer.press(["é"]), /is a character, not a key/);
  assert.deepEqual(calls, [], "a multi-byte character is not pressed as a key");

  // The batch preflight shares that check (and the chord split), so "would fail" and "fails" agree.
  computer.validatePress(["Control", "c"]);
  computer.validatePress(["Escape"]);
  assert.throws(() => computer.validatePress(["Hyper"]), /not a key name/);
  assert.throws(() => computer.validatePress(["a", "b"]), /is not a modifier/);
  await assert.rejects(() => computer.keyDown("Hyper"), /not a key name/, "a hold is validated too");

  // The mirror must be complete, not merely right for the names a test happens to spot-check: a
  // missing name is a false rejection (a key that works through the addon is refused here), and the
  // string-concatenated table could silently merge two names if a line join loses its space.
  {
    const source = fileURLToPath(new URL("../node_modules/@jitsi/robotjs/src/robotjs.cc", import.meta.url));
    if (existsSync(source)) {
      const text = readFileSync(source, "utf8");
      const table = text.slice(text.indexOf("static KeyNames key_names[]"), text.indexOf("int CheckKeyCodes"));
      const names = [...new Set([...table.matchAll(/\{\s*"([^"]+)",/g)].map((match) => match[1]))];
      assert.ok(names.length > 70, `parsed the addon's key table (${names.length} names)`);
      for (const name of names) computer.validatePress([name]);
    } else {
      // A published install ships the prebuilt binding without `src/`, so this — the only assertion
      // that checks the mirror against the addon instead of against itself — would vanish silently
      // and the run would look the same as a complete one.
      console.log(`${SKIP_MARKER} addon sources are not installed (${source}) — key mirror not cross-checked`);
    }
  }

  // The whole input surface is parameterised by `platform` (the option exists precisely so this
  // matrix is assertable on Linux CI). The new validation must behave identically on all three, and
  // the untouched per-platform routing must still be what each platform expects.
  for (const platform of ["darwin", "win32", "linux"]) {
    const { robot, calls } = fakeRobot();
    const c = createNodeComputer({ robot, platform });
    const environment = { darwin: "mac", win32: "windows", linux: "linux" }[platform];

    assert.equal(c.environment, environment, `${platform}: the advertised environment`);

    // Aliases resolve to the same backend name everywhere; only their keycode mapping differs.
    for (const [name, mapped] of [
      ["Return", "enter"],
      ["Esc", "escape"],
      ["Spacebar", "space"],
      ["Cmd", "command"],
      ["Super", "command"],
      ["Win", "command"],
    ]) {
      calls.length = 0;
      await c.press([name]);
      assert.deepEqual(calls, [["keyTap", mapped]], `${platform}: ${name} → ${mapped}`);
    }

    // A chord is the same event on every platform; the addon expands the flags into real modifier
    // events on Windows/X11 and into `CGEventSetFlags` on macOS.
    calls.length = 0;
    await c.press(["Control", "a"]);
    assert.deepEqual(calls, [["keyTap", "a", ["control"]]], `${platform}: one chord event`);

    // A hold validates too, and maps the same way.
    calls.length = 0;
    await c.keyDown("Meta");
    await c.keyUp("Meta");
    assert.deepEqual(
      calls,
      [
        ["keyToggle", "command", "down"],
        ["keyToggle", "command", "up"],
      ],
      `${platform}: hold and release`
    );

    // A lone uppercase is a real press on every platform (Shift+lower), not keyTap("A").
    calls.length = 0;
    await c.press(["A"]);
    assert.deepEqual(calls, [["keyTap", "a", ["shift"]]], `${platform}: uppercase is Shift+lower`);

    // The preflight is platform-independent: an unknown name and a multi-byte character are refused
    // before any event, and every name in the backend table is accepted.
    assert.throws(() => c.validatePress(["Hyper"]), /not a key name/, `${platform}: unknown name`);
    assert.throws(() => c.validatePress(["é"]), /is a character, not a key/, `${platform}: multi-byte char`);
    c.validatePress(["F13"]);
    c.validatePress(["numpad_5"]);

    // Per-platform scroll units are unchanged by this change: pixels on macOS, 120/notch on Windows,
    // whole notches on X11.
    calls.length = 0;
    await c.scroll(100, 100, 0, 200);
    const expected = { darwin: -500, win32: -240, linux: -2 }[platform];
    assert.equal(calls.at(-1)[2], expected, `${platform}: scroll units`);
  }

  // Two "keys" that are not a chord are refused with an explanation: passing "a" as a backend flag
  // fails with "Invalid key flag", which tells the model nothing about what it did wrong.
  await assert.rejects(() => computer.press(["a", "b"]), /is not a modifier/);

  // A backend failure propagates (there is no held modifier left behind: the chord is one call).
  const broken = createNodeComputer({
    robot: fakeRobot({
      keyTap: () => {
        throw new Error("bad key");
      },
    }).robot,
  });
  await assert.rejects(() => broken.press(["Control", "b"]), /bad key/);

  // Typing goes through the OS's own typing (layout-aware), not synthesized key codes.
  calls.length = 0;
  await computer.type("hello");
  assert.deepEqual(calls, [["typeString", "hello"]]);

  // Zoom keeps native detail where it matters, capped so a 4K region does not become a 25 MB encode.
  const zoomed = readPng(await computer.zoom({ x: 0, y: 0, width: 1024, height: 576 }));
  assert.equal(zoomed.width, 1568, "a large region is capped, not encoded at full source resolution");
  assert.equal(zoomed.height, 882, "the cap keeps the aspect ratio");

  const native = readPng(await computer.zoom({ x: 0, y: 0, width: 400, height: 300 }));
  assert.equal(native.width, 1000, "a small region keeps native resolution — that is what zoom is for");
  assert.equal(native.height, 750);

  const clamped = readPng(await computer.zoom({ x: 960, y: 560, width: 500, height: 500 }));
  assert.equal(clamped.width, 160, "clamped to the screen's right edge");
  assert.equal(clamped.height, 40, "clamped to the screen's bottom edge");
}

// ============================================================================
// The screen changes after creation (undock / resolution / display scaling)
// ============================================================================
//
// `display` is fixed and every capture is re-fitted into it, so the picture the model sees keeps
// matching its coordinate space. The MAPPING must follow the live screen: a size cached at creation
// sent the click to `cached / real` of the point the model picked — half the distance for
// 1080p -> 4K — while the screenshot still looked perfect, which is the worst failure to debug.
{
  let live = { width: 2560, height: 1440 };
  const { robot, calls } = fakeRobot({
    getScreenSize: () => live,
    getMousePos: () => ({ x: 640, y: 360 }),
    screen: {
      capture: (_x = 0, _y = 0, w = live.width, h = live.height) => bitmap(w, h, () => [200, 210, 220]),
    },
  });
  const computer = createNodeComputer({ robot });
  assert.ok(computer);
  assert.deepEqual(computer.display, { width: 1024, height: 576 }, "the model's space is fixed at creation");

  calls.length = 0;
  await computer.click(512, 288);
  assert.deepEqual(calls.at(-2), ["moveMouse", 1280, 720], "2.5x screen: the display point scales by 2.5");

  // Undocked, or the display scaling changed: the real screen is now 1:1 with the model's space.
  live = { width: 1024, height: 576 };

  const shot = readPng(await computer.screenshot());
  assert.equal(shot.width, 1024, "the screenshot still matches the model's display");

  calls.length = 0;
  await computer.click(512, 288);
  assert.deepEqual(
    calls.at(-2),
    ["moveMouse", 512, 288],
    "the click follows the live screen, not the size cached at creation"
  );
  assert.deepEqual(await computer.cursorPosition(), { x: 640, y: 360 }, "the reported pointer moves with it too");

  // A zoom converts the region with the same live size it clamps against — mixing the two
  // magnified a region the model never asked for.
  const zoomed = readPng(await computer.zoom({ x: 0, y: 0, width: 512, height: 288 }));
  assert.equal(zoomed.width, 512, "the region is 1:1 now, not doubled by the old scale");

  // One gesture, one scroll distance, whatever the panel's density (pixels are macOS-only).
  calls.length = 0;
  await computer.scroll(640, 360, 0, 200);
  const expected =
    {
      darwin: -200, // pixels: 1:1 now
      win32: -240, // logical notches, unchanged by the resolution
      linux: -2,
    }[process.platform] ?? -2;
  assert.equal(calls.at(-1)[2], expected, `scroll distance on ${process.platform}`);
}

// ============================================================================
// Absent capability
// ============================================================================

{
  // A headless host: the addon loads, the display does not open. `null`, not a half-working screen.
  const { robot } = fakeRobot({
    getScreenSize: () => {
      throw new Error("Could not open main display");
    },
  });
  assert.equal(createNodeComputer({ robot }), null);

  const { robot: degenerate } = fakeRobot({ getScreenSize: () => ({ width: 0, height: 0 }) });
  assert.equal(createNodeComputer({ robot: degenerate }), null, "a zero-sized screen is not a screen");
}

{
  // The real probe. This block is also a crash test: without a display, `robotjs.getScreenSize()`
  // SEGFAULTS (it dereferences a NULL `Display*`), so probing in-process used to kill the host —
  // and every other validator that merely created a Node env — with only "Could not open main
  // display" on stderr. Reaching the assertions below is the assertion that it no longer does.
  const real = createNodeComputer();
  assert.ok(real === null || typeof real.screenshot === "function", "the probe either yields a driver or null");
  if (process.platform === "linux" && !process.env.DISPLAY) {
    assert.equal(real, null, "no DISPLAY on Linux means no capability (and no addon load)");
  }

  const env = createNodeEnv({ rootPath: process.cwd() });
  assert.equal(
    env.computer === undefined,
    real === null,
    "the env advertises `computer` exactly when the driver exists"
  );
}

// ============================================================================
// Linux non-ASCII typing
// ============================================================================

{
  const { robot, calls } = fakeRobot();
  const computer = createNodeComputer({ robot });
  const hasXdotool = process.platform === "linux" && spawnSync("xdotool", ["--version"]).status === 0;

  if (process.platform === "linux" && !hasXdotool) {
    // robotjs' X11 path truncates each code point to one byte, so typing CJK through it produces
    // plausible-looking garbage. Refusing is the contract; the message has to name the fix.
    await assert.rejects(() => computer.type("你好"), /xdotool/);
    assert.equal(
      calls.some(([name]) => name === "typeString"),
      false,
      "robotics must not be handed text it would mangle"
    );
  } else if (process.platform === "linux") {
    await computer.type("你好");
    assert.equal(
      calls.some(([name]) => name === "typeString"),
      false,
      "xdotool does the typing"
    );
  } else if (process.platform === "win32") {
    await computer.type("你好");
    assert.deepEqual(calls.at(-1), ["typeString", "你好"], "Windows injects the code point directly");
  }
  // macOS is asserted below through the injectable pasteboard writer: the real one would overwrite
  // this machine's clipboard (and is unreachable on a Linux CI).

  // ASCII always takes the addon path, on every platform.
  calls.length = 0;
  await computer.type("hello world");
  assert.deepEqual(calls.at(-1), ["typeString", "hello world"]);
}

// ---------------------------------------------------------------------------
// The non-ASCII channel is a per-platform decision (assertable everywhere)
// ---------------------------------------------------------------------------
//
// Only macOS `typeString` goes through an IME, and that is the one that swallowed a measured "王恒".
// Linux has xdotool, Windows injects Unicode directly, and an astral code point is refused where it
// would be truncated by a 16-bit code unit.
{
  assert.equal(nonAsciiTypeChannel("linux", "你好"), "xdotool");
  assert.equal(nonAsciiTypeChannel("darwin", "你好"), "pasteboard");
  assert.equal(nonAsciiTypeChannel("darwin", "🙂"), "pasteboard", "macOS can paste an emoji");
  assert.equal(nonAsciiTypeChannel("win32", "你好"), "typeString");
  assert.equal(nonAsciiTypeChannel("win32", "🙂"), "refuse", "a 16-bit code unit would type a glyph");

  // Linux ASCII punctuation needs xdotool too: the X11 char path loses the Shift level (`!` → `1`,
  // `"` → nothing). Plain letters/digits/spaces stay on typeString.
  assert.equal(typeChannel("linux", "hello 123"), "typeString");
  assert.equal(typeChannel("linux", "hello!"), "xdotool");
  assert.equal(typeChannel("linux", "a@b.com"), "xdotool");
  assert.equal(typeChannel("linux", "你好"), "xdotool");
  assert.equal(typeChannel("darwin", "hello!"), "typeString");
  assert.equal(typeChannel("darwin", "你好"), "pasteboard");
  assert.equal(typeChannel("win32", "hello!"), "typeString");
  assert.equal(typeChannel("win32", "你好"), "typeString");
  assert.equal(typeChannel("win32", "🙂"), "refuse");
}

// ---------------------------------------------------------------------------
// macOS paste: the write, then Cmd+V (emulated, so it runs on any host)
// ---------------------------------------------------------------------------
{
  const { robot, calls } = fakeRobot();
  const written = [];
  const computer = createNodeComputer({
    robot,
    platform: "darwin",
    writePasteboard: async (text) => {
      written.push(text);
    },
  });
  assert.ok(computer);
  assert.equal(computer.environment, "mac");
  await computer.type("王恒🙂");
  assert.deepEqual(written, ["王恒🙂"], "the WHOLE string goes to the pasteboard, one text run");
  assert.deepEqual(
    calls,
    [["keyTap", "v", "command"]],
    "and it is pasted with ONE Cmd+V event (a held Command would send v with flags=0)"
  );

  // A failed write is explained, not silently typed character by character.
  const failing = createNodeComputer({
    robot: fakeRobot().robot,
    platform: "darwin",
    writePasteboard: async () => {
      throw new Error("no pasteboard server");
    },
  });
  await assert.rejects(() => failing.type("王恒"), /writing the pasteboard failed.*no pasteboard server/);
}

// ============================================================================
// Blank capture diagnostics
// ============================================================================

{
  // Last block on purpose: the warning is once per process, so it can only be observed here.
  const blank = { width: 8, height: 8, byteWidth: 32, bytesPerPixel: 4, image: Buffer.alloc(8 * 8 * 4) };
  const { robot } = fakeRobot({ screen: { capture: () => blank } });
  const computer = createNodeComputer({ robot });

  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(" "));
  try {
    const shot = readPng(await computer.screenshot());
    assert.equal(shot.width, 1024, "a black capture is still a valid image");
    await computer.screenshot();
  } finally {
    console.warn = originalWarn;
  }

  assert.equal(warnings.length, 1, "reported once per process, not per screenshot");
  assert.match(warnings[0], /all-black/);
  assert.match(warnings[0], /Screen Recording/, "the message names the macOS permission that causes it");
}

console.log("validate:computer-driver ok");
