import { DEFAULT_MAX_BODY_BYTES, readBodyBounded, readBodyTextBounded } from "@codent/core";
import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";

import { getServerEnv } from "../server-runtime.js";

const fetchRequestSchema = z.object({
  url: z.string(),
  method: z.string().optional(),
  headers: z.record(z.string(), z.string()).optional(),
  body: z.string().optional(),
  /** Forwarded to `fetch`; `manual` lets a caller validate each redirect hop before following it. */
  redirect: z.enum(["follow", "manual", "error"]).optional(),
});

export const fetchRoutes = new Hono().post("/proxy", zValidator("json", fetchRequestSchema), async (c) => {
  try {
    const { url, method, headers, body, redirect } = c.req.valid("json");

    // This proxy mirrors `env.fetch` for every tool and host, so it deliberately does NOT apply
    // the `webfetch` SSRF guard: a workspace agent may legitimately call a local dev server or a
    // loopback MCP endpoint. The model-driven path is guarded at the CALLER (`webfetch`), which is
    // the only one whose URL comes from model output.

    const controller = new AbortController();
    c.req.raw.signal.addEventListener("abort", () => controller.abort(), { once: true });

    const res = await getServerEnv().fetch(url, { method, headers, body, signal: controller.signal, redirect });

    const contentType = res.headers.get("content-type") || "";
    const isText =
      contentType.startsWith("text/") ||
      contentType.includes("json") ||
      contentType.includes("xml") ||
      contentType.includes("javascript") ||
      contentType.includes("html") ||
      contentType.includes("css") ||
      contentType.includes("svg");

    let responseBody: string;
    let encoding: "text" | "base64";

    // `content-length` is not a bound (it is the wire length and may be absent or lie), so the
    // body is read through the shared bounded reader: one multi-GB response used to be buffered
    // whole here, which OOMs the server and therefore every session it hosts.
    if (isText) {
      responseBody = await readBodyTextBounded(res, DEFAULT_MAX_BODY_BYTES);
      encoding = "text";
    } else {
      const buffer = await readBodyBounded(res, DEFAULT_MAX_BODY_BYTES);
      responseBody = getServerEnv().base64Encode(buffer);
      encoding = "base64";
    }

    return c.json({
      status: res.status,
      statusText: res.statusText,
      headers: Object.fromEntries(res.headers),
      body: responseBody,
      encoding,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: true, name: "Error", code: "fetch_error", message }, 500);
  }
});
