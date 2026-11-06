/**
 * One rule for scoping an extension owner id to an agent.
 *
 * The tool registry belongs to one agent, but an owner id is not unique by itself: the same
 * `defineServerTool` object can be handed to two agents, and the default owner (the tool name) then
 * collides. Two agents would share a claim and a disable on one could release the other's. The rule
 * lives here, once, because both the agent (tool/presentation registration) and the extension runner
 * (output-decorator ownership) need it and a second copy is how the two halves drift.
 *
 * `:` separates the two halves; an agent id is unique per agent, so the scoped id is too. Owner ids
 * are matched by string equality only — nothing parses them back apart.
 */
export function scopeExtensionOwnerId(agentId: string, extensionId: string): string {
  return `${agentId}:${extensionId}`;
}
