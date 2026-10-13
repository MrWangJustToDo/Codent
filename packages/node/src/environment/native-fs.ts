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

  const resolvePath = (inputPath: string): string => {
    const resolved = path.isAbsolute(inputPath) ? path.resolve(inputPath) : path.resolve(resolvedRoot, inputPath);
    if (resolved === resolvedRoot || resolved.startsWith(resolvedRoot + path.sep)) {
      return resolved;
    }
    for (const extra of extraRoots) {
      if (resolved === extra || resolved.startsWith(extra + path.sep)) {
        return resolved;
      }
    }
    throw new FileError(
      "permission_denied",
      `Path traversal blocked: "${inputPath}" resolves outside workspace root`,
      inputPath
    );
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
