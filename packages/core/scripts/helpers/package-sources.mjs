/**
 * Source roots shared by the repo-wide guards (file size, JSDoc attachment).
 *
 * "Every package's `src`" was only true for packages that HAVE one: `packages/extension` keeps its
 * sources in WXT's layout (`entrypoints/ components/ adapters/ hooks/ devtool/ shims/`), so the
 * guards' `catch { continue; }` skipped that package entirely while still claiming coverage. One
 * resolution rule here means the two guards cannot disagree about what "the package's source" is.
 */

import { readdir } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

/** `packages/core/scripts/helpers` → repo root. */
export const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
export const PACKAGES_DIR = join(REPO_ROOT, "packages");

/**
 * Never source, even inside a package that has no `src`:
 * build output, dependencies, WXT state, and the trees the guards deliberately leave out
 * (tests, build scripts, static assets).
 */
const IGNORED_DIRS = new Set([
  "node_modules",
  "dist",
  ".wxt",
  ".output",
  ".turbo",
  "coverage",
  "test",
  "tests",
  "__tests__",
  "scripts",
  "public",
  "assets",
]);

async function walk(dir, extensions, out) {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const absolute = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (IGNORED_DIRS.has(entry.name)) continue;
      await walk(absolute, extensions, out);
    } else if (entry.isFile() && extensions.some((extension) => entry.name.endsWith(extension))) {
      out.push(absolute);
    }
  }
}

/** Every package directory name, sorted. */
export async function packageNames() {
  const entries = await readdir(PACKAGES_DIR, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

/**
 * One package's source files, with a repo-relative id (`<pkg>/<path>`).
 *
 * `src` wins when present; a package without one is walked from its root, minus {@link IGNORED_DIRS}.
 */
export async function collectPackageSources(pkg, extensions = [".ts", ".tsx"]) {
  let root = join(PACKAGES_DIR, pkg, "src");
  try {
    await readdir(root);
  } catch {
    root = join(PACKAGES_DIR, pkg);
  }
  const absoluteFiles = [];
  await walk(root, extensions, absoluteFiles);
  return absoluteFiles.map((absolute) => ({
    absolute,
    relative: `${pkg}/${relative(root, absolute).split(sep).join("/")}`,
  }));
}
