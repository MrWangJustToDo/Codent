/**
 * One rule for scoping an extension owner id to an agent.
 *
 * The tool and presentation registries are process-global while an agent's tools are its own, so a
 * bare extension id is not a unique owner: two agents loading the same extension share it, and a
 * disable on one would release the other's claim. The rule lives here, once, because both the agent
 * (tool/presentation registration) and the extension runner (output-decorator ownership) need it and
 * a second copy is how the two halves drift.
 *
 * `:` separates the two halves; an agent id is unique per agent, so the scoped id is too. Owner ids
 * are matched by string equality only — nothing parses them back apart.
 */
export function scopeExtensionOwnerId(agentId: string, extensionId: string): string {
  return `${agentId}:${extensionId}`;
}
