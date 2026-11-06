/**
 * Persist plan markdown under `.agents/plans/`.
 */

import { join } from "pathe";

import { slugifyName } from "../../utils/slug.js";
import { AGENT_DATA_DIR } from "../../utils/workspace-paths.js";

import { extractPlan } from "./extract-plan.js";

import type { ResolvedCoreEnv } from "../../env";

export const PLAN_STORE_DIR = `${AGENT_DATA_DIR}/plans`;

/**
 * The workspace this plan operation belongs to.
 *
 * Required on purpose: falling back to the ambient `getEnv()` made a second runtime in the same
 * process write its plan into whichever workspace registered last. Every caller has an env in
 * scope; a missing one is a wiring bug, not a reason to guess.
 */
function requireEnv(env: ResolvedCoreEnv | undefined): ResolvedCoreEnv {
  if (!env) throw new Error("plan store requires a workspace CoreEnv");
  return env;
}

export function slugifyPlanName(input: string): string {
  return slugifyName(input, { unicode: false, maxLength: 48, fallbackPrefix: "plan" });
}

export function planFilePath(name: string): string {
  const base = name.endsWith(".md") ? name.slice(0, -3) : name;
  const safe = slugifyPlanName(base);
  return join(PLAN_STORE_DIR, `${safe}.md`);
}

export async function ensurePlanStoreDir(env?: ResolvedCoreEnv): Promise<string> {
  const e = requireEnv(env);
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
  const e = requireEnv(env);
  await ensurePlanStoreDir(e);
  const hint = nameHint?.trim() || extractPlan(markdown)?.steps[0]?.text || "plan";
  const relative = options?.existingRelativePath?.trim() || planFilePath(hint);
  const absolute = join(e.rootPath, relative);
  await e.fs.writeFile(absolute, markdown.endsWith("\n") ? markdown : `${markdown}\n`);
  return { path: relative };
}

export async function loadPlanFile(name: string, env?: ResolvedCoreEnv): Promise<{ path: string; markdown: string }> {
  const e = requireEnv(env);
  const relative = planFilePath(name);
  const absolute = join(e.rootPath, relative);
  const markdown = await e.fs.readFile(absolute);
  return { path: relative, markdown };
}

/** Read a plan file by workspace-relative path (e.g. from session `planFilePath`). */
export async function readPlanFileAtRelativePath(relativePath: string, env?: ResolvedCoreEnv): Promise<string | null> {
  const trimmed = relativePath.trim();
  if (!trimmed) return null;
  const e = requireEnv(env);
  try {
    return await e.fs.readFile(join(e.rootPath, trimmed));
  } catch {
    return null;
  }
}

export async function listPlanFiles(env?: ResolvedCoreEnv): Promise<string[]> {
  const e = requireEnv(env);
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
