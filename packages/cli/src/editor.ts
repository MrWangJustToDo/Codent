import { spawn } from "node:child_process";
import { basename } from "node:path";

import type { EditorTarget } from "@codent/app";

/**
 * Editor resolution and launch for the workspace panel's handoff.
 *
 * Deliberately small and dependency-free: the editor is the user's, chosen from `$VISUAL` / `$EDITOR`
 * with a platform default, started with inherited stdio (it owns the terminal for as long as it runs)
 * and awaited. Anything it writes is the editor's; anything we have to say is returned as a notice the
 * panel shows after the UI resumes.
 */

/** Editors that take `+<line>` as the cursor position before the file argument. */
const LINE_ARG_EDITORS = /^(?:n?vim|vi|view|vimdiff|hx|helix)$/;

const DEFAULT_EDITORS: Record<string, readonly string[]> = {
  win32: ["notepad"],
  // `nvim` is the editor this feature is designed around; `vi` is the POSIX floor every machine has.
  default: ["nvim", "vi"],
};

export interface EditorCommand {
  command: string;
  args: string[];
}

/**
 * Naive space split, on purpose: `$EDITOR` is a command line, not a shell program. Values with
 * meaningful quoting (`EDITOR="code --wait"` works; `EDITOR='sh -c "..."'` does not) are the user's
 * business — running them through a shell would make every editor invocation a shell-injection surface
 * for the file path.
 */
function splitCommandLine(value: string): string[] {
  return value.trim().split(/\s+/).filter(Boolean);
}

function defaultEditors(platform: NodeJS.Platform): readonly string[] {
  return DEFAULT_EDITORS[platform] ?? DEFAULT_EDITORS.default!;
}

/**
 * Command lines to try, in order: `$VISUAL`, else `$EDITOR`, else the platform default chain.
 *
 * An explicitly configured editor yields exactly one candidate — silently substituting another one
 * would edit the file in an editor the user did not ask for. Only the *default* falls through
 * (`nvim` → `vi`).
 */
export function resolveEditorCandidates(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): readonly string[] {
  const configured = (env.VISUAL ?? "").trim() || (env.EDITOR ?? "").trim();
  return configured ? [configured] : defaultEditors(platform);
}

/** Which editor a command line names, and the arguments that position it on `target`. */
export function resolveEditorCommand(commandLine: string, target: EditorTarget): EditorCommand {
  const [command = "", ...initialArgs] = splitCommandLine(commandLine);

  const args = [...initialArgs];
  const executable = basename(command)
    .toLowerCase()
    .replace(/\.exe$/, "");
  if (target.line && target.line > 0 && LINE_ARG_EDITORS.test(executable)) {
    args.push(`+${target.line}`);
  }
  args.push(target.path);
  return { command, args };
}

type SpawnOutcome = { kind: "ok" } | { kind: "missing"; message: string } | { kind: "failed"; message: string };

function spawnEditor(command: string, args: string[], platform: NodeJS.Platform): Promise<SpawnOutcome> {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (outcome: SpawnOutcome) => {
      if (settled) return;
      settled = true;
      resolve(outcome);
    };

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, args, {
        // The editor owns the terminal. Standard input/output/error are inherited so it behaves
        // exactly as if the user had launched it from their shell.
        stdio: "inherit",
        // Windows resolves `.cmd` shims (`code.cmd`) only through a shell; POSIX must stay shell-free
        // so the file path is never re-parsed.
        shell: platform === "win32",
      });
    } catch {
      settle({ kind: "missing", message: `Editor not found: ${command}` });
      return;
    }

    child.on("error", (error: NodeJS.ErrnoException) => {
      settle(
        error.code === "ENOENT"
          ? { kind: "missing", message: `Editor not found: ${command}` }
          : { kind: "failed", message: error.message }
      );
    });

    child.on("close", (code, signal) => {
      if (signal) {
        settle({ kind: "failed", message: `Editor stopped by ${signal}.` });
        return;
      }
      if (code === 0) {
        settle({ kind: "ok" });
        return;
      }
      settle({ kind: "failed", message: `Editor exited with status ${String(code)}.` });
    });
  });
}

/**
 * Suspend-and-run: starts the editor and resolves once it exits.
 *
 * @returns A notice to show the user after the UI resumes, or `null` when the edit completed
 * normally. Never throws — a failed handoff must still bring the UI back (the caller re-renders in a
 * `finally`), and the terminal the editor owned is not a place to print diagnostics.
 */
export async function launchEditor(
  target: EditorTarget,
  options?: { env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform }
): Promise<string | null> {
  const env = options?.env ?? process.env;
  const platform = options?.platform ?? process.platform;

  const candidates = resolveEditorCandidates(env, platform);

  let missing: string | null = null;
  for (const candidate of candidates) {
    const resolved = resolveEditorCommand(candidate, target);
    const outcome = await spawnEditor(resolved.command, resolved.args, platform);
    if (outcome.kind === "ok") return null;
    if (outcome.kind === "failed") return outcome.message;
    missing = outcome.message;
  }
  return missing;
}
