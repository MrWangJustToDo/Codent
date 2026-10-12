/**
 * SkillRegistry - Manages loaded skills and provides lookup methods.
 *
 * Central registry for skills loaded from multiple directories, plus skills that
 * are registered programmatically (built-ins).
 *
 * Precedence is **first registered wins**. Directory skills are loaded first and
 * built-ins last, so a user/project skill always overrides a built-in of the same
 * name — the bundled default must never shadow the user's own file.
 *
 * @example
 * ```typescript
 * const registry = new SkillRegistry({ rootPath: "/project" });
 * await registry.loadFromDirectories([{ path: ".agents/skills", source: "project" }]);
 * registry.registerAll(BUILTIN_SKILLS);
 *
 * const skills = registry.list();
 * const skill = registry.get("git-workflow");
 * ```
 */

import { SkillLoader } from "./skill-loader.js";

import type { Skill, SkillSource, SkillSummary } from "./types.js";
import type { ResolvedCoreEnv } from "../../env";

// ============================================================================
// Types
// ============================================================================

export interface SkillRegistryConfig {
  /** Root path for resolving relative paths */
  rootPath: string;
  /** Workspace env for reading skill files (runtime-provided; ambient by default). */
  env?: ResolvedCoreEnv;
  /** Optional sink for override notices (duplicate names). */
  logger?: SkillRegistryLogger;
}

/** Minimal logging surface — avoids a dependency on the agent log implementation. */
export interface SkillRegistryLogger {
  warn: (message: string) => void;
}

/** A directory to scan, paired with the source its skills are attributed to. */
export interface SkillDirectory {
  path: string;
  source: SkillSource;
}

// ============================================================================
// SkillRegistry Class
// ============================================================================

/**
 * Central registry for managing loaded skills.
 */
export class SkillRegistry {
  private rootPath: string;
  private logger?: SkillRegistryLogger;
  private skills: Map<string, Skill> = new Map();
  private loader: SkillLoader;

  constructor(config: SkillRegistryConfig) {
    this.rootPath = config.rootPath;
    this.logger = config.logger;
    this.loader = new SkillLoader({
      rootPath: config.rootPath,
      ...(config.env ? { env: config.env } : {}),
    });
  }

  /**
   * Load skills from multiple directories.
   *
   * Paths are relative to rootPath or absolute. A bare string is attributed the
   * `project` source; pass a {@link SkillDirectory} to attribute another source
   * (`AGENT_SKILL_DIRS` / `~/.agents/skills` → `user`).
   *
   * First loaded skill wins in case of name conflicts.
   *
   * @param dirs - Directory paths (relative to rootPath or absolute), optionally tagged
   */
  async loadFromDirectories(dirs: Array<string | SkillDirectory>): Promise<void> {
    for (const entry of dirs) {
      const dir = typeof entry === "string" ? entry : entry.path;
      const source: SkillSource = typeof entry === "string" ? "project" : entry.source;

      // Normalize: remove leading ./ if present
      const normalizedPath = dir.startsWith("./") ? dir.slice(2) : dir;

      const dirSkills = await this.loader.loadFromDirectory(normalizedPath, source);

      // Add skills to registry, first loaded wins
      for (const [name, skill] of dirSkills) {
        this.register(skill, { key: name });
      }
    }
  }

  /**
   * Register one skill.
   *
   * First registered wins: an existing skill of the same name is kept and the
   * incoming one is skipped with a notice, so a user skill is never replaced by a
   * built-in and a collision is never silent.
   *
   * @returns true when the skill was registered, false when it was shadowed
   */
  register(skill: Skill, options?: { key?: string }): boolean {
    const name = options?.key ?? skill.name;
    const existing = this.skills.get(name);

    if (existing) {
      this.logger?.warn(
        `Skill "${name}" from ${describe(skill)} ignored — already loaded from ${describe(existing)} (first loaded wins)`
      );
      return false;
    }

    this.skills.set(name, skill);
    return true;
  }

  /**
   * Register many skills (e.g. a built-in set).
   *
   * @returns the number of skills actually registered
   */
  registerAll(skills: readonly Skill[]): number {
    let registered = 0;
    for (const skill of skills) {
      if (this.register(skill)) registered++;
    }
    return registered;
  }

  /**
   * List all loaded skills with their summaries.
   *
   * @returns Array of skill summaries (name + description + source)
   */
  list(): SkillSummary[] {
    return Array.from(this.skills.values()).map((skill) => ({
      name: skill.name,
      description: skill.description,
      source: skill.source,
    }));
  }

  /**
   * Get a specific skill by name.
   *
   * @param name - Skill name to look up
   * @returns Skill object or undefined if not found
   */
  get(name: string): Skill | undefined {
    return this.skills.get(name);
  }

  /**
   * Get formatted descriptions for all skills.
   *
   * Returns a string suitable for displaying available skills.
   *
   * @returns Formatted skill list
   */
  getDescriptions(): string {
    if (this.skills.size === 0) {
      return "(no skills available)";
    }

    const lines: string[] = [];
    for (const [name, skill] of this.skills) {
      lines.push(`  - ${name} (${skill.source}): ${skill.description}`);
    }
    return lines.join("\n");
  }

  /**
   * Get the number of loaded skills.
   */
  get size(): number {
    return this.skills.size;
  }

  /**
   * Check if a skill exists.
   */
  has(name: string): boolean {
    return this.skills.has(name);
  }

  /**
   * Get all skill names.
   */
  names(): string[] {
    return Array.from(this.skills.keys());
  }

  /**
   * Names of the currently loaded built-in skills.
   */
  builtinNames(): string[] {
    return Array.from(this.skills.values())
      .filter((skill) => skill.source === "builtin")
      .map((skill) => skill.name);
  }

  /**
   * Clear all loaded skills (including built-ins), so a re-register is idempotent.
   */
  clear(): void {
    this.skills.clear();
  }
}

/** Human-readable origin for an override notice. */
function describe(skill: Skill): string {
  return skill.source === "builtin" ? "a built-in skill" : `"${skill.path}"`;
}
