/**
 * Command approval policy — decide allow / deny / ask for a command safety report.
 *
 * Decision is a three-way `action`. The *disposition* of `ask` is left to the
 * caller: the main agent keeps the tool-call pending (y/n prompt), while a
 * subagent treats it as a denial (no approval UI). To keep subagents safe,
 * {@link evaluateCommandApproval} already downgrades `ask` → `deny` when
 * `agentKind === "subagent"`.
 *
 * Built-in default: project-internal read-only commands are auto-approved;
 * any write operation, external path, or parse failure requires approval.
 * Optional `rules` (allow/deny normalized-prefix patterns) override the
 * default and are reserved for future persisted rule files.
 *
 * ## A parse gap must not read as "suspicious"
 *
 * The default allow used to require `report.ok`, i.e. a real AST. When the host shell had no
 * grammar — every PowerShell/cmd.exe host — no report could ever satisfy it, so *every*
 * command fell through to "requires approval", and subagents downgrade that to a denial. The
 * model saw {@link SUBAGENT_DENY_MESSAGE}, which tells it to ask the main agent: advice that
 * cannot work, because the main agent's approval would not have helped either. The failure was
 * indistinguishable from "this command looks dangerous".
 *
 * The rule is now table-driven instead of AST-driven: allow when every command is
 * demonstrably read-only, whether that came from an AST or from the built-in tables. The
 * safety property is unchanged and direction-preserving — read-only status is only ever
 * granted for a recognized, non-writing, project-internal command, so an unrecognised command
 * still cannot be allowed.
 */

import type { CommandSafetyReport } from "./command-analyzer.js";

export interface CommandApprovalRules {
  /** Normalized-prefix patterns that are always allowed (e.g. `"git add *"`). */
  allow?: string[];
  /** Normalized-prefix patterns that are always denied (e.g. `"rm *"`). */
  deny?: string[];
}

export type CommandApprovalAction = "allow" | "deny" | "ask";

export interface CommandApprovalDecision {
  action: CommandApprovalAction;
  /** Human/LLM-readable reason (used for denials). */
  reason?: string;
}

/** Subagent denial reason — surfaced to the model via the tool error. */
export const SUBAGENT_DENY_MESSAGE =
  "This command requires approval that subagents do not have (insufficient permissions). " +
  "Ask the main agent to run it for you.";

/**
 * Subagent denial when the real cause is that the command could not be classified — that is, it
 * is not a recognized read-only command. Kept distinct from {@link SUBAGENT_DENY_MESSAGE}
 * because the two need different model behaviour: asking the main agent cannot unblock an
 * unrecognised command, so suggesting it wastes a turn.
 */
export const SUBAGENT_UNCLASSIFIED_MESSAGE =
  "This command is not recognised as read-only, so a subagent cannot run it. " +
  "Use a read-only command, or have the main agent run it.";

/**
 * The command-level scan that decides whether a report is read-only.
 *
 * Deliberately does not consult `report.ok`. `ok` reflects whether an AST was produced, not
 * whether the commands are safe, and conflating the two is what made a missing grammar look
 * like a dangerous command.
 */
function isReportReadOnly(report: CommandSafetyReport): boolean {
  return (
    report.commands.length > 0 &&
    !report.anyWriteOp &&
    !report.anyExternalDir &&
    report.commands.every((c) => c.isReadOnly)
  );
}

function matchesRules(patterns: string[] | undefined, normalized: string): boolean {
  if (!patterns || patterns.length === 0) return false;
  return patterns.some((p) => {
    const pattern = p.trim();
    if (!pattern) return false;
    if (pattern.endsWith("*")) return normalized.startsWith(pattern.slice(0, -1).trim());
    return normalized === pattern;
  });
}

/**
 * Evaluate an approval decision for a command safety report.
 *
 * Rule order: explicit deny > explicit allow > built-in default. The default
 * auto-approves only when every command is read-only and no file path escapes
 * the project root; anything else asks (root) or denies (subagent).
 */
export function evaluateCommandApproval(
  report: CommandSafetyReport,
  options: { agentKind: "root" | "subagent"; rules?: CommandApprovalRules }
): CommandApprovalDecision {
  const { rules, agentKind } = options;

  // Explicit deny rules take priority.
  if (rules?.deny && report.commands.some((c) => matchesRules(rules.deny, c.normalized))) {
    return { action: "deny", reason: "This command is denied by approval rules." };
  }

  // Explicit allow rules apply when every command matches.
  if (
    rules?.allow &&
    report.commands.length > 0 &&
    report.commands.every((c) => matchesRules(rules.allow, c.normalized))
  ) {
    return { action: "allow" };
  }

  // Built-in default: auto-approve project-internal read-only commands.
  if (isReportReadOnly(report)) {
    return { action: "allow" };
  }

  // Anything else requires approval. Subagents have no approval UI, so deny. The reason
  // distinguishes "unclassifiable" from "approval required" so the model is not told to ask
  // the main agent for something the main agent could not approve either.
  if (agentKind === "subagent") {
    // "Unclassified" means the report identified no concrete risk — no write op and no path
    // outside the root — yet something was still not read-only. That is the case where the
    // command is simply not recognised, and where asking the main agent would not help.
    //
    // A detected write op or external path is the opposite: it *is* classified (as dangerous),
    // the main agent can approve it, and suggesting that is correct. Keying on
    // `!isReadOnly` alone got this backwards — `rm` is not read-only *because it is a write
    // op*, so every known-dangerous command was reported to the model as unrecognised.
    const hasConcreteRisk = report.anyWriteOp || report.anyExternalDir;
    const unclassified =
      !hasConcreteRisk && (report.commands.length === 0 || report.commands.some((c) => !c.isReadOnly));
    return { action: "deny", reason: unclassified ? SUBAGENT_UNCLASSIFIED_MESSAGE : SUBAGENT_DENY_MESSAGE };
  }
  return { action: "ask" };
}
