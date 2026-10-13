/**
 * Native Node.js filesystem scoped to a workspace root.
 */

import { FileError } from "@codent/core";
import * as fsSync from "fs";
import * as fs from "fs/promises";
import * as path from "path";

import type { CoreEnvFs } from "@codent/core";

export interface NativeFilesystemHandle {
  readonly rootPath: string;
  readonly filesystem: CoreEnvFs;
  resolvePath(inputPath: string): string;
}

/**
 * Create a filesystem implementation rooted at `rootPath`.
 */
export function createNativeFilesystem(
  rootPath: string,
  options?: { extraReadRoots?: string[] }
): NativeFilesystemHandle {
  const resolvedRoot = path.resolve(rootPath);
  const extraRoots = (options?.extraReadRoots ?? []).map((p) => path.resolve(p));

  /**
   * Resolve the real path of `target`, tolerating a target that does not exist yet.
   *
   * `realpathSync` throws on a missing path, but a write target legitimately may not exist (its
   * parent is created just before the write). So walk up to the deepest EXISTING ancestor,
   * realpath that, then re-append the segments we stripped — a genuinely non-existent tail cannot
   * contain anything to follow. The one tail entry that DOES exist yet defeats `realpath` is a
   * dangling symlink: it is a real directory entry whose target is absent, so `realpath` reports
   * ENOENT and a naive reconstruction would hand back the lexical link path, re-opening the escape
   * for a write that creates the target. Detect it with `lstat` and follow the link explicitly.
   *
   * Synchronous on purpose: the host-facing `resolvePath` contract is synchronous (it is handed to
   * `runNativeCommand` for `cwd`), so the real check must not require an await.
   *
   * @param depth symlink-follow depth, capped so a link loop (ELOOP) cannot recurse forever.
   */
  const realpathAllowMissing = (target: string, depth = 0): string => {
    let current = target;
    const missing: string[] = [];
    for (;;) {
      try {
        const real = fsSync.realpathSync(current);
        return missing.length === 0 ? real : path.join(real, ...missing.reverse());
      } catch {
        if (depth < 40) {
          let linkTarget: string | undefined;
          try {
            if (fsSync.lstatSync(current).isSymbolicLink()) {
              linkTarget = fsSync.readlinkSync(current);
            }
          } catch {
            // Not a symlink (or unreadable) — fall through and treat it as a missing segment.
          }
          if (linkTarget !== undefined) {
            const realLink = realpathAllowMissing(path.resolve(path.dirname(current), linkTarget), depth + 1);
            return missing.length === 0 ? realLink : path.join(realLink, ...missing.reverse());
          }
        }
        const parent = path.dirname(current);
        // Reached the filesystem root without finding anything that exists — nothing to resolve.
        if (parent === current) return target;
        missing.push(path.basename(current));
        current = parent;
      }
    }
  };

  // The roots are realpathed too: a workspace root can itself sit under a symlink (macOS
  // `/tmp` -> `/private/tmp`, or any symlinked checkout), so containment must be judged in the
  // real filesystem. Comparing a real path against a lexical (symlinked) root would reject every
  // legitimate access.
  const realRoots = [resolvedRoot, ...extraRoots].map((root) => realpathAllowMissing(root));

  /**
   * Real-path containment gate — the lexical check above is pure string math (`path.resolve`
   * never touches the disk), so an in-root symlink pointing OUTSIDE the workspace passes it while
   * the OS follows the link at access time, for reads AND writes. Resolve the REAL path and
   * require it to stay inside a real root. On success the unchanged lexical path is returned (the
   * OS re-resolves the link anyway); the check is what matters. One `realpath` per resolve is
   * cheap enough.
   */
  const assertRealContained = (resolved: string, inputPath: string): string => {
    const real = realpathAllowMissing(resolved);
    for (const realRoot of realRoots) {
      if (real === realRoot || real.startsWith(realRoot + path.sep)) {
        return resolved;
      }
    }
    throw new FileError(
      "permission_denied",
      `Path traversal blocked: "${inputPath}" resolves outside workspace root`,
      inputPath
    );
  };

  const resolvePath = (inputPath: string): string => {
    const resolved = path.isAbsolute(inputPath) ? path.resolve(inputPath) : path.resolve(resolvedRoot, inputPath);
    const lexicallyContained =
      resolved === resolvedRoot ||
      resolved.startsWith(resolvedRoot + path.sep) ||
      extraRoots.some((extra) => resolved === extra || resolved.startsWith(extra + path.sep));
    if (!lexicallyContained) {
      throw new FileError(
        "permission_denied",
        `Path traversal blocked: "${inputPath}" resolves outside workspace root`,
        inputPath
      );
    }
    // Second gate: the lexical check cannot see symlinks — see `assertRealContained`.
    return assertRealContained(resolved, inputPath);
  };

  const filesystem: CoreEnvFs = {
    readFile: (async (filePath: string, encoding?: string) => {
      const fullPath = resolvePath(filePath);
      if (encoding === "buffer") {
        return fs.readFile(fullPath);
      }
      return fs.readFile(fullPath, "utf-8");
    }) as CoreEnvFs["readFile"],

    /**
     * Byte-window read, so a tail-anchored consumer never pulls the whole file.
     *
     * A single `read()` is not guaranteed to fill the buffer (the kernel may return short), so
     * this loops until the window is satisfied or EOF. Decoding is lenient on purpose: the edges
     * of a range can split a multi-byte character, and the caller discards partial lines anyway.
     */
    readFileRange: async (filePath: string, start: number, end: number) => {
      const fullPath = resolvePath(filePath);
      const from = Math.max(0, Math.floor(start));
      const length = Math.max(0, Math.floor(end) - from);
      if (length === 0) return "";

      let handle: fsSync.promises.FileHandle | null = null;
      try {
        handle = await fs.open(fullPath, "r");
        const buffer = Buffer.allocUnsafe(length);
        let filled = 0;
        while (filled < length) {
          const { bytesRead } = await handle.read(buffer, filled, length - filled, from + filled);
          if (bytesRead === 0) break;
          filled += bytesRead;
        }
        return buffer.subarray(0, filled).toString("utf-8");
      } finally {
        await handle?.close().catch(() => undefined);
      }
    },

    stat: async (filePath: string) => {
      const fullPath = resolvePath(filePath);
      const stats = await fs.stat(fullPath);
      return {
        size: stats.size,
        isDirectory: stats.isDirectory(),
        isFile: stats.isFile(),
        mtime: stats.mtime,
      };
    },

    writeFile: async (filePath: string, content: string | Uint8Array) => {
      const fullPath = resolvePath(filePath);
      await fs.mkdir(path.dirname(fullPath), { recursive: true });
      if (typeof content === "string") {
        await fs.writeFile(fullPath, content, "utf-8");
      } else {
        await fs.writeFile(fullPath, content);
      }
    },

    readdir: async (dirPath: string) => {
      const fullPath = resolvePath(dirPath);
      const entries = await fs.readdir(fullPath, { withFileTypes: true });
      const result: Array<{ name: string; type: "file" | "directory"; size?: number; modified?: Date }> = [];

      for (const entry of entries) {
        const entryPath = path.join(fullPath, entry.name);
        let size: number | undefined;
        let modified: Date | undefined;

        try {
          const stats = await fs.stat(entryPath);
          size = stats.size;
          modified = stats.mtime;
        } catch {
          // Ignore stat errors for individual entries
        }

        result.push({
          name: entry.name,
          type: entry.isDirectory() ? "directory" : "file",
          size,
          modified,
        });
      }

      return result;
    },

    mkdir: async (dirPath: string) => {
      const fullPath = resolvePath(dirPath);
      await fs.mkdir(fullPath, { recursive: true });
    },

    exists: async (filePath: string) => {
      const fullPath = resolvePath(filePath);
      try {
        await fs.access(fullPath);
        return true;
      } catch {
        return false;
      }
    },

    remove: async (filePath: string) => {
      const fullPath = resolvePath(filePath);
      const stats = await fs.stat(fullPath);
      if (stats.isDirectory()) {
        await fs.rm(fullPath, { recursive: true, force: true });
      } else {
        await fs.unlink(fullPath);
      }
    },

    appendFile: async (filePath: string, content: string) => {
      const fullPath = resolvePath(filePath);
      await fs.mkdir(path.dirname(fullPath), { recursive: true });
      await fs.appendFile(fullPath, content, "utf-8");
    },

    rename: async (oldPath: string, newPath: string) => {
      const fullOldPath = resolvePath(oldPath);
      const fullNewPath = resolvePath(newPath);
      await fs.mkdir(path.dirname(fullNewPath), { recursive: true });
      await fs.rename(fullOldPath, fullNewPath);
    },

    // Synchronous pair — for crash/exit paths that cannot await (see AgentLog).
    appendFileSync: (filePath: string, content: string) => {
      const fullPath = resolvePath(filePath);
      fsSync.mkdirSync(path.dirname(fullPath), { recursive: true });
      fsSync.appendFileSync(fullPath, content, "utf-8");
    },

    mkdirSync: (dirPath: string) => {
      fsSync.mkdirSync(resolvePath(dirPath), { recursive: true });
    },

    existsSync: (filePath: string) => {
      try {
        return fsSync.existsSync(resolvePath(filePath));
      } catch {
        return false;
      }
    },
  };

  return { rootPath, filesystem, resolvePath };
}
