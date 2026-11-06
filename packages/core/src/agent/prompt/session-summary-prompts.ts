/**
 * System prompts for session title + PR-style summary generation.
 *
 * These run as side queries against the text adapter (no agent loop) — see
 * `runSideTextQuery` in session-lifecycle-commands.ts.
 *
 * Both prompts instruct the model to respond in the same language as the
 * conversation so Chinese conversations don't get English titles/summaries.
 */

/** System prompt for generating a concise conversation title. */
export const TITLE_SYSTEM_PROMPT = `Generate a concise title (3-8 words) for the following conversation. Return ONLY the title, no quotes or punctuation.

Respond in the same language as the conversation being titled.`;

/** System prompt for generating a PR-style summary of a development session. */
export const PR_SUMMARY_SYSTEM_PROMPT = `You are summarizing a development session for a pull request description. Produce a concise PR-style summary with these sections:

## Overview
[1-2 sentences describing the change]

## Changes
- [bullet list of the concrete changes made]

## Key files
- [file_path: brief description of the change in that file]

## Commits
[suggested conventional commit message(s), one per line]

Keep it concise and factual. Preserve exact file paths and function names.

Respond in the same language as the conversation being summarized.`;
