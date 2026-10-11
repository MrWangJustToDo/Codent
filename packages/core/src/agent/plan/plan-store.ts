/**
 * Persist plan markdown under `.agents/plans/`.
 */

import { join } from "pathe";

import { getEnv } from "../../env";

import { extractPlan } from "./extract-plan.js";

export const PLAN_STORE_DIR = ".agents/plans";

export function slugifyPlanName(input: string): string {
  const slug = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return slug || `plan-${Date.now().toString(36)}`;
}

export function planFilePath(name: string): string {
  const base = name.endsWith(".md") ? name.slice(0, -3) : name;
  const safe = slugifyPlanName(base);
  return join(PLAN_STORE_DIR, `${safe}.md`);
}

export async function ensurePlanStoreDir(): Promise<string> {
  const env = getEnv();
  const dir = join(env.rootPath, PLAN_STORE_DIR);
  await env.fs.mkdir(dir);
  return dir;
}

export type SavePlanFileOptions = {
  /** When set, overwrite this relative path instead of slugifying a new name. */
  existingRelativePath?: string;
};

export async function savePlanFile(
  markdown: string,
  nameHint?: string,
  options?: SavePlanFileOptions
): Promise<{ path: string }> {
  const env = getEnv();
  await ensurePlanStoreDir();
  const hint = nameHint?.trim() || extractPlan(markdown)?.steps[0]?.text || "plan";
  const relative = options?.existingRelativePath?.trim() || planFilePath(hint);
  const absolute = join(env.rootPath, relative);
  await env.fs.writeFile(absolute, markdown.endsWith("\n") ? markdown : `${markdown}\n`);
  return { path: relative };
}

export async function loadPlanFile(name: string): Promise<{ path: string; markdown: string }> {
  const env = getEnv();
  const relative = planFilePath(name);
  const absolute = join(env.rootPath, relative);
  const markdown = await env.fs.readFile(absolute);
  return { path: relative, markdown };
}

/** Read a plan file by workspace-relative path (e.g. from session `planFilePath`). */
export async function readPlanFileAtRelativePath(relativePath: string): Promise<string | null> {
  const trimmed = relativePath.trim();
  if (!trimmed) return null;
  try {
    const env = getEnv();
    return await env.fs.readFile(join(env.rootPath, trimmed));
  } catch {
    return null;
  }
}

export async function listPlanFiles(): Promise<string[]> {
  const env = getEnv();
  const dir = join(env.rootPath, PLAN_STORE_DIR);
  try {
    const entries = await env.fs.readdir(dir);
    return entries
      .map((e) => e.name)
      .filter((name) => name.endsWith(".md"))
      .sort();
  } catch {
    return [];
  }
}
