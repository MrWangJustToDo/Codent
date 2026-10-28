/**
 * The serializable extension summary a session publishes.
 *
 * Two readings live side by side on purpose:
 *
 * - `extensions` is per extension — what each extension *claims*, in dispatch order. The
 *   management panel describes that ("this extension registers /help"), including a command
 *   that is shadowed by a higher-ranked one.
 * - `commands` is per NAME — the highest-ranked live registration, i.e. exactly what dispatch
 *   would run. Hosts advertise THIS list: flattening `extensions[].commands` advertised the same
 *   name twice (once from each claimant), and one of the two could never be reached.
 *
 * Kept in one function because both projections must be built from the same runner read; two
 * call sites flattening independently is how the ACP catalog drifted from dispatch.
 */

import type { ExtensionRunner } from "./runner.js";
import type { ExtensionInfo } from "./types.js";

export interface ExtensionCommandSummary {
  name: string;
  description: string;
  /** Whether the command has a secondary menu (`getOptions`), so a host can browse it. */
  hasOptions: boolean;
}

export interface ExtensionSummary {
  extensions: ExtensionInfo[];
  commands: ExtensionCommandSummary[];
}

/** Project the runner's live state; an absent runner yields the empty summary. */
export function readExtensionSummary(runner: ExtensionRunner | null | undefined): ExtensionSummary {
  if (!runner) return { extensions: [], commands: [] };
  return {
    extensions: runner.getExtensionInfos(),
    commands: runner.getCommands().map((command) => ({
      name: command.name,
      description: command.description,
      hasOptions: Boolean(command.getOptions),
    })),
  };
}
