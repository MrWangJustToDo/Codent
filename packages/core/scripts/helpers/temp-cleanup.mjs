/**
 * `fs.rm` options for a temporary tree, with the retries Windows needs.
 *
 * A recursive removal on Windows fails with `ENOTEMPTY` / `EBUSY` / `EPERM` while any handle below the
 * directory is still open — and in a validator that is the normal case, not an exotic one: a session
 * save, a log append or a background job log can land *after* the removal enumerated the tree it is
 * writing into. POSIX tolerates that (an unlinked directory is invisible to the walker), which is why
 * this only ever fails on the Windows job:
 *
 *     [Error: ENOTEMPTY: directory not empty, rmdir '…\builtin-skills-bootstrap-N2UaOP\.agents']
 *
 * `maxRetries`/`retryDelay` are Node's answer to exactly this, and they are a no-op on POSIX.
 *
 * One definition, used by every validator that cleans a temp tree — a bare
 * `{ recursive: true, force: true }` in one of them is the retry-less version this exists to replace.
 */
export const TEMP_RM_OPTIONS = { recursive: true, force: true, maxRetries: 5, retryDelay: 50 };
