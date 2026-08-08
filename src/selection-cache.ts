/**
 * Short TTL cache for selection reads.
 * Compat hooks hit selection on every provider/tool request; external CLI
 * switches rewrite settings out-of-process, so the window stays short.
 */

export class SelectionCache<T> {
  private entry: { at: number; value: T } | undefined;

  get(ttlMs: number, load: () => T): T {
    const now = Date.now();
    if (this.entry && now - this.entry.at < ttlMs) {
      return this.entry.value;
    }
    const value = load();
    this.entry = { at: now, value };
    return value;
  }

  invalidate(): void {
    this.entry = undefined;
  }
}
