/**
 * `CODENT_ACP_TRACE=1` narrates the ACP frames on stderr: one line per outgoing `session/update`,
 * and one per `session/prompt` with its stop reason and duration.
 *
 * It exists because "the client shows something we did not send" (and its inverse) cannot be
 * answered from the transcript. `len` and `sha` are what make "the same text twice" decidable: two
 * similar thoughts share a 40-character prefix, identical ones share a length AND a hash.
 */

// Read at MODULE EVALUATION, not per app: `codent-acp` has its env before the import, and a
// reader that sets the variable afterwards gets no narration (documented, not accidental).
export const TRACE_UPDATES = process.env.CODENT_ACP_TRACE === "1";
