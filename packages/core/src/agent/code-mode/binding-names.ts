/**
 * Binding-name normalisation for code-mode tools.
 *
 * `@tanstack/ai-code-mode` derives every sandbox binding name as
 * `` `${prefix}${tool.name}` `` with no character normalisation. The concatenation
 * appears twice in `dist/esm/bindings/tool-to-binding.js` — `toolsToBindings` (:12,
 * the map key) and `toolToBinding` (:50, the binding object's `name`) — and the
 * resulting key is what `create-code-mode-tool.js` passes to
 * `driver.createContext({ bindings })`, so the isolate driver installs it as a
 * sandbox global. An illegal identifier therefore breaks at two points: an unusable
 * type stub in the prompt, and a global a script can never reference.
 * A tool name containing a hyphen therefore produces a stub that is not a legal
 * JS/TS identifier:
 *
 * ```ts
 * declare function external_mcp__myserver_read-file(input: …): Promise<unknown>;
 * //                              ^^^^^^^^^^^^^^^^^^^^^^^ parses as subtraction
 * ```
 *
 * The same class of bug was fixed upstream in pi v0.99.2 (two tool names differing
 * only in `-`/`_` made a script call the wrong tool, silently). We normalise on our
 * side instead of waiting for the upstream fix, because the failure mode is invisible
 * until a user writes a script against an MCP tool.
 *
 * Two properties matter:
 *
 * - **Idempotent** — re-running over an already-normalised name returns it unchanged,
 *   so this step degrades to a no-op if upstream ever normalises too, rather than
 *   becoming a second source of renames.
 * - **Collision-safe** — normalisation maps distinct names onto one identifier
 *   (`read-file` and `read_file` both become `read_file`), so a deterministic suffix
 *   keeps both callable. Upstream's `DuplicateToolNameError` cannot catch this: it
 *   compares exact strings before any normalisation, so both names look distinct.
 */

// ============================================================================
// Types
// ============================================================================

/** Minimal log sink (structurally satisfied by `ExtensionContext["logger"]`). */
export interface BindingNameLog {
  warn(message: string): unknown;
}

/** Result of normalising a tool list: the renamed tools plus the applied renames. */
export interface BindingNameRenameResult<T> {
  tools: T[];
  /** Original tool name → binding name, only for tools that were renamed. */
  renames: Map<string, string>;
}

// ============================================================================
// Normalisation
// ============================================================================

/** Characters legal in a JS identifier, excluding the leading position. */
const ILLEGAL_IDENTIFIER_CHARS = /[^A-Za-z0-9_$]/g;

/** Characters legal as the first character of a JS identifier. */
const LEGAL_LEADING_CHAR = /^[A-Za-z_$]/;

/**
 * Rewrite a tool name into a legal JavaScript identifier.
 *
 * `-` and every other non-identifier character become `_`; a name that would start
 * with a digit gets a `_` prefix. Pure and idempotent: `normalizeBindingName` of an
 * already-normalised name returns it byte-identical.
 *
 * @example normalizeBindingName("mcp__myserver_read-file") // "mcp__myserver_read_file"
 * @example normalizeBindingName("web.search")              // "web_search"
 * @example normalizeBindingName("2fa")                     // "_2fa"
 */
export function normalizeBindingName(name: string): string {
  const collapsed = name.replace(ILLEGAL_IDENTIFIER_CHARS, "_");
  return LEGAL_LEADING_CHAR.test(collapsed) ? collapsed : `_${collapsed}`;
}

/**
 * Deterministic short suffix for a disambiguated binding name.
 *
 * FNV-1a (32-bit) of the original tool name, base36. Deterministic across runs and
 * processes — no seeded RNG or insertion-order dependence — so a script written
 * against one run still resolves after a restart.
 */
function shortSuffix(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

// ============================================================================
// List normalisation
// ============================================================================

/**
 * Normalise every tool's name to a legal binding identifier, keeping colliding
 * tools individually callable.
 *
 * - A name that is already legal is returned as the same object (no copy), so the
 *   current curated list produces a byte-identical prompt.
 * - Distinct tools that normalise to the same identifier each get a deterministic
 *   `_<hash-of-own-name>` suffix, so the assignment depends only on the *set* of
 *   tools, never on the order they were handed in. MCP tools are collected as
 *   servers connect, so input order is not stable across runs — an order-dependent
 *   suffix would make a script that worked in one session fail in the next.
 * - The same name offered twice cannot be separated from itself and is dropped with
 *   a warning, rather than emitting a duplicate declaration.
 * - Output preserves the input order, so eager/lazy ordering is unchanged.
 */
export function renameCodeModeTools<T extends { name: string }>(
  tools: T[],
  logger: BindingNameLog
): BindingNameRenameResult<T> {
  const renames = new Map<string, string>();

  // Group by normalised binding name. Grouping is a set operation, so nothing
  // below depends on the order the tools arrived in.
  const groups = new Map<string, number[]>();
  tools.forEach((tool, index) => {
    const binding = normalizeBindingName(tool.name);
    const list = groups.get(binding);
    if (list) list.push(index);
    else groups.set(binding, [index]);
  });

  /** Tool index → final binding name, or `null` when the tool was dropped. */
  const assigned = new Map<number, string | null>();

  for (const [binding, indices] of groups) {
    if (indices.length === 1) {
      const index = indices[0] as number;
      const tool = tools[index] as T;
      assigned.set(index, binding);
      if (binding !== tool.name) renames.set(tool.name, binding);
      continue;
    }

    // Several tools want one identifier. Drop exact duplicates first: the same
    // name offered twice cannot be separated from itself.
    const byOriginalName = new Map<string, number[]>();
    for (const index of indices) {
      const name = (tools[index] as T).name;
      const list = byOriginalName.get(name);
      if (list) list.push(index);
      else byOriginalName.set(name, [index]);
    }
    for (const [name, duplicates] of byOriginalName) {
      for (const index of duplicates.slice(1)) {
        logger.warn(`Code Mode: dropping duplicate tool "${name}" — it was offered more than once.`);
        assigned.set(index, null);
      }
    }

    const survivors = [...byOriginalName.values()].map((list) => list[0] as number);
    if (survivors.length === 1) {
      // Only duplicates remained: the sole survivor keeps the plain identifier.
      assigned.set(survivors[0] as number, binding);
      continue;
    }

    // Distinct tools colliding on one identifier. Suffix every survivor by its own
    // name's hash (not by position), so the result is independent of input order.
    // Iterating a name-sorted list makes even the rare hash collision deterministic.
    const sorted = [...survivors].sort((a, b) => {
      const left = (tools[a] as T).name;
      const right = (tools[b] as T).name;
      return left < right ? -1 : left > right ? 1 : 0;
    });
    const usedSuffixes = new Set<string>();
    for (const index of sorted) {
      const name = (tools[index] as T).name;
      let suffix = shortSuffix(name);
      while (usedSuffixes.has(suffix)) suffix += "x";
      usedSuffixes.add(suffix);

      const disambiguated = `${binding}_${suffix}`;
      assigned.set(index, disambiguated);
      renames.set(name, disambiguated);
      logger.warn(
        `Code Mode: renamed tool "${name}" to binding "${disambiguated}" — "${binding}" collides with another binding.`
      );
    }
  }

  // Rebuild in the original order so eager/lazy positioning is untouched.
  const result: T[] = [];
  tools.forEach((tool, index) => {
    const name = assigned.get(index);
    if (name == null) return;
    result.push(name === tool.name ? tool : { ...tool, name });
  });

  return { tools: result, renames };
}
