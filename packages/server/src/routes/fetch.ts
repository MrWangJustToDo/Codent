import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";

import { getServerEnv } from "../server-runtime.js";

const fetchRequestSchema = z.object({
  url: z.string(),
  method: z.string().optional(),
  headers: z.record(z.string(), z.string()).optional(),
  body: z.string().optional(),
});

export const fetchRoutes = new Hono().post("/proxy", zValidator("json", fetchRequestSchema), async (c) => {
  try {
    const { url, method, headers, body } = c.req.valid("json");

    const controller = new AbortController();
    c.req.raw.signal.addEventListener("abort", () => controller.abort(), { once: true });

    const res = await getServerEnv().fetch(url, { method, headers, body, signal: controller.signal });

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

    if (isText) {
      responseBody = await res.text();
      encoding = "text";
    } else {
      const buffer = new Uint8Array(await res.arrayBuffer());
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
