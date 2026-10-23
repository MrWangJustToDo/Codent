/**
 * @codent/node — Node.js runtime bindings for @codent/core.
 *
 * Provides:
 * - {@link createNodeEnv} — a {@link CoreEnv} implementation backed by Node.js APIs
 *
 * @example
 * ```typescript
 * import { registerCoreEnv } from "@codent/core";
 * import { createNodeEnv } from "@codent/node";
 *
 * registerCoreEnv(createNodeEnv({ rootPath: "/path/to/project" }));
 * ```
 */

import { renderRgbaAsTerminalText } from "@codent/core";
import { stdioTransport } from "@tanstack/ai-mcp/stdio";
import mime from "mime-types";
import { exec, execFile } from "node:child_process";
import * as os from "node:os";
import * as path from "node:path";

import { scanPathForCommand } from "./environment/command-lookup.js";
import { createNodeIsolateDriver } from "./environment/isolate-driver.js";
import { resolveLocalEnvironmentMode } from "./environment/local.js";
import { createNativeFilesystem } from "./environment/native-fs.js";
import { runNativeCommand, startNativeCommand } from "./environment/native-run.js";
import { resetOsSandbox } from "./environment/os-sandbox.js";
import { findGitBash, getShellConfig } from "./environment/shell.js";
import { locateTreeSitterGrammar } from "./lsp/grammar.js";
import { resolveCommandPath } from "./lsp/resolve-command.js";
import { createLspConnection as createNodeLspConnection } from "./lsp/transport.js";

import type { LocalEnvironmentConfig } from "./environment/local.js";
import type { CoreEnv, CoreEnvExecResult, CoreEnvImageRegion } from "@codent/core";
import type { ChildProcess } from "node:child_process";

// Re-export environment implementations
export * from "./environment";

/**
 * Build the reported result for a `child_process` callback's error branch.
 *
 * Shared by `execFile` and `exec` so the two cannot describe the same failure differently. The
 * rule is: report what actually happened, and never invent an exit status.
 *
 *   - a numeric `err.code` is the process's own exit status — preserve it
 *   - `ENOENT`/`EACCES`/`ENOTDIR` mean nothing ran — `code: null` plus `missing: true`
 *   - a kill sets `killed` with no status
 *
 * A previous version returned one synthesised code for all of these, which erased real exit
 * statuses and made a timeout indistinguishable from a missing binary.
 */
function describeProcessFailure(
  err: { code?: string | number | null; killed?: boolean; signal?: string | null; message: string },
  stdout: string | Buffer | undefined,
  stderr: string | Buffer | undefined
): CoreEnvExecResult {
  const out = typeof stdout === "string" ? stdout : "";
  const errText = typeof stderr === "string" && stderr.length > 0 ? stderr : "";

  if (typeof err.code === "number") {
    return { stdout: out, stderr: errText || err.message, code: err.code };
  }

  const spawnErrorCode = typeof err.code === "string" ? err.code : "";
  if (spawnErrorCode === "ENOENT" || spawnErrorCode === "EACCES" || spawnErrorCode === "ENOTDIR") {
    return { stdout: out, stderr: errText || err.message, code: null, missing: true };
  }

  // `execFile` kills a child that exceeds maxBuffer. The partial stdout is still a
  // valid (truncated) capture — unlike a timeout/abort, where returning it as complete
  // would be a false answer.
  if (
    spawnErrorCode === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" ||
    /maxbuffer|max buffer/i.test(`${err.message} ${errText}`)
  ) {
    return {
      stdout: out,
      stderr: errText || err.message,
      code: null,
      killed: true,
      truncated: true,
    };
  }

  return {
    stdout: out,
    stderr: errText || err.message,
    code: null,
    killed: true,
  };
}

/**
 * stdout/stderr buffer ceiling for {@link CoreEnv.execFile}.
 *
 * `child_process.execFile` defaults to 1 MB and kills the child on overflow, which an
 * unbounded `rg`/`fd` result can exceed on a large tree. Callers truncate in-process
 * anyway, so this only needs to be generous enough not to truncate mid-result.
 */
const EXEC_FILE_MAX_BUFFER = 32 * 1024 * 1024;

// ============================================================================
// Image resizing degradation
// ============================================================================

/**
 * Set once the first resize failure is reported.
 *
 * `resizeImage` runs per oversized image, so an unguarded warning would repeat for
 * every read in a session. One line is enough to tell the reader the capability is
 * missing; the caller's own "image would overflow the budget" error carries the
 * per-image detail.
 */
let warnedResizeUnavailable = false;

/**
 * Explain why `sharp` could not resize, in terms the reader can act on.
 *
 * `sharp` ships as an `optionalDependency`, so a platform with no prebuilt binding
 * has the package omitted by npm rather than failing the install. That case has a
 * fix (install the matching `@img/sharp-*` or build it) and should read differently
 * from a decoder that rejected the specific bytes.
 */
function isSharpMissing(message: string): boolean {
  return /Cannot find (package|module) 'sharp'/.test(message);
}

function describeResizeFailure(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  if (isSharpMissing(message)) {
    return (
      `the optional dependency "sharp" is not installed. npm omits it on platforms ` +
      `without a prebuilt binding, so images over the token budget are rejected instead ` +
      `of downscaled.`
    );
  }
  return message;
}

/**
 * Set once the first image-preview failure is reported.
 *
 * Same reasoning as the resize flag: `imageToText` runs for whichever file is selected in the
 * workspace panel, so an unguarded warning would repeat on every selection instead of saying once
 * that previews are unavailable here.
 */
let warnedImageTextUnavailable = false;

function describeImageTextFailure(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  if (isSharpMissing(message)) {
    return (
      `the optional dependency "sharp" is not installed, so the workspace preview cannot ` +
      `decode images (the file placeholder is shown instead).`
    );
  }
  return message;
}

/**
 * Positive integer dimension for a `sharp` resize, capped like the renderer caps its own.
 *
 * The sizes come from the UI, so they are untrusted here: a zero width throws inside sharp, and an
 * enormous one is work we refuse to do (the renderer caps at the same numbers).
 */
function clampImageDimension(value: number, max: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.min(max, Math.max(1, Math.floor(value)));
}

/**
 * Mild unsharp applied after the downsample, before the pixels become cells.
 *
 * Measured on a 2172×1282 screenshot reduced to 77×45 samples: mean |∇luma| goes 7.44 with the
 * plain lanczos downscale to 12.80 here, and the row/column count does not change. sharp's default
 * `sigma 1` reaches 15.94, but the halos around text become visible, so the mild end is the choice.
 */
const PREVIEW_SHARPEN_SIGMA = 0.7;

/**
 * Clamp a requested source window into the image, so a zoom/pan request can never throw.
 *
 * The client computes the window from the size it was told, so a mismatch (an image replaced
 * underneath, a rounding difference, a stale client) has to degrade to the nearest legal window
 * rather than fail the preview. The result reports the clamped rectangle, so the caller adopts it
 * instead of keeping a request the host silently changed.
 */
function clampImageRegion(
  region: CoreEnvImageRegion | undefined,
  imageWidth: number,
  imageHeight: number
): CoreEnvImageRegion {
  if (!region) return { x: 0, y: 0, width: imageWidth, height: imageHeight };
  const width = clampImageDimension(region.width, imageWidth);
  const height = clampImageDimension(region.height, imageHeight);
  const x = Math.min(imageWidth - width, Math.max(0, clampImageOrigin(region.x)));
  const y = Math.min(imageHeight - height, Math.max(0, clampImageOrigin(region.y)));
  return { x, y, width, height };
}

/**
 * Integer origin for an `extract` window.
 *
 * `Math.floor` alone turns NaN into NaN, and sharp rejects a non-integer `left` by THROWING — which
 * the caller of `imageToText` turns into a `null` preview, i.e. a clamped window would have become
 * "this image cannot be previewed". Clamping is only useful if it survives garbage input.
 */
function clampImageOrigin(value: number): number {
  return Number.isFinite(value) ? Math.floor(value) : 0;
}

// ============================================================================
// createNodeEnv
// ============================================================================

export interface CreateNodeEnvOptions extends LocalEnvironmentConfig {
  /** Workspace root path for agent file operations */
  rootPath: string;
}

/**
 * Create a {@link CoreEnv} implementation backed by Node.js built-in APIs.
 *
 * LLM credentials are not part of CoreEnv — register a {@link import("@codent/core").ModelProvider}
 * separately via {@link import("@codent/core").registerModelProvider}.
 *
 * @example
 * ```typescript
 * import { registerCoreEnv, registerModelProvider, createDirectModelProvider } from "@codent/core";
 * import { createNodeEnv } from "@codent/node";
 *
 * registerCoreEnv(createNodeEnv({ rootPath: "/path/to/project" }));
 * registerModelProvider(createDirectModelProvider({ model, style, baseURL, apiKey }));
 * ```
 */
export function createNodeEnv(options: CreateNodeEnvOptions): CoreEnv {
  const { rootPath } = options;
  const useOsSandbox = resolveLocalEnvironmentMode(options) === "os";
  const homeAgents = path.join(os.homedir(), ".agents");
  const { filesystem, resolvePath } = createNativeFilesystem(rootPath, {
    // Allow reading user-global skills / extensions under ~/.agents
    extraReadRoots: [homeAgents],
  });

  return {
    rootPath,

    path: {
      join: path.join,
      dirname: path.dirname,
      basename: path.basename,
      extname: path.extname,
      resolve: path.resolve,
      normalize: path.normalize,
      isAbsolute: path.isAbsolute,
      getSep: () => path.sep,
      parse: path.parse,
    },

    getPlatform: async () => process.platform,
    getArch: async () => process.arch,
    getEnv: async () => process.env as Record<string, string | undefined>,
    homedir: async () => os.homedir(),

    byteLength: (str: string, encoding?: string) => Buffer.byteLength(str, encoding as BufferEncoding),

    base64Encode: (data: Uint8Array) => Buffer.from(data).toString("base64"),

    base64Decode: (str: string) => new Uint8Array(Buffer.from(str, "base64")),

    fs: filesystem,

    runCommand: (command, cmdOptions) => runNativeCommand(rootPath, resolvePath, command, cmdOptions, useOsSandbox),

    startCommand: (command, cmdOptions) => startNativeCommand(rootPath, resolvePath, command, cmdOptions, useOsSandbox),

    exec: (command: string, execOptions?) => {
      return new Promise<CoreEnvExecResult>((resolve) => {
        const child = exec(
          command,
          {
            cwd: execOptions?.cwd,
            timeout: execOptions?.timeout,
            env: execOptions?.env ? { ...process.env, ...execOptions.env } : process.env,
          },
          (err, stdout, stderr) => {
            if (err) {
              // Same classification as execFile — a shell command can fail to launch or be
              // killed just as a direct binary can, and the two paths must not describe it
              // differently.
              resolve(describeProcessFailure(err, stdout, stderr));
              return;
            }
            resolve({
              stdout: typeof stdout === "string" ? stdout : "",
              stderr: typeof stderr === "string" ? stderr : "",
              code: 0,
            });
          }
        );
        child.on("error", () => {});
      });
    },

    // Execute a process with an explicit argv and no shell. This is what lets tools run
    // external binaries without writing shell command strings, which is the only way to
    // stay shell-agnostic: a string that is valid bash can be a parse error in PowerShell.
    execFile: (file: string, args: string[], fileOptions?) => {
      return new Promise<CoreEnvExecResult>((resolve) => {
        // Resolve a project-local install first, so a devDependency binary is usable
        // without a global install (same rule as `commandExists` and the LSP spawn path).
        const resolved = resolveCommandPath(file, rootPath);
        const child = execFile(
          resolved,
          args,
          {
            cwd: fileOptions?.cwd,
            timeout: fileOptions?.timeout,
            env: fileOptions?.env ? { ...process.env, ...fileOptions.env } : process.env,
            signal: fileOptions?.signal,
            maxBuffer: EXEC_FILE_MAX_BUFFER,
            windowsHide: true,
          },
          (err, stdout, stderr) => {
            // `err` covers every non-zero outcome, which is several genuinely different things.
            // `describeProcessFailure` classifies them in one place so this path and `exec`
            // cannot disagree — an earlier revision duplicated the logic here, which is how the
            // classification ended up applied to one path and silently not the other.
            if (err) {
              resolve(describeProcessFailure(err, stdout, stderr));
              return;
            }
            resolve({
              stdout: typeof stdout === "string" ? stdout : "",
              stderr: typeof stderr === "string" ? stderr : "",
              code: 0,
            });
          }
        );
        child.on("error", () => {});
      });
    },

    // Report the shell that command strings will run under, so command-safety can pick a
    // matching parser. Platform alone is the wrong answer: a Windows host with Git Bash
    // resolved genuinely runs bash.
    getShellInfo: async () => {
      const envShell = process.env.SHELL;
      const isWindows = os.platform() === "win32";
      const candidates: string[] = [];
      if (envShell) candidates.push(envShell);
      if (isWindows) {
        const gitBash = await findGitBash();
        if (gitBash) candidates.push(gitBash);
        candidates.push("powershell.exe", "pwsh.exe", "cmd.exe");
      } else {
        candidates.push("/bin/bash", "/bin/sh");
      }
      const resolved = await getShellConfig();
      return { shell: resolved.shell, candidates };
    },

    commandExists: async (command: string): Promise<boolean> => {
      // Prefer a project-local install so a devDependency server is usable
      // without a global install (kept in sync with the LSP spawn path).
      if (resolveCommandPath(command, rootPath) !== command) return true;
      // Resolve against PATH directly rather than probing with `command -v`, which is a
      // POSIX shell builtin: under PowerShell or cmd.exe every binary looked absent, so the
      // LSP extension skipped servers that were actually installed.
      return scanPathForCommand(command) !== undefined;
    },

    destroy: async () => {
      if (useOsSandbox) {
        await resetOsSandbox();
      }
    },

    fetch: globalThis.fetch,

    getMimeType: async (filePath: string) => mime.lookup(filePath),

    createMCPStdioTransport: (config) => {
      return stdioTransport({
        command: config.command,
        args: config.args,
        env: config.env,
      });
    },

    getMCPTransportProcess: (transport) => {
      const child =
        (transport as { _process?: ChildProcess; process?: ChildProcess })._process ??
        (transport as { process?: ChildProcess }).process;
      if (!child) return undefined;
      return {
        killed: child.killed,
        kill: (signal?: string) => child.kill(signal as NodeJS.Signals),
      };
    },

    createLspConnection: (config) =>
      createNodeLspConnection({
        ...config,
        // Same resolution as commandExists, so the probed binary is the spawned one.
        command: resolveCommandPath(config.command, config.cwd ?? rootPath),
      }),
    locateTreeSitterGrammar,

    createIsolateDriver: createNodeIsolateDriver,

    resizeImage: async (buffer, { maxWidth = 1024, quality = 80 } = {}) => {
      try {
        const sharp = (await import("sharp")).default;
        const resized = await sharp(buffer)
          .resize({ width: maxWidth, withoutEnlargement: true })
          .jpeg({ quality })
          .toBuffer();
        return new Uint8Array(resized);
      } catch (err) {
        // Degrade to `null` (the caller then rejects the image and reports its
        // size) — but say why. Returning `null` silently made the only
        // completely unobservable failure in this file: an oversized image was
        // refused with no hint that resizing was the missing capability, so a
        // platform without a `sharp` prebuild was indistinguishable from a
        // genuinely too-large image. Reported once: this is reached per image,
        // and a chatty warning per read would be worse than none.
        if (!warnedResizeUnavailable) {
          warnedResizeUnavailable = true;
          console.warn(`[node] image resizing unavailable (degrading): ${describeResizeFailure(err)}`);
        }
        return null;
      }
    },

    /**
     * Decode an image and hand the pixels to core's renderer.
     *
     * The split matters: a screenshot-class PNG decodes to tens of MB of RGBA at source size, so the
     * downsample has to happen inside `sharp` (native, streaming) rather than in JS. `inside` keeps
     * the aspect ratio and `withoutEnlargement` matches the renderer's own no-upsampling rule; the
     * box filter in `renderRgbaAsTerminalText` then does the final reduction to cells, so the glyph
     * algebra stays in one place and the workspace preview looks identical on every host.
     *
     * A `region` (zoom/pan) is extracted before the resize, so only that window is decoded into RGBA
     * and the payload stays one screenful however far the user zooms in.
     */
    imageToText: async (buffer, { maxCols, maxRows, color = true, region }) => {
      try {
        const sharp = (await import("sharp")).default;
        // EXIF orientation must be resolved BEFORE the region is interpreted: the window arrives in
        // the coordinates of what the user sees. `autoOrient` reports the oriented size, so this
        // costs one metadata read instead of a throwaway decode.
        const meta = await sharp(buffer).metadata();
        const imageWidth = meta.autoOrient?.width ?? meta.width ?? 0;
        const imageHeight = meta.autoOrient?.height ?? meta.height ?? 0;
        if (!imageWidth || !imageHeight) return null;
        const window = clampImageRegion(region, imageWidth, imageHeight);
        const sampleCols = clampImageDimension(maxCols, 200);
        const sampleRows = clampImageDimension(maxRows * 2, 400);
        const pipeline = sharp(buffer).rotate();
        // `extract` is only worth taking on the whole-image path when there is nothing to cut: a
        // pre-resize extract disables libjpeg's shrink-on-load, so a large JPEG would be decoded at
        // full size before being thrown away.
        if (region !== undefined) {
          pipeline.extract({ left: window.x, top: window.y, width: window.width, height: window.height });
        }
        pipeline.resize({
          width: sampleCols,
          height: sampleRows,
          fit: "inside",
          // Zooming in on a window smaller than the cell grid is the whole point of `region`, so
          // only the whole-image path refuses to invent pixels.
          withoutEnlargement: region === undefined,
        });
        // Sharpen only when the resize actually REDUCED the image: that is the step that softens
        // edges. At 1:1 (and when enlarging a zoom window) there is no lost detail to compensate,
        // and an unsharp mask there would just ring a pixel-exact picture.
        const downscaled = window.width > sampleCols || window.height > sampleRows;
        if (downscaled) {
          // Mild on purpose: `sigma 0.7` measured +72% edge energy over the plain downscale, where
          // sharp's default `sigma 1` makes the halos around text visible.
          pipeline.sharpen({ sigma: PREVIEW_SHARPEN_SIGMA, m1: 1, m2: 1.5 });
        }
        const { data, info } = await pipeline.ensureAlpha().raw().toBuffer({ resolveWithObject: true });

        const rows = renderRgbaAsTerminalText(
          { width: info.width, height: info.height, data },
          { maxCols, maxRows, color }
        );
        return { rows, imageWidth, imageHeight, region: window };
      } catch (err) {
        if (!warnedImageTextUnavailable) {
          warnedImageTextUnavailable = true;
          console.warn(`[node] image preview unavailable (degrading): ${describeImageTextFailure(err)}`);
        }
        return null;
      }
    },
  };
}
