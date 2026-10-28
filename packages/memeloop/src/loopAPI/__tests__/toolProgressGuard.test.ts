import { describe, expect, it, vi } from 'vitest';

import { sha256HexSync } from '../../encoding/sha256.js';
import { createToolProgressGuardState, evaluateToolProgressGuard, observeToolProgress } from '../agent-tool-loop/toolProgressGuard.js';

describe('tool progress doom-loop guard', () => {
  it('blocks parameter tweaking when the same tool makes no observable progress', async () => {
    const state = createToolProgressGuardState();
    for (let page = 1; page < 4; page += 1) {
      await expect(evaluateToolProgressGuard(state, [{ toolId: 'search', parameters: { page } }], {
        exactRepeatThreshold: 3,
        sameToolWithoutProgressThreshold: 4,
      })).resolves.toEqual({ blocked: false });
      await observeToolProgress(state, { toolId: 'search', result: 'same result' });
    }
    await expect(evaluateToolProgressGuard(state, [{ toolId: 'search', parameters: { page: 4 } }], {
      exactRepeatThreshold: 3,
      sameToolWithoutProgressThreshold: 4,
    })).resolves.toMatchObject({
      blocked: true,
      reason: 'same-tool-without-progress',
    });
  });

  it('allows long pagination when each result demonstrates progress', async () => {
    const state = createToolProgressGuardState();
    for (let page = 1; page <= 30; page += 1) {
      await expect(evaluateToolProgressGuard(state, [{ toolId: 'search', parameters: { page } }], {
        exactRepeatThreshold: 3,
        sameToolWithoutProgressThreshold: 8,
      })).resolves.toEqual({ blocked: false });
      await observeToolProgress(state, { result: `page-${page}` });
    }
  });

  it('retains the lower exact-repeat threshold even when output changes', async () => {
    const state = createToolProgressGuardState();
    const calls = [{ toolId: 'read', parameters: { path: '/safe/file' } }];
    await expect(evaluateToolProgressGuard(state, calls)).resolves.toEqual({ blocked: false });
    await observeToolProgress(state, { result: 'version-1' });
    await expect(evaluateToolProgressGuard(state, calls)).resolves.toEqual({ blocked: false });
    await observeToolProgress(state, { result: 'version-2' });
    await expect(evaluateToolProgressGuard(state, calls)).resolves.toMatchObject({
      blocked: true,
      reason: 'exact-repeat',
    });
  });

  it('treats a parallel tool batch as one deterministic guard unit', async () => {
    const state = createToolProgressGuardState();
    const calls = [
      { toolId: 'read', parameters: { path: 'a' } },
      { toolId: 'read', parameters: { path: 'b' } },
    ];
    await expect(evaluateToolProgressGuard(state, calls, { exactRepeatThreshold: 2 })).resolves.toEqual({ blocked: false });
    await expect(evaluateToolProgressGuard(state, calls, { exactRepeatThreshold: 2 })).resolves.toMatchObject({
      blocked: true,
      reason: 'exact-repeat',
    });
  });

  it('does not share progress state across independent turns', async () => {
    const oldTurn = createToolProgressGuardState();
    const newTurn = createToolProgressGuardState();
    const calls = [{ toolId: 'read', parameters: { path: 'a' } }];
    await evaluateToolProgressGuard(oldTurn, calls, { exactRepeatThreshold: 2 });
    await expect(evaluateToolProgressGuard(newTurn, calls, { exactRepeatThreshold: 2 })).resolves.toEqual({ blocked: false });
  });

  it.each([1, 1.5, 1_025])(
    'rejects an out-of-bounds exact threshold even for an empty batch: %s',
    async exactRepeatThreshold => {
      await expect(evaluateToolProgressGuard(createToolProgressGuardState(), [], {
        exactRepeatThreshold,
      })).rejects.toThrow('exactRepeatThreshold must be a safe integer between 2 and 1024');
    },
  );

  it('validates the relationship between exact and same-tool thresholds', async () => {
    await expect(evaluateToolProgressGuard(createToolProgressGuardState(), [], {
      exactRepeatThreshold: 4,
      sameToolWithoutProgressThreshold: 4,
    })).rejects.toThrow('sameToolWithoutProgressThreshold must exceed exactRepeatThreshold');
  });

  it('caps the derived same-tool threshold at the canonical maximum', async () => {
    await expect(evaluateToolProgressGuard(
      createToolProgressGuardState(),
      [{ toolId: 'read', parameters: { path: 'a' } }],
      { exactRepeatThreshold: 1_023 },
    )).resolves.toEqual({ blocked: false });
  });

  it('uses an injected React-Native-safe SHA-256 provider without global WebCrypto', async () => {
    vi.stubGlobal('crypto', undefined);
    const controller = new AbortController();
    const sha256Hex = vi.fn((bytes: Uint8Array, signal?: AbortSignal) => {
      signal?.throwIfAborted();
      return sha256HexSync(bytes);
    });
    try {
      const state = createToolProgressGuardState();
      await expect(evaluateToolProgressGuard(
        state,
        [{ toolId: 'todoWrite', parameters: { action: 'list' } }],
        { sha256Hex, signal: controller.signal },
      )).resolves.toEqual({ blocked: false });
      await observeToolProgress(state, { result: 'no todos' }, {
        sha256Hex,
        signal: controller.signal,
      });

      expect(sha256Hex).toHaveBeenCalledTimes(3);
      expect(sha256Hex.mock.calls.every(([, signal]) => signal === controller.signal)).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('uses the portable synchronous fallback when WebCrypto is unavailable', async () => {
    vi.stubGlobal('crypto', undefined);
    try {
      await expect(evaluateToolProgressGuard(
        createToolProgressGuardState(),
        [{ toolId: 'todoWrite', parameters: { action: 'list' } }],
      )).resolves.toEqual({ blocked: false });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('propagates injected provider errors and aborts without invoking the provider', async () => {
    const providerError = new Error('noble backend failed');
    const failing = vi.fn(async () => {
      throw providerError;
    });
    await expect(evaluateToolProgressGuard(
      createToolProgressGuardState(),
      [{ toolId: 'todoWrite', parameters: { action: 'list' } }],
      { sha256Hex: failing },
    )).rejects.toBe(providerError);

    const controller = new AbortController();
    controller.abort(new DOMException('mobile run cancelled', 'AbortError'));
    const notCalled = vi.fn(sha256HexSync);
    await expect(evaluateToolProgressGuard(
      createToolProgressGuardState(),
      [{ toolId: 'todoWrite', parameters: { action: 'list' } }],
      { sha256Hex: notCalled, signal: controller.signal },
    )).rejects.toThrow('mobile run cancelled');
    expect(notCalled).not.toHaveBeenCalled();
  });

  it('does not partially mutate guard state when a later provider call fails', async () => {
    const providerError = new Error('second digest failed');
    let invocation = 0;
    const sha256Hex = vi.fn((bytes: Uint8Array) => {
      invocation += 1;
      if (invocation === 2) throw providerError;
      return sha256HexSync(bytes);
    });
    const state = createToolProgressGuardState();

    await expect(evaluateToolProgressGuard(
      state,
      [{ toolId: 'todoWrite', parameters: { action: 'list' } }],
      { sha256Hex },
    )).rejects.toBe(providerError);
    expect(state).toMatchObject({
      recentExactBatchSignatures: [],
      consecutiveUnprogressedBatches: 0,
    });
    expect(state.lastToolIdBatchSignature).toBeUndefined();
  });

  it('rejects a malformed digest returned by an injected provider', async () => {
    await expect(evaluateToolProgressGuard(
      createToolProgressGuardState(),
      [{ toolId: 'todoWrite', parameters: { action: 'list' } }],
      { sha256Hex: () => 'not-a-sha256' },
    )).rejects.toThrow('tool_progress_sha256_invalid_digest');
  });
});
