/**
 * A CoreEnv backed by the real filesystem, with workspace-relative paths resolved against
 * `rootPath` (the Node adapter's contract).
 *
 * Two validators exercise workspace-cache retention (`validate-tool-output-cache`,
 * `validate-workspace-cache-retention`) and both need the same surface: the file operations the
 * sweepers and the spill writer use, and nothing else. Keeping one copy means a change to the
 * contract (a new optional fs method, a different path resolution) is made once.
 */

import fs from "node:fs";
import path from "node:path";

import { TEMP_RM_OPTIONS } from "./temp-cleanup.mjs";

/** The fs methods the cache paths touch; `resolve` keeps every path workspace-relative. */
export function createMockEnv(rootPath) {
  const resolve = (p) => (path.isAbsolute(p) ? p : path.join(rootPath, p));
  return {
    rootPath,
    getPlatform: async () => "linux",
    getArch: async () => "x64",
    getEnv: async () => ({}),
    homedir: async () => rootPath,
    fs: {
      readFile: async (p, encoding) => fs.promises.readFile(resolve(p), encoding ?? "utf-8"),
      writeFile: async (p, content) => fs.promises.writeFile(resolve(p), content),
      mkdir: async (p) => fs.promises.mkdir(resolve(p), { recursive: true }),
      exists: async (p) =>
        fs.promises.access(resolve(p)).then(
          () => true,
          () => false
        ),
      readdir: async (p) => {
        try {
          const entries = await fs.promises.readdir(resolve(p), { withFileTypes: true });
          return entries.map((e) => ({ name: e.name, type: e.isDirectory() ? "directory" : "file" }));
        } catch {
          return [];
        }
      },
      stat: async (p) => {
        const st = await fs.promises.stat(resolve(p));
        return { isDirectory: st.isDirectory(), isFile: st.isFile(), size: st.size, mtime: st.mtime };
      },
      remove: async (p) => fs.promises.rm(resolve(p), TEMP_RM_OPTIONS),
    },
    runCommand: async () => ({ stdout: "", stderr: "", code: 0 }),
    exec: async () => ({ stdout: "", stderr: "", code: 0 }),
    fetch: async () => new Response(),
  };
}
