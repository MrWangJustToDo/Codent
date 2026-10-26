/**
 * Built-in Skills extension — exposes SKILL.md domain knowledge to the agent.
 *
 * Provides:
 * - `list_skills` tool: list available skills (name + description)
 * - `load_skill` tool: load the full SKILL.md content for a skill
 * - Turn-context injection of the available-skills index into its own `<ctx kind=codent-skills>` section
 *   (progressive disclosure: only names + descriptions are always visible; the
 *   full body is loaded on demand via `load_skill`).
 *
 * Skills are discovered from the directories passed to the injected
 * `SkillRegistry` (see `getDefaultSkillDirs`). The extension registers no
 * scripts/assets; skill content may reference relative paths resolved by the
 * agent's own fs tools.
 *
 * Runtime-agnostic: all I/O goes through the injected `SkillRegistry`, which
 * uses the global CoreEnv (`getEnv()`).
 */

import { DISCOVERY_TOOL_NAME } from "@tanstack/ai";

import { BUILTIN_EXTENSION_ORDER } from "../extension/dispatch-order.js";
import { isProjectedModelContent } from "../tools/runtime/projected-model-content.js";

import type { SkillRegistry } from "./skill-registry.js";
import type { ExtensionAPI, ExtensionContext } from "../extension/types.js";

// ============================================================================
// Config
// ============================================================================

/** Fine-grained configuration for the built-in skills extension. */
export interface SkillsExtensionConfig {
  /**
   * Disable the on-demand tools (list_skills/load_skill) and only inject the
   * index into turn context. Default: false (tools registered).
   */
  toolsDisabled?: boolean;
  /**
   * Disable injecting the skills index into turn context. Default: false
   * (index injected when skills exist).
   */
  indexDisabled?: boolean;
  /**
   * Drop the built-in skills (e.g. `write-extension`) while keeping skills loaded
   * from directories. Default: false (built-ins registered).
   */
  builtinsDisabled?: boolean;
}

// ============================================================================
// Extension factory
// ============================================================================

export interface CreateSkillsExtensionOptions {
  /** Pre-loaded skill registry (created + populated by the agent factory). */
  skillRegistry: SkillRegistry;
  /** Fine-grained config. */
  config?: SkillsExtensionConfig;
}

/** Create the built-in Skills extension. */
export function createSkillsExtension(options: CreateSkillsExtensionOptions): ExtensionAPI {
  const { skillRegistry, config } = options;
  return {
    id: "codent-skills",
    // Built-ins are the baseline: they run first in interceptor/transformer chains and lose a
    // same-name tool to a user extension. Loading last must not mean "runs last, wins".
    order: BUILTIN_EXTENSION_ORDER,
    name: "Skills",
    version: "1.0.0",
    description:
      "SKILL.md domain knowledge: list_skills/load_skill tools + available-skills index injected into turn context",
    async activate(ctx) {
      await activateSkills(ctx, skillRegistry, config);
    },
  };
}

async function activateSkills(
  ctx: ExtensionContext,
  skillRegistry: SkillRegistry,
  config?: SkillsExtensionConfig
): Promise<void> {
  const z = ctx.z;

  // Built-ins never appear when disabled. Filtering here (rather than at the
  // registry) keeps `/skill`, the index, and list_skills consistent — a disabled
  // built-in must not be loadable by name either.
  const visibleSkills = () =>
    skillRegistry.list().filter((s) => config?.builtinsDisabled !== true || s.source !== "builtin");
  const visibleNames = () => visibleSkills().map((s) => s.name);

  if (config?.toolsDisabled !== true) {
    ctx.registerTool({
      name: "list_skills",
      present: { category: "searches" as const },
      // Lazy: the <skills> index in turn context already carries name + source +
      // description for every skill, so the eager schema was ~396 bytes of prompt
      // per turn restating what the model can already read. It was never called
      // across 195 root runs. Both the index (below) and the description name
      // DISCOVERY_TOOL_NAME, so nothing has to guess how to reach it.
      lazy: true,
      description: `List available skills (name + brief description).

Prefer the <skills> index already in the turn context. Call this only to refresh the list.
Then use load_skill to load the full content of a specific skill.

This is a lazy tool: discover it via ${DISCOVERY_TOOL_NAME} before calling.`,
      inputSchema: z.object({}),
      outputSchema: z.object({
        skills: z.array(z.object({ name: z.string(), description: z.string(), source: z.string() })),
        count: z.number(),
      }),
      execute: async () => {
        const skills = visibleSkills().map((s) => ({ name: s.name, description: s.description, source: s.source }));
        return {
          skills,
          count: skills.length,
        };
      },
      // Only send skills to the LLM — count is derived, avoid extra tokens.
      toModelOutput({ output }) {
        if (isProjectedModelContent(output)) return output;
        const { skills } = output as { skills?: Array<{ name: string; description: string; source: string }> };
        const lines = skills?.map((s) => `- ${s.name} (${s.source}): ${s.description}`) ?? [];
        return `Available skills:\n${lines.join("\n")}`;
      },
    });

    ctx.registerTool({
      name: "load_skill",
      present: { category: "reads" as const },
      description: `Load the full content of a skill by name.

Use this after list_skills (or the <skills> index) to load specific domain knowledge.
The skill content will be returned wrapped in <skill name="..."> tags.

Skills contain specialized instructions, workflows, or domain expertise
that help you complete specific types of tasks.`,
      inputSchema: z.object({
        name: z.string().describe("The name of the skill to load"),
      }),
      outputSchema: z.object({
        name: z.string(),
        content: z.string(),
      }),
      execute: async (input) => {
        const { name } = (input ?? {}) as { name?: string };
        const skill = skillRegistry.get(String(name));
        if (!skill || (config?.builtinsDisabled === true && skill.source === "builtin")) {
          const available = visibleNames();
          const availableList =
            available.length > 0 ? `Available skills: ${available.join(", ")}` : "No skills are currently loaded.";
          throw new Error(`Unknown skill '${String(name)}'. ${availableList}`);
        }
        const content = `<skill name="${skill.name}">\n${skill.body}\n</skill>`;
        return { name: skill.name, content };
      },
      // Only send content to the LLM — name is echoed in the input.
      toModelOutput({ output }) {
        if (isProjectedModelContent(output)) return output;
        return (output as { content: string }).content;
      },
    });
  }

  // Inject the available-skills index into per-turn context (progressive disclosure).
  if (config?.indexDisabled !== true) {
    ctx.registerContextProvider({
      content: () => {
        const skills = visibleSkills();
        if (skills.length === 0) return undefined;
        const lines = skills.map((s) => `- ${s.name} (${s.source}): ${s.description}`);
        return [
          "<skills>",
          "Use `load_skill` to load any of these skills when relevant to the user's task.",
          "The index lists name + description summaries only — do not infer or follow a skill's instructions until its full content has been loaded via `load_skill`.",
          `list_skills is a lazy tool — discover it via ${DISCOVERY_TOOL_NAME} before calling.`,
          "",
          ...lines,
          "</skills>",
        ].join("\n");
      },
      disabledContent: () =>
        "Skills extension is disabled — list_skills/load_skill tools and the available-skills index injected into turn context are unavailable.",
    });
  }

  // `/skill <name>` — load a skill by expanding its full body into the session as a
  // user message, driving the agent to act on the skill (opencode-style command).
  ctx.registerCommand({
    name: "skill",
    description: "Load a skill and let the agent act on it: /skill <name>. With no name, lists available skills.",
    getOptions: () =>
      visibleSkills().map((s) => ({
        label: s.name,
        value: s.name,
        description: s.description,
      })),
    execute: async (args) => {
      const name = args[0]?.trim();
      if (!name) {
        const available = visibleNames();
        return available.length > 0 ? `Available skills: ${available.join(", ")}` : "No skills are currently loaded.";
      }
      const skill = skillRegistry.get(name);
      if (!skill || (config?.builtinsDisabled === true && skill.source === "builtin")) {
        const available = visibleNames();
        const availableList =
          available.length > 0 ? `Available skills: ${available.join(", ")}` : "No skills are currently loaded.";
        return `Unknown skill '${name}'. ${availableList}`;
      }
      return `Loaded skill '${skill.name}'. Agent will now act on it.`;
    },
    // Inject the full skill body into the session so the agent sees the
    // workflow and acts on it (matches opencode's skill-as-command template).
    // Any text appended after /skill <name> is merged into the injected message
    // so the user can specify what they want done with the skill.
    injectMessage: async (args) => {
      const name = args[0]?.trim();
      if (!name) return undefined;
      const skill = skillRegistry.get(name);
      if (!skill || (config?.builtinsDisabled === true && skill.source === "builtin")) return undefined;
      const followup = args.slice(1).join(" ").trim();
      const body = `<skill name="${skill.name}">\n${skill.body}\n</skill>`;
      if (!followup) return body;
      return `${body}\n\nUser request with this skill:\n${followup}`;
    },
  });

  ctx.logger.info(`Skills extension activated (${skillRegistry.size} skills)`);
}
