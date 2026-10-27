/**
 * Persist plan markdown under `.agents/plans/`.
 */

import { join } from "pathe";

import { getEnv, type ResolvedCoreEnv } from "../../env";
import { slugifyName } from "../../utils/slug.js";
import { AGENT_DATA_DIR } from "../../utils/workspace-paths.js";

import { extractPlan } from "./extract-plan.js";

export const PLAN_STORE_DIR = `${AGENT_DATA_DIR}/plans`;

export function slugifyPlanName(input: string): string {
  return slugifyName(input, { unicode: false, maxLength: 48, fallbackPrefix: "plan" });
}

export function planFilePath(name: string): string {
  const base = name.endsWith(".md") ? name.slice(0, -3) : name;
  const safe = slugifyPlanName(base);
  return join(PLAN_STORE_DIR, `${safe}.md`);
}

export async function ensurePlanStoreDir(env?: ResolvedCoreEnv): Promise<string> {
  const e = env ?? getEnv();
  const dir = join(e.rootPath, PLAN_STORE_DIR);
  await e.fs.mkdir(dir);
  return dir;
}

export type SavePlanFileOptions = {
  /** When set, overwrite this relative path instead of slugifying a new name. */
  existingRelativePath?: string;
};

export async function savePlanFile(
  markdown: string,
  nameHint?: string,
  options?: SavePlanFileOptions,
  env?: ResolvedCoreEnv
): Promise<{ path: string }> {
  const e = env ?? getEnv();
  await ensurePlanStoreDir(e);
  const hint = nameHint?.trim() || extractPlan(markdown)?.steps[0]?.text || "plan";
  const relative = options?.existingRelativePath?.trim() || planFilePath(hint);
  const absolute = join(e.rootPath, relative);
  await e.fs.writeFile(absolute, markdown.endsWith("\n") ? markdown : `${markdown}\n`);
  return { path: relative };
}

export async function loadPlanFile(name: string, env?: ResolvedCoreEnv): Promise<{ path: string; markdown: string }> {
  const e = env ?? getEnv();
  const relative = planFilePath(name);
  const absolute = join(e.rootPath, relative);
  const markdown = await e.fs.readFile(absolute);
  return { path: relative, markdown };
}

/** Read a plan file by workspace-relative path (e.g. from session `planFilePath`). */
export async function readPlanFileAtRelativePath(relativePath: string, env?: ResolvedCoreEnv): Promise<string | null> {
  const trimmed = relativePath.trim();
  if (!trimmed) return null;
  try {
    const e = env ?? getEnv();
    return await e.fs.readFile(join(e.rootPath, trimmed));
  } catch {
    return null;
  }
}

export async function listPlanFiles(env?: ResolvedCoreEnv): Promise<string[]> {
  const e = env ?? getEnv();
  const dir = join(e.rootPath, PLAN_STORE_DIR);
  try {
    const entries = await e.fs.readdir(dir);
    return entries
      .map((e) => e.name)
      .filter((name) => name.endsWith(".md"))
      .sort();
  } catch {
    return [];
  }
}
