/**
 * File Sync — keeps LSP servers informed of file changes.
 *
 * Hooks into tool:after:read_file/write_file/edit_file and sends
 * didOpen/didChange notifications to the appropriate LSP server.
 *
 * Maintains an LRU-bounded set of tracked documents. When the limit is
 * reached, the least-recently-used document is closed via didClose to
 * prevent unbounded memory growth in the LSP server during long sessions.
 */

import { MAX_TRACKED_DOCUMENTS } from "./shared/constants.js";
import { syntheticDotLocks } from "./shared/synthetic-dot.js";
import { FIRST_SYNC_WAIT_MS } from "./shared/timing.js";

import type { LspManager } from "./lsp-manager.js";

interface TrackedDocument {
  uri: string;
  languageId: string;
  version: number;
}

export class FileSync {
  /** LRU map: most-recently-used documents are at the end (Map preserves insertion order). */
  private tracked: Map<string, TrackedDocument> = new Map();
  /** Files whose write could not be synced yet (server still starting), by language. */
  private pendingSync = new Map<string, Set<string>>();
  private maxTracked: number;
  private readFile: (absPath: string) => Promise<string>;
  private exists: (p: string) => Promise<boolean>;
  private manager: LspManager;

  constructor(
    manager: LspManager,
    fs: { readFile: (absPath: string) => Promise<string>; exists: (p: string) => Promise<boolean> },
    maxTracked?: number
  ) {
    this.manager = manager;
    this.maxTracked = maxTracked ?? MAX_TRACKED_DOCUMENTS;
    this.readFile = fs.readFile;
    this.exists = fs.exists;
  }

  /** Re-point at a new manager (used when session:start rebuilds the manager). */
  setManager(manager: LspManager): void {
    this.manager = manager;
    this.tracked.clear();
    this.pendingSync.clear();
  }

  /** Remember a file whose sync has to wait for the server to come up. */
  private markPendingSync(languageId: string, absPath: string): void {
    let pending = this.pendingSync.get(languageId);
    if (!pending) {
      pending = new Set();
      this.pendingSync.set(languageId, pending);
    }
    pending.add(absPath);
  }

  /**
   * Flush every language's deferred syncs.
   *
   * Called when a server becomes ready: one server can serve several language ids, so the id that
   * reported ready is not necessarily the id whose write was deferred. Waiting for that id's own ready
   * event would strand the write, because it does not come again.
   */
  async flushAllPendingSync(): Promise<void> {
    for (const languageId of [...this.pendingSync.keys()]) {
      await this.flushPendingSync(languageId).catch(() => {});
    }
  }

  /**
   * Sync files whose writes arrived while the server was still starting.
   * Wired to the manager's `onServerReady`, so a deferred cold-start sync is
   * never silently lost — the server learns about the file as soon as it can.
   */
  async flushPendingSync(languageId: string): Promise<void> {
    const pending = this.pendingSync.get(languageId);
    if (!pending || pending.size === 0) return;
    this.pendingSync.delete(languageId);
    for (const absPath of pending) {
      await this.handleFileWrite(absPath).catch(() => {});
    }
  }

  /**
   * Touch a URI in the LRU — moves it to the end (most-recently-used position).
   * If the map exceeds maxTracked, evicts the oldest entry and sends didClose.
   */
  private touchAndEvict(uri: string): void {
    const doc = this.tracked.get(uri);
    if (doc) {
      this.tracked.delete(uri);
      this.tracked.set(uri, doc);
    }

    while (this.tracked.size > this.maxTracked) {
      const oldest = this.tracked.entries().next();
      if (oldest.done) break;
      const [evictUri, evictDoc] = oldest.value;
      this.tracked.delete(evictUri);
      const client = this.manager.getRunningClient(evictDoc.languageId);
      if (client) {
        client.connection.didClose(evictUri);
      }
    }
  }

  /** Handle a file being read — sends didOpen if not yet tracked. */
  async handleFileRead(filePath: string): Promise<void> {
    const absPath = this.manager.resolvePath(filePath);
    const uri = this.manager.getFileUri(absPath);

    if (this.tracked.has(uri)) {
      this.touchAndEvict(uri);
      return;
    }

    const languageId = this.manager.getLanguageId(absPath);
    if (!languageId) return;

    const client = this.manager.getRunningClient(languageId);
    if (!client) return;

    try {
      const content = await this.readFile(absPath);
      const doc: TrackedDocument = { uri, languageId, version: 1 };
      this.tracked.set(uri, doc);
      client.connection.didOpen(uri, languageId, doc.version, content);
      this.touchAndEvict(uri);
    } catch {
      // File might not exist or be unreadable — ignore
    }
  }

  /** Handle a file being written/edited — sends didOpen or didChange. */
  async handleFileWrite(filePath: string): Promise<void> {
    const absPath = this.manager.resolvePath(filePath);
    const uri = this.manager.getFileUri(absPath);
    const languageId = this.manager.getLanguageId(absPath);

    if (!languageId) return;

    // Bounded wait for a cold start: a lazy start can take minutes (Java: project
    // indexing), which must not stall the tool result. A server that does not come
    // up in time is left starting and this file is synced as soon as it reports
    // ready (flushPendingSync), so the change is deferred rather than dropped.
    // No extra pre-warm here: startServer is already in flight (waitForClient kicks
    // it off), and starting another one after the timeout can outlive a shutdown.
    const client = await this.manager.waitForClient(languageId, FIRST_SYNC_WAIT_MS).catch(() => null);
    if (!client) {
      this.markPendingSync(languageId, absPath);
      return;
    }

    try {
      const content = await this.readFile(absPath);
      const existing = this.tracked.get(uri);

      if (existing) {
        if (syntheticDotLocks.has(uri)) {
          this.touchAndEvict(uri);
          return;
        }
        existing.version++;
        client.connection.didChange(uri, existing.version, content);
      } else {
        const doc: TrackedDocument = { uri, languageId, version: 1 };
        this.tracked.set(uri, doc);
        client.connection.didOpen(uri, languageId, doc.version, content);
      }
      this.touchAndEvict(uri);
    } catch {
      // File might not exist or be unreadable — ignore
    }
  }

  /** Get the current tracked version for a URI, or null if not tracked. */
  getTrackedVersion(uri: string): number | null {
    const doc = this.tracked.get(uri);
    return doc ? doc.version : null;
  }

  /** Override tracked version (used by synthetic-dot completion coordination). */
  setTrackedVersion(uri: string, version: number): void {
    const doc = this.tracked.get(uri);
    if (doc) doc.version = version;
  }

  /** True while a synthetic-dot completion temporarily mutates document text. */
  isSyntheticDotActive(uri: string): boolean {
    return syntheticDotLocks.has(uri);
  }

  /** Get the number of tracked documents. */
  get trackedCount(): number {
    return this.tracked.size;
  }
}
