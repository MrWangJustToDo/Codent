/**
 * FIFO queue for mid-run user messages (steering / follow-up).
 *
 * - `"one-at-a-time"` — drain only the oldest item (default).
 * - `"all"` — drain every pending item at once.
 */

export type QueueMode = "all" | "one-at-a-time";

export class PendingMessageQueue<T> {
  private items: T[] = [];
  mode: QueueMode;

  constructor(mode: QueueMode = "one-at-a-time") {
    this.mode = mode;
  }

  enqueue(item: T): void {
    this.items.push(item);
  }

  hasItems(): boolean {
    return this.items.length > 0;
  }

  size(): number {
    return this.items.length;
  }

  peekAll(): readonly T[] {
    return this.items;
  }

  /** Remove and return the most recently enqueued item (the reverse of {@link enqueue}). */
  popLast(): T | undefined {
    return this.items.pop();
  }

  drain(): T[] {
    if (this.mode === "all") {
      const drained = this.items.slice();
      this.items = [];
      return drained;
    }
    const first = this.items[0];
    if (first === undefined) return [];
    this.items = this.items.slice(1);
    return [first];
  }

  clear(): T[] {
    const cleared = this.items.slice();
    this.items = [];
    return cleared;
  }
}
