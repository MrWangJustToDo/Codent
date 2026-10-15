/**
 * Which pending approvals `--client-env` has moved to the ACP client.
 *
 * Under `--client-env` a workspace write goes out as `fs/write_text_file`, and the client decides
 * whether to allow it — it is the party that knows the user, shows the diff, and owns the file. So
 * asking the user a second time through `session/request_permission` is not extra safety: it is the
 * same question twice, and the second one is asked by an agent that is about to obey the first
 * answer anyway. This module is the one place that decides which approvals are in that position.
 *
 * It is deliberately narrow. Only two things transfer:
 *
 * - **workspace file writes** (`write_file`, `edit_file`) while the client declared
 *   `fs.writeTextFile` and the target is workspace-internal — see
 *   `AcpClientEnv.routesWriteToClient`. `.agents/**` writes stay ours, so they stay prompts.
 * - **argv execution** (`execFile`) while the client declared `terminal`. That is what
 *   glob / grep / tree do, and they carry no approval of their own — the entry exists so the rule
 *   is stated where the mapping lives rather than being silently absent.
 *
 * Everything else stays local, and each for a reason:
 *
 * - `run_command` / `exec` are free text and still run on our own shell, so their approval is still
 *   ours to ask (`packages/acp/src/client-env.ts` routes them to the fallback).
 * - `delete_file` has no ACP method at all: `fs/*` covers read and write text, nothing else. The
 *   write capability must not be read as "the client can also delete", or a destructive action
 *   loses its prompt — the one case where a wrong answer here is unrecoverable.
 * - `kill_command` reads and writes nothing on the client side. It is still approved, because the
 *   *client* cannot be credited with authorising a signal we send ourselves.
 */

import { BUILTIN_TOOL_NAMES } from "@codent/core";

import type { AcpClientCapabilities } from "./client-env.js";

/** A pending approval, as the session reports it. */
export interface PendingApproval {
  approvalId: string;
  toolName: string;
  toolCallId: string;
}

/** The piece of a tool call this policy needs: its parsed input, if it has one. */
export interface ApprovalToolInput {
  path?: string;
}

/**
 * Tools whose whole effect on the workspace is a text write, and which therefore travel as
 * `fs/write_text_file` when the client serves that capability.
 *
 * Membership is a claim about what the tool does, so it is stated by name from core's registry
 * (never a host-local string table — see `validate:host-tool-names`).
 */
const CLIENT_WRITE_TOOLS = new Set<string>([BUILTIN_TOOL_NAMES.writeFile, BUILTIN_TOOL_NAMES.editFile]);

/**
 * Whether this approval should be dropped because the client already owns the decision.
 *
 * `routesWriteToClient` is consulted with the call's own path, so a path that stays local keeps its
 * prompt. A missing path is not treated as "somewhere harmless": without it we cannot show the
 * write reached the client, so the approval is kept.
 */
export function isClientOwnedApproval(
  approval: PendingApproval,
  toolInput: ApprovalToolInput | undefined,
  context: { caps: AcpClientCapabilities; routesWriteToClient: (target: string) => boolean }
): boolean {
  if (CLIENT_WRITE_TOOLS.has(approval.toolName)) {
    const target = toolInput?.path;
    if (typeof target !== "string" || !target) return false;
    return context.routesWriteToClient(target);
  }
  return false;
}

/**
 * The pending call's parsed input, read from the session's messages.
 *
 * Read from the session rather than tracked here: the approval and the call it belongs to arrive
 * on different channels, and the session's message tree is the only place that pairs them.
 */
/**
 * Whether to answer this approval here instead of asking the client.
 *
 * The whole rule in one function, so the branch in the ACP host stays a call and the policy stays
 * testable on its own: client-owned AND not in plan mode. See the module header for why each
 * exclusion is where it is.
 */
export function shouldSuppressApproval(input: {
  approval: PendingApproval;
  messages: ReadonlyArray<{ parts?: ReadonlyArray<unknown> }>;
  clientEnv: { clientCapabilities: AcpClientCapabilities; routesWriteToClient: (target: string) => boolean };
  /** The session's mode. Plan keeps every prompt: see the module header. */
  mode: string | undefined;
}): boolean {
  // `plan` is excluded because the client authorises a *file operation*, not the session's
  // read-only phase, and plan mode's guarantee is that nothing was written while it was on.
  // Spending the client's allow there buys a write that plan mode does not perform.
  if (input.mode === "plan") return false;
  return isClientOwnedApproval(input.approval, toolInputFor(input.messages, input.approval.toolCallId), {
    caps: input.clientEnv.clientCapabilities,
    routesWriteToClient: (target) => input.clientEnv.routesWriteToClient(target),
  });
}

export function toolInputFor(
  messages: ReadonlyArray<{ parts?: ReadonlyArray<unknown> }>,
  toolCallId: string
): ApprovalToolInput | undefined {
  for (const message of messages) {
    for (const part of (message.parts ?? []) as ReadonlyArray<Record<string, unknown>>) {
      const p = part as { type?: string; toolCallId?: string; id?: string; input?: unknown; arguments?: string };
      if (p.type !== "tool-call") continue;
      if (p.toolCallId !== toolCallId && p.id !== toolCallId) continue;
      if (p.input && typeof p.input === "object") return p.input as ApprovalToolInput;
      if (typeof p.arguments === "string") {
        try {
          const parsed = JSON.parse(p.arguments) as ApprovalToolInput;
          return parsed && typeof parsed === "object" ? parsed : undefined;
        } catch {
          return undefined;
        }
      }
    }
  }
  return undefined;
}
