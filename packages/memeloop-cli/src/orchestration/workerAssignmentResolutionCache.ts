/**
 * Small process-local cache for immutable worker-session assignment bindings.
 * Entries can never outlive the verified session and the hard LRU-like cap
 * prevents valid one-shot session churn from growing the daemon heap forever.
 */
export class WorkerAssignmentResolutionCache<Value> {
  private readonly entries = new Map<string, { expiresAt: number; resolution: Promise<Value> }>();

  public constructor(
    private readonly options: { maxEntries?: number; now?: () => number } = {},
  ) {
    if (!Number.isSafeInteger(options.maxEntries ?? 1_024) || (options.maxEntries ?? 1_024) <= 0) {
      throw new TypeError('worker assignment cache maxEntries must be a positive safe integer');
    }
  }

  public get size(): number {
    return this.entries.size;
  }

  public getOrCreate(name: string, expiresAt: number, resolve: () => Promise<Value>): Promise<Value> {
    const now = (this.options.now ?? Date.now)();
    this.sweep(now);
    const cached = this.entries.get(name);
    if (cached && cached.expiresAt > now) return cached.resolution;

    const resolution = resolve().catch((error: unknown) => {
      if (this.entries.get(name)?.resolution === resolution) this.entries.delete(name);
      throw error;
    });
    if (Number.isFinite(expiresAt) && expiresAt > now) {
      this.entries.set(name, { expiresAt, resolution });
      const maxEntries = this.options.maxEntries ?? 1_024;
      while (this.entries.size > maxEntries) {
        const oldest = this.entries.keys().next().value;
        if (oldest === undefined) break;
        this.entries.delete(oldest);
      }
    }
    return resolution;
  }

  private sweep(now: number): void {
    for (const [name, entry] of this.entries) {
      if (entry.expiresAt <= now) this.entries.delete(name);
    }
  }
}
