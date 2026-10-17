import { describe, expect, it, vi } from 'vitest';

import { WorkerAssignmentResolutionCache } from '../workerAssignmentResolutionCache.js';

describe('WorkerAssignmentResolutionCache', () => {
  it('shares one session resolution, drops failures, and expires at the session deadline', async () => {
    let now = 100;
    const cache = new WorkerAssignmentResolutionCache<string>({ now: () => now });
    const resolve = vi.fn(async () => 'assignment');
    const first = cache.getOrCreate('session-1', 200, resolve);
    const second = cache.getOrCreate('session-1', 200, resolve);
    await expect(Promise.all([first, second])).resolves.toEqual(['assignment', 'assignment']);
    expect(resolve).toHaveBeenCalledTimes(1);

    await expect(cache.getOrCreate('failed', 200, async () => {
      throw new Error('temporary');
    })).rejects.toThrow('temporary');
    await expect(cache.getOrCreate('failed', 200, async () => 'recovered')).resolves.toBe('recovered');

    now = 200;
    await expect(cache.getOrCreate('session-1', 300, async () => 'renewed')).resolves.toBe('renewed');
    expect(cache.size).toBe(1);
  });

  it('evicts oldest live sessions at the hard churn bound and does not cache invalid expiry', async () => {
    const cache = new WorkerAssignmentResolutionCache<string>({ maxEntries: 2, now: () => 100 });
    await cache.getOrCreate('session-1', 1_000, async () => 'one');
    await cache.getOrCreate('session-2', 1_000, async () => 'two');
    await cache.getOrCreate('session-3', 1_000, async () => 'three');
    expect(cache.size).toBe(2);
    await expect(cache.getOrCreate('session-1', 1_000, async () => 'one-new')).resolves.toBe('one-new');
    expect(cache.size).toBe(2);

    await cache.getOrCreate('already-expired', 100, async () => 'not-cached');
    expect(cache.size).toBe(2);
  });
});
