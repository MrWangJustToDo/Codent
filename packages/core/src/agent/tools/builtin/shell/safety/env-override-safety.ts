/**
 * Env-override safety for `run_command`.
 *
 * `run_command` accepts a model-supplied `env` map and the host merges it over `process.env`
 * (`native-run.ts`). The command analyzer only ever sees the command *text*, so
 * `{ command: "ls", env: { PATH: "/tmp/evil" } }` was classified read-only and auto-approved:
 * the text said `ls`, the process that ran was the caller's binary. The same shape walked
 * straight through the read-only whitelist a subagent runs under, where there is no approval UI.
 *
 * ## Why the rule is "any override", not a key list
 *
 * The first version of this guard enumerated dangerous keys (`PATH`, `LD_PRELOAD`, `BASH_ENV`, …).
 * That is a deny-list, so it fails open: any key nobody thought of is silently auto-approved, and
 * the class is open-ended (`LD`, `CC`, `RUSTC_WRAPPER`, `JAVA_TOOL_OPTIONS`, `LESSOPEN`,
 * `OPENSSL_CONF`, `SSH_ASKPASS`, `DOTNET_STARTUP_HOOKS`, `PATHEXT`, … — each new toolchain can add
 * one). The command table already states the rule this violated: a name-only guard is only safe
 * when the name is read-only under *every* argument list.
 *
 * So the verdict depends on nothing but "is there an override at all":
 *
 * - root agent → `ask`. The user sees the exact keys in the approval prompt.
 * - subagent → `deny`. It has no approval UI; it can express the same intent inline
 *   (`LC_ALL=C grep …`), which goes through the normal command analysis.
 *
 * That is nearly free in practice: across 70 recorded sessions, 2 of 16,297 `run_command` calls
 * used `env` at all. And it makes coverage a non-question — a missing hint can only make the
 * message less specific, never the verdict less safe.
 */

/**
 * Keys worth *naming* in the message because they are the classic execution selectors.
 *
 * **Not the gate.** The decision is "any override asks"; this list only sharpens the wording, so
 * an incomplete entry costs a vaguer sentence, never a missed approval. Do not add logic that
 * depends on membership here.
 */
const EXECUTION_SELECTING_ENV_HINTS: ReadonlySet<string> = new Set([
  "path",
  "ld",
  "ld_preload",
  "ld_library_path",
  "dyld_insert_libraries",
  "bash_env",
  "env",
  "node_options",
  "pythonpath",
  "perl5opt",
  "rubyopt",
  "java_tool_options",
  "_java_options",
  "maven_opts",
  "rustc_wrapper",
  "lessopen",
  "openssl_conf",
  "ssh_askpass",
  "pager",
  "editor",
  "git_config_global",
  "git_exec_path",
  "home",
]);

/** Prefix families the hints recognize (`LD_*`, `DYLD_*`, exported bash functions). */
const EXECUTION_SELECTING_ENV_PREFIXES: readonly string[] = ["ld_", "dyld_", "bash_func_"];

/** The override keys, as the caller spelled them (empty array when there is no override). */
export function envOverrideKeys(env: Record<string, string> | undefined): string[] {
  return env ? Object.keys(env) : [];
}

/** The subset worth naming in the message (message quality only — never a verdict). */
export function executionSelectingEnvKeys(keys: string[]): string[] {
  return keys.filter((key) => {
    const normalized = key.toLowerCase();
    return (
      EXECUTION_SELECTING_ENV_HINTS.has(normalized) ||
      EXECUTION_SELECTING_ENV_PREFIXES.some((prefix) => normalized.startsWith(prefix))
    );
  });
}

/** Approval reason for the root agent (`ask`): the user is about to approve more than the text. */
export function envOverrideApprovalReason(keys: string[]): string {
  const selecting = executionSelectingEnvKeys(keys);
  const detail = selecting.length > 0 ? ` (${selecting.join(", ")} can select a different program)` : "";
  return (
    `Env override ${keys.join(", ")} requires approval${detail}: an env override is not part of the ` +
    "command text, so the text alone cannot prove what runs."
  );
}

/** Subagents have no approval UI, so the same override is a denial with a model-actionable reason. */
export function subagentEnvOverrideMessage(keys: string[]): string {
  return (
    `A subagent cannot set env overrides (${keys.join(", ")}): the command text would not describe ` +
    "what runs. Put the value inline in the command instead (e.g. `LC_ALL=C grep …`), or ask the " +
    "main agent to run it."
  );
}
