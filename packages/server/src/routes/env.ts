import { Hono } from "hono";

import { getServerEnv } from "../server-runtime.js";

import { destroyAllServerJobs } from "./command.js";

const SENSITIVE_EXACT = new Set([
  "API_KEY",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "NPM_TOKEN",
  "SSH_AUTH_SOCK",
  "GPG_KEY",
  "GOOGLE_APPLICATION_CREDENTIALS",
]);

const SENSITIVE_PATTERNS = [/password/i, /secret/i, /credential/i, /private_key/i, /_API_KEY$/i, /^API_KEY$/i];

export function filterSensitiveVars(vars: Record<string, string | undefined>): Record<string, string | undefined> {
  const filtered: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(vars)) {
    if (SENSITIVE_EXACT.has(key)) continue;
    if (SENSITIVE_PATTERNS.some((p) => p.test(key))) continue;
    filtered[key] = value;
  }
  return filtered;
}

/** Git metadata for the effective workspace (mirrors app `WorkspaceGitInfo`). */
export interface WorkspaceGitInfo {
  branch: string;
  shortSha: string;
  dirty: boolean;
  ahead: number;
  behind: number;
}

function parseAheadBehind(output: string): { ahead: number; behind: number } {
  const result = { ahead: 0, behind: 0 };
  const branchLine = output.split(/\n/)[0] ?? "";
  const match = branchLine.match(/\[(ahead|behind)\s+(\d+)(?:,\s*(ahead|behind)\s+(\d+))?\]/);
  if (!match) return result;

  const firstKey = match[1];
  const firstVal = Number(match[2]);
  if (firstKey === "ahead") result.ahead = firstVal;
  else result.behind = firstVal;

  if (match[3] && match[4]) {
    const secondKey = match[3];
    const secondVal = Number(match[4]);
    if (secondKey === "ahead") result.ahead = secondVal;
    else result.behind = secondVal;
  }
  return result;
}

/**
 * Resolve git metadata for `rootPath` through the effective (final) CoreEnv.
 * Runs on the server process so it reflects the workspace the agent actually
 * operates on — including when the server itself is wired to a remote env.
 */
async function fetchWorkspaceGitInfo(rootPath: string): Promise<WorkspaceGitInfo | null> {
  if (!rootPath) return null;
  const env = getServerEnv();
  try {
    const inside = await env.runCommand("git rev-parse --is-inside-work-tree", { cwd: rootPath });
    if (inside.exitCode !== 0 || inside.stdout.trim() !== "true") {
      return null;
    }
    const [branchResult, shaResult, statusResult, aheadBehindResult] = await Promise.all([
      env.runCommand("git rev-parse --abbrev-ref HEAD", { cwd: rootPath }),
      env.runCommand("git rev-parse --short HEAD", { cwd: rootPath }),
      env.runCommand("git status --porcelain", { cwd: rootPath }),
      env.runCommand("git status -sb --porcelain", { cwd: rootPath }),
    ]);
    const shortSha = shaResult.exitCode === 0 ? shaResult.stdout.trim() : "";
    let branch = branchResult.exitCode === 0 ? branchResult.stdout.trim() : "";
    if (!branch || branch === "HEAD") {
      branch = shortSha ? `detached@${shortSha}` : "detached";
    }
    const dirty = statusResult.exitCode === 0 && statusResult.stdout.trim().length > 0;
    const { ahead, behind } = parseAheadBehind(aheadBehindResult.exitCode === 0 ? aheadBehindResult.stdout : "");
    return { branch, shortSha, dirty, ahead, behind };
  } catch {
    return null;
  }
}

export const envRoutes = new Hono()
  .get("/info", async (c) => {
    const env = getServerEnv();
    const [platform, arch, homedir] = await Promise.all([env.getPlatform(), env.getArch(), env.homedir()]);
    return c.json({ rootPath: env.rootPath, platform, arch, homedir, sep: env.path.getSep() });
  })
  .get("/workspace", async (c) => {
    const env = getServerEnv();
    const rootPath = env.rootPath;
    const git = await fetchWorkspaceGitInfo(rootPath);
    return c.json({ rootPath, git });
  })
  .get("/vars", async (c) => {
    const vars = await getServerEnv().getEnv();
    return c.json(filterSensitiveVars(vars));
  })
  .post("/destroy", async (c) => {
    destroyAllServerJobs();
    const env = getServerEnv();
    if (env.destroy) {
      await env.destroy();
    }
    return c.json({ ok: true });
  });
