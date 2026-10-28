import { describe, expect, it, vi } from 'vitest';
import { MutableDeviceAuthorizer as BrowserMutableDeviceAuthorizer } from '../../browser.js';
import { MutableDeviceAuthorizer as PortableMutableDeviceAuthorizer } from '../../device-network-portable.js';
import { MutableDeviceAuthorizer as RootMutableDeviceAuthorizer } from '../../index.js';
import { MutableDeviceAuthorizer as MobileMutableDeviceAuthorizer } from '../../mobile.js';
import { MutableDeviceAuthorizer } from '../mutableDeviceAuthorizer.js';
import type { DeviceAuthorizer, DeviceCloudCommitFence } from '../types.js';

const input = {
  remotePeerId: 'peer-1',
  protocol: '/memeloop/rpc/2.0.0' as const,
};

function fence(generation: number, current: () => number): DeviceCloudCommitFence {
  const controller = new AbortController();
  return {
    generation,
    signal: controller.signal,
    isCurrent: () => current() === generation && !controller.signal.aborted,
    throwIfStale: () => {
      if (current() !== generation || controller.signal.aborted) throw new Error('stale');
    },
    commitSynchronous: ((operation: () => unknown) => {
      if (current() !== generation || controller.signal.aborted) return false;
      operation();
      return true;
    }) as DeviceCloudCommitFence['commitSynchronous'],
  };
}

describe('MutableDeviceAuthorizer', () => {
  it('is the same portable runtime from root, browser, mobile, and device-network entries', () => {
    expect(RootMutableDeviceAuthorizer).toBe(MutableDeviceAuthorizer);
    expect(BrowserMutableDeviceAuthorizer).toBe(MutableDeviceAuthorizer);
    expect(MobileMutableDeviceAuthorizer).toBe(MutableDeviceAuthorizer);
    expect(PortableMutableDeviceAuthorizer).toBe(MutableDeviceAuthorizer);
  });

  it('rejects a delayed A replacement and installs only current generation B', async () => {
    const fallback = { canOpenProtocol: vi.fn().mockResolvedValue(false) } satisfies DeviceAuthorizer;
    const accountA = { canOpenProtocol: vi.fn().mockResolvedValue(true) } satisfies DeviceAuthorizer;
    const accountB = { canOpenProtocol: vi.fn().mockResolvedValue(true) } satisfies DeviceAuthorizer;
    const mutable = new MutableDeviceAuthorizer(fallback);
    let currentGeneration = 1;
    const generationA = fence(1, () => currentGeneration);
    currentGeneration = 2;

    expect(mutable.setDelegate(accountA, generationA)).toBe(false);
    await expect(mutable.canOpenProtocol(input)).resolves.toBe(false);

    const generationB = fence(2, () => currentGeneration);
    expect(mutable.setDelegate(accountB, generationB)).toBe(true);
    await expect(mutable.canOpenProtocol(input)).resolves.toBe(true);
    expect(accountA.canOpenProtocol).not.toHaveBeenCalled();

    const cleanup = new AbortController();
    mutable.resetDelegate(cleanup.signal);
    await expect(mutable.canOpenProtocol(input)).resolves.toBe(false);
  });

  it('keeps each in-flight authorization decision on one captured delegate', async () => {
    let resolveA!: (allowed: boolean) => void;
    const accountA = {
      canOpenProtocol: vi.fn(() =>
        new Promise<boolean>((resolve) => {
          resolveA = resolve;
        })
      ),
    } satisfies DeviceAuthorizer;
    const accountB = { canOpenProtocol: vi.fn().mockResolvedValue(false) } satisfies DeviceAuthorizer;
    const mutable = new MutableDeviceAuthorizer(accountA);
    const inFlightA = mutable.canOpenProtocol(input);
    let currentGeneration = 2;

    expect(mutable.setDelegate(accountB, fence(2, () => currentGeneration))).toBe(true);
    await expect(mutable.canOpenProtocol(input)).resolves.toBe(false);
    resolveA(true);
    await expect(inFlightA).resolves.toBe(true);

    currentGeneration = 3;
    const abortedCleanup = new AbortController();
    abortedCleanup.abort(new Error('cancelled'));
    expect(() => {
      mutable.resetDelegate(abortedCleanup.signal);
    }).toThrow('cancelled');
    await expect(mutable.canOpenProtocol(input)).resolves.toBe(false);
  });
});
