import { fileURLToPath } from "node:url";

import type { Plugin } from "vite";

const pathShim = fileURLToPath(new URL("../shims/node-path.ts", import.meta.url));
const fsShim = fileURLToPath(new URL("../shims/node-fs.ts", import.meta.url));
const fsPromisesShim = fileURLToPath(new URL("../shims/node-fs-promises.ts", import.meta.url));
const cryptoShim = fileURLToPath(new URL("../shims/node-crypto.ts", import.meta.url));

const EXACT: Record<string, string> = {
  "node:path": pathShim,
  path: pathShim,
  "node:fs/promises": fsPromisesShim,
  "fs/promises": fsPromisesShim,
  "node:fs": fsShim,
  fs: fsShim,
  "node:crypto": cryptoShim,
  crypto: cryptoShim,
};

const VIRTUAL_EMPTY = "\0playground-node-empty";
const VIRTUAL_AGENT_TOOLSET = "\0playground-anthropic-agent-toolset";

/**
 * Browser stub for every Node built-in the render layer pulls in.
 *
 * `@codent/app` is a Node/terminal package: the filesystem, child-process and
 * stream surfaces it imports are all reachable from the bundled render layer,
 * and the playground runs that layer in a browser where none of them exist.
 * Vite would otherwise abort the build with MISSING_EXPORT for each name the
 * importer destructures, so the stub has to declare **every** one of them,
 * even when the call can only ever throw.
 *
 * The names below are the union actually requested by the bundles
 * (`@codent/app`'s CJS-interop chunk for `createRequire`, the terminal
 * renderer for the stream/process pieces) — verify with:
 * `pnpm --filter @codent/playground build` and fix any new MISSING_EXPORT here.
 */
const NODE_EMPTY_STUB = `
export function promisify(fn) {
  return (...args) => Promise.resolve(typeof fn === "function" ? fn(...args) : undefined);
}
export function execFile() {
  return Promise.reject(new Error("node:child_process is not available in the browser"));
}
export function fork() {
  throw new Error("node:child_process is not available in the browser");
}

/**
 * Only reached by CJS-interop wrappers around code paths the browser never
 * executes. Returning a thunk keeps them from crashing at module-eval time;
 * a real call still fails loudly instead of silently returning nothing.
 */
export function createRequire() {
  return () => {
    throw new Error("require() is not available in the browser");
  };
}
export function cwd() {
  return "/";
}
export function fileURLToPath(url) {
  const value = typeof url === "string" ? url : String(url);
  return value.startsWith("file://") ? decodeURIComponent(value.slice(7)) : value;
}

// Minimal Buffer stand-in: interop wrappers only inspect it by identity here,
// real encoding work is never reached in the terminal renderer.
export class Buffer extends Uint8Array {
  static from(value, encoding) {
    if (typeof value === "string") return new TextEncoder().encode(value);
    return new Uint8Array(value ?? []);
  }
  static alloc(size) {
    return new Uint8Array(size);
  }
  static isBuffer() {
    return false;
  }
  toString() {
    return new TextDecoder().decode(this);
  }
}

export const env = { NODE_ENV: "production" };
export const argv = [];
export const platform = "browser";

// Stream surface. Real inheritance where the CJS interop checks it, inert
// otherwise: a terminal component that renders is the one thing the browser
// host drives, and it never runs these paths.
export class EventEmitter {
  on() {
    return this;
  }
  once() {
    return this;
  }
  off() {
    return this;
  }
  emit() {
    return false;
  }
  addListener() {
    return this;
  }
  removeListener() {
    return this;
  }
}
export class Stream extends EventEmitter {
  pipe(destination) {
    return destination;
  }
}
export class Readable extends Stream {}
export class Writable extends Stream {}
export class Transform extends Stream {}
export class PassThrough extends Transform {}
export async function pipeline(...args) {
  const destination = args[args.length - 1];
  return typeof destination === "function" ? destination() : destination;
}
export function finished(_stream, callback) {
  if (typeof callback === "function") callback();
}

export default {
  promisify,
  execFile,
  fork,
  createRequire,
  cwd,
  fileURLToPath,
  Buffer,
  env,
  argv,
  platform,
  EventEmitter,
  Stream,
  Readable,
  Writable,
  Transform,
  PassThrough,
  pipeline,
  finished,
};
`;

/**
 * Resolve Node built-ins and unused Anthropic Node-only toolset to browser-safe stubs.
 */
export function stubNodeBuiltins(): Plugin {
  return {
    name: "stub-node-builtins",
    enforce: "pre",
    resolveId(id) {
      if (EXACT[id]) return EXACT[id];

      if (id.includes("@anthropic-ai/sdk/tools/agent-toolset") || id.includes("/tools/agent-toolset/")) {
        return VIRTUAL_AGENT_TOOLSET;
      }

      if (id.startsWith("node:")) return VIRTUAL_EMPTY;
      return null;
    },
    load(id) {
      if (id === VIRTUAL_AGENT_TOOLSET) {
        // Names imported by the SDK at module scope, from any file under
        // `tools/agent-toolset/` (the matcher is a directory-wide catch-all, so every
        // import from it has to resolve here). `checkMemorySyncInterval` comes from
        // `sync-interval.mjs` in SDK >= 0.135, which the Anthropic adapter bundle reaches
        // through `lib/environments/worker.mjs`; the Node-only toolset itself is never
        // callable in the browser, so the validator is inert.
        return `
export default {};
export const betaAgentToolset20260401 = () => ({});
export const checkMemorySyncInterval = () => {};
`;
      }

      if (id === VIRTUAL_EMPTY) {
        return NODE_EMPTY_STUB;
      }

      return null;
    },
  };
}
