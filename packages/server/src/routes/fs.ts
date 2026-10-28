import { FileError, errorMessage } from "@codent/core";
import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";

import { getServerEnv } from "../server-runtime.js";

const pathSchema = z.object({ path: z.string() });

function handleFsError(err: unknown): { body: Record<string, unknown>; status: 400 | 500 } {
  if (err instanceof FileError) {
    return {
      body: { error: true, name: "FileError", code: err.code, message: err.message, path: err.path },
      status: 400,
    };
  }
  if (err instanceof Error && "code" in err) {
    const nodeErr = err as NodeJS.ErrnoException;
    const codeMap: Record<string, string> = {
      ENOENT: "not_found",
      EACCES: "permission_denied",
      EPERM: "permission_denied",
      EISDIR: "is_directory",
      ENOTDIR: "not_directory",
    };
    const mapped = nodeErr.code ? codeMap[nodeErr.code] : undefined;
    if (mapped) {
      return {
        body: { error: true, name: "FileError", code: mapped, message: err.message, path: nodeErr.path ?? "" },
        status: 400,
      };
    }
  }
  const message = errorMessage(err);
  return { body: { error: true, name: "Error", code: "unknown", message }, status: 500 };
}

export const fsRoutes = new Hono()
  .post(
    "/readFile",
    zValidator(
      "json",
      z.object({
        path: z.string(),
        /** `"base64"` / `"buffer"` → binary as base64 string; otherwise UTF-8 text. */
        encoding: z.enum(["utf8", "base64", "buffer"]).optional(),
        /**
         * Optional byte window `[start, end)` — mirrors the optional `CoreEnvFs.readFileRange`.
         *
         * Without this a remote `list()` has to ship every session log whole (217 MB in this
         * workspace's own `.agents/sessions/`) just to find each file's last line. Both bounds
         * must be present together; text encoding only, since a byte window on a binary payload
         * has no consumer.
         */
        start: z.number().int().nonnegative().optional(),
        end: z.number().int().nonnegative().optional(),
      })
    ),
    async (c) => {
      try {
        const { path, encoding, start, end } = c.req.valid("json");
        const env = getServerEnv();
        if (encoding === "base64" || encoding === "buffer") {
          const bytes = await env.fs.readFile(path, "buffer");
          return c.json({ content: env.base64Encode(bytes), encoding: "base64" as const });
        }
        if (start !== undefined && end !== undefined) {
          // Prefer a real range read; on a server env without it (a remote env chained through
          // this server) fall back to slicing a full read. Slice BYTES (a buffer), not UTF-16
          // code units of a string, or a multi-byte character before `start` shifts the window.
          if (env.fs.readFileRange) {
            return c.json({ content: await env.fs.readFileRange(path, start, end) });
          }
          const bytes = await env.fs.readFile(path, "buffer");
          return c.json({ content: new TextDecoder().decode(bytes.subarray(start, end)) });
        }
        const content = await env.fs.readFile(path);
        return c.json({ content });
      } catch (err) {
        const { body, status } = handleFsError(err);
        return c.json(body, status);
      }
    }
  )
  .post("/stat", zValidator("json", pathSchema), async (c) => {
    try {
      const { path } = c.req.valid("json");
      const stat = await getServerEnv().fs.stat(path);
      return c.json({
        isDirectory: stat.isDirectory,
        isFile: stat.isFile,
        size: stat.size,
        mtime: stat.mtime.toISOString(),
      });
    } catch (err) {
      const { body, status } = handleFsError(err);
      return c.json(body, status);
    }
  })
  .post("/realpath", zValidator("json", pathSchema), async (c) => {
    try {
      const { path } = c.req.valid("json");
      const env = getServerEnv();
      if (!env.fs.realpath) {
        return c.json({ error: true, name: "Error", code: "not_supported", message: "realpath not available" }, 400);
      }
      return c.json({ path: await env.fs.realpath(path) });
    } catch (err) {
      const { body, status } = handleFsError(err);
      return c.json(body, status);
    }
  })
  .post("/readdir", zValidator("json", pathSchema), async (c) => {
    try {
      const { path } = c.req.valid("json");
      const entries = await getServerEnv().fs.readdir(path);
      return c.json({
        entries: entries.map((e) => ({
          name: e.name,
          type: e.type,
          size: e.size,
          modified: e.modified?.toISOString(),
        })),
      });
    } catch (err) {
      const { body, status } = handleFsError(err);
      return c.json(body, status);
    }
  })
  .post(
    "/writeFile",
    zValidator(
      "json",
      z.object({
        path: z.string(),
        content: z.string(),
        /** When `"base64"`, `content` is decoded to bytes before write. Default: UTF-8 text. */
        encoding: z.enum(["utf8", "base64"]).optional(),
      })
    ),
    async (c) => {
      try {
        const { path, content, encoding } = c.req.valid("json");
        const env = getServerEnv();
        if (encoding === "base64") {
          await env.fs.writeFile(path, env.base64Decode(content));
        } else {
          await env.fs.writeFile(path, content);
        }
        return c.json({ ok: true });
      } catch (err) {
        const { body, status } = handleFsError(err);
        return c.json(body, status);
      }
    }
  )
  .post("/mkdir", zValidator("json", pathSchema), async (c) => {
    try {
      const { path } = c.req.valid("json");
      await getServerEnv().fs.mkdir(path);
      return c.json({ ok: true });
    } catch (err) {
      const { body, status } = handleFsError(err);
      return c.json(body, status);
    }
  })
  .post("/exists", zValidator("json", pathSchema), async (c) => {
    try {
      const { path } = c.req.valid("json");
      const exists = await getServerEnv().fs.exists(path);
      return c.json({ exists });
    } catch (err) {
      const { body, status } = handleFsError(err);
      return c.json(body, status);
    }
  })
  .post("/remove", zValidator("json", pathSchema), async (c) => {
    try {
      const { path } = c.req.valid("json");
      await getServerEnv().fs.remove(path);
      return c.json({ ok: true });
    } catch (err) {
      const { body, status } = handleFsError(err);
      return c.json(body, status);
    }
  })
  .post("/appendFile", zValidator("json", z.object({ path: z.string(), content: z.string() })), async (c) => {
    try {
      const { path, content } = c.req.valid("json");
      const env = getServerEnv();
      if (!env.fs.appendFile) {
        return c.json({ error: true, name: "Error", code: "not_supported", message: "appendFile not available" }, 400);
      }
      await env.fs.appendFile(path, content);
      return c.json({ ok: true });
    } catch (err) {
      const { body, status } = handleFsError(err);
      return c.json(body, status);
    }
  })
  .post("/rename", zValidator("json", z.object({ oldPath: z.string(), newPath: z.string() })), async (c) => {
    try {
      const { oldPath, newPath } = c.req.valid("json");
      const env = getServerEnv();
      if (!env.fs.rename) {
        return c.json({ error: true, name: "Error", code: "not_supported", message: "rename not available" }, 400);
      }
      await env.fs.rename(oldPath, newPath);
      return c.json({ ok: true });
    } catch (err) {
      const { body, status } = handleFsError(err);
      return c.json(body, status);
    }
  })
  .post("/mimeType", zValidator("json", pathSchema), async (c) => {
    try {
      const { path } = c.req.valid("json");
      const env = getServerEnv();
      if (!env.getMimeType) {
        return c.json({ mimeType: false as const });
      }
      const mimeType = await env.getMimeType(path);
      return c.json({ mimeType });
    } catch (err) {
      const { body, status } = handleFsError(err);
      return c.json(body, status);
    }
  });
