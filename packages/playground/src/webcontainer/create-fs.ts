import { FileError, errorMessage } from "@codent/core";

import { resolveWorkspacePath, toWorkdirPath } from "./workspace-path.js";

import type { CoreEnvFs } from "@codent/core";
import type { FileSystemAPI, WebContainer } from "@webcontainer/api";

function wrapFsError(err: unknown, path: string): never {
  const message = errorMessage(err);
  const lower = message.toLowerCase();
  if (lower.includes("enoent") || lower.includes("no such file")) {
    throw new FileError("not_found", message, path, err instanceof Error ? err : undefined);
  }
  if (lower.includes("eacces") || lower.includes("permission") || lower.includes("traversal")) {
    throw new FileError("permission_denied", message, path, err instanceof Error ? err : undefined);
  }
  throw new FileError("unknown", message, path, err instanceof Error ? err : undefined);
}

export function createWebContainerFs(wc: WebContainer, rootPath: string, onChange?: () => void): CoreEnvFs {
  const fs: FileSystemAPI = wc.fs;

  const resolve = (inputPath: string): string => {
    try {
      return resolveWorkspacePath(rootPath, inputPath);
    } catch (err) {
      throw new FileError("permission_denied", errorMessage(err), inputPath, err instanceof Error ? err : undefined);
    }
  };

  // Convert workspace-resolved path → workdir-relative path for wc.fs
  const wd = (resolvedPath: string): string => toWorkdirPath(rootPath, resolvedPath);

  return {
    readFile: (async (filePath: string, encoding?: string) => {
      const fullPath = wd(resolve(filePath));
      try {
        if (encoding === "buffer") {
          return await fs.readFile(fullPath);
        }
        return await fs.readFile(fullPath, "utf-8");
      } catch (err) {
        wrapFsError(err, filePath);
      }
    }) as CoreEnvFs["readFile"],

    stat: async (filePath) => {
      const fullPath = wd(resolve(filePath));
      try {
        // WebContainer has no direct stat — probe via readdir parent / read
        const parent = fullPath === "/" ? "/" : fullPath.slice(0, fullPath.lastIndexOf("/")) || "/";
        const base = fullPath === "/" ? "" : fullPath.slice(fullPath.lastIndexOf("/") + 1);
        if (fullPath === "/") {
          return { isDirectory: true, isFile: false, size: 0, mtime: new Date(0) };
        }
        const entries = await fs.readdir(parent, { withFileTypes: true });
        const entry = entries.find((e) => e.name === base);
        if (!entry) {
          throw new FileError("not_found", `ENOENT: ${filePath}`, filePath);
        }
        if (entry.isDirectory()) {
          return { isDirectory: true, isFile: false, size: 0, mtime: new Date(0) };
        }
        const data = await fs.readFile(fullPath);
        return { isDirectory: false, isFile: true, size: data.byteLength, mtime: new Date(0) };
      } catch (err) {
        if (err instanceof FileError) throw err;
        wrapFsError(err, filePath);
      }
    },

    readdir: async (dirPath) => {
      const fullPath = wd(resolve(dirPath));
      try {
        const entries = await fs.readdir(fullPath, { withFileTypes: true });
        return entries.map((entry) => ({
          name: entry.name,
          type: entry.isDirectory() ? ("directory" as const) : ("file" as const),
        }));
      } catch (err) {
        wrapFsError(err, dirPath);
      }
    },

    writeFile: async (filePath, content) => {
      const fullPath = wd(resolve(filePath));
      try {
        const parent = fullPath.slice(0, fullPath.lastIndexOf("/")) || "/";
        if (parent !== "/") {
          await fs.mkdir(parent, { recursive: true });
        }
        await fs.writeFile(fullPath, content);
        onChange?.();
      } catch (err) {
        wrapFsError(err, filePath);
      }
    },

    mkdir: async (dirPath) => {
      const fullPath = wd(resolve(dirPath));
      try {
        await fs.mkdir(fullPath, { recursive: true });
        onChange?.();
      } catch (err) {
        wrapFsError(err, dirPath);
      }
    },

    exists: async (filePath) => {
      const fullPath = wd(resolve(filePath));
      try {
        if (fullPath === "/") return true;
        const parent = fullPath.slice(0, fullPath.lastIndexOf("/")) || "/";
        const base = fullPath.slice(fullPath.lastIndexOf("/") + 1);
        const entries = await fs.readdir(parent);
        return entries.includes(base);
      } catch {
        return false;
      }
    },

    remove: async (filePath) => {
      const fullPath = wd(resolve(filePath));
      try {
        await fs.rm(fullPath, { recursive: true, force: true });
        onChange?.();
      } catch (err) {
        wrapFsError(err, filePath);
      }
    },

    appendFile: async (filePath, content) => {
      const fullPath = wd(resolve(filePath));
      try {
        let existing = "";
        try {
          existing = await fs.readFile(fullPath, "utf-8");
        } catch {
          // create new
        }
        const parent = fullPath.slice(0, fullPath.lastIndexOf("/")) || "/";
        if (parent !== "/") {
          await fs.mkdir(parent, { recursive: true });
        }
        await fs.writeFile(fullPath, existing + content);
        onChange?.();
      } catch (err) {
        wrapFsError(err, filePath);
      }
    },

    rename: async (oldPath, newPath) => {
      const from = wd(resolve(oldPath));
      const to = wd(resolve(newPath));
      try {
        const parent = to.slice(0, to.lastIndexOf("/")) || "/";
        if (parent !== "/") {
          await fs.mkdir(parent, { recursive: true });
        }
        await fs.rename(from, to);
        onChange?.();
      } catch (err) {
        wrapFsError(err, oldPath);
      }
    },
  };
}
