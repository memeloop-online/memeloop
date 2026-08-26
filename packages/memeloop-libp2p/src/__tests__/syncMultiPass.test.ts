import { describe, expect, it, vi } from 'vitest';

import type { ChatSyncEngine, ChatSyncPassResult, DeviceConnectionGrant, IAgentStorage, SyncIoOptions } from 'memeloop/device-network/portable';
import { DEVICE_SYNC_MAX_PASSES, PortableLibp2pDeviceNetworkService } from '../portableLibp2pDeviceNetworkService.js';

type SyncOnce = (options?: SyncIoOptions) => Promise<ChatSyncPassResult>;

function pass(
  complete: boolean,
  progress: Partial<ChatSyncPassResult['progress']> = {},
): ChatSyncPassResult {
  return {
    complete,
    progress: {
      peers: 1,
      frontierPages: 1,
      pages: 1,
      events: 2,
      bytes: 3,
      ...progress,
    },
    ...(!complete
      ? {
        continuation: {
          reason: 'work-budget' as const,
          pendingPeerIds: ['remote-peer'],
        },
      }
      : {}),
  };
}

class SyncTestService extends PortableLibp2pDeviceNetworkService {
  public constructor(private readonly syncFactory: () => SyncOnce) {
    super({
      identity: {
        peerId: 'local-peer',
        publicKeyMultibase: 'libp2p-pub:test',
        privateKeyRef: 'test',
        createdAt: 1,
        deviceName: 'local',
        platform: 'cli',
      },
      authorizer: { canOpenProtocol: async () => true },
      syncStorage: {} as IAgentStorage,
      nodeFactory: async () => {
        throw new Error('node factory must not run');
      },
    });
  }

  protected override createDeviceSyncEngine(
    _peerId: string,
    _presentedGrant: DeviceConnectionGrant | undefined,
    _conversationIds: string[] | undefined,
  ): ChatSyncEngine {
    return { syncOnce: this.syncFactory() } as ChatSyncEngine;
  }
}

function serviceWithEngine(syncOnce: SyncOnce): PortableLibp2pDeviceNetworkService {
  return new SyncTestService(() => syncOnce);
}

describe('PortableLibp2pDeviceNetworkService bounded multi-pass sync', () => {
  it('automatically continues bounded passes and aggregates public progress', async () => {
    let passNumber = 0;
    const syncOnce = vi.fn(async () => {
      passNumber += 1;
      return pass(passNumber === 3);
    });
    const service = serviceWithEngine(syncOnce);

    await expect(service.syncWithDevice('remote-peer')).resolves.toMatchObject({
      ok: true,
      peerId: 'remote-peer',
      complete: true,
      progress: {
        passes: 3,
        peers: 3,
        frontierPages: 3,
        pages: 3,
        events: 6,
        bytes: 9,
      },
    });
    expect(syncOnce).toHaveBeenCalledTimes(3);
  });

  it('returns a resumable incomplete result at the fixed pass ceiling', async () => {
    const syncOnce = vi.fn(async () => pass(false));
    const service = serviceWithEngine(syncOnce);

    await expect(service.syncWithDevice('remote-peer')).resolves.toMatchObject({
      ok: true,
      peerId: 'remote-peer',
      complete: false,
      progress: { passes: DEVICE_SYNC_MAX_PASSES },
      continuation: {
        reason: 'pass-limit',
        resumeFrom: 'durable-frontier',
      },
    });
    expect(syncOnce).toHaveBeenCalledTimes(DEVICE_SYNC_MAX_PASSES);
  });

  it('returns a resumable incomplete result when the overall 120s budget expires', async () => {
    vi.useFakeTimers();
    try {
      const syncOnce = vi.fn(async (options: SyncIoOptions = {}) =>
        new Promise<ChatSyncPassResult>((_resolve, reject) => {
          const signal = options.signal;
          const onAbort = (): void => {
            reject(signal?.reason instanceof Error ? signal.reason : new Error('sync_aborted'));
          };
          signal?.addEventListener('abort', onAbort, { once: true });
          if (signal?.aborted) onAbort();
        })
      );
      const service = serviceWithEngine(syncOnce);
      const result = service.syncWithDevice('remote-peer');

      await vi.advanceTimersByTimeAsync(120_000);
      await expect(result).resolves.toMatchObject({
        ok: true,
        complete: false,
        progress: { passes: 0, elapsedMs: 120_000 },
        continuation: {
          reason: 'time-limit',
          resumeFrom: 'durable-frontier',
        },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('propagates external generation cancellation instead of reporting success', async () => {
    const controller = new AbortController();
    let passNumber = 0;
    const syncOnce = vi.fn(async (options: SyncIoOptions = {}) => {
      passNumber += 1;
      if (passNumber === 1) return pass(false);
      controller.abort(new Error('cloud-generation-replaced'));
      options.signal?.throwIfAborted();
      return pass(true);
    });
    const service = serviceWithEngine(syncOnce);

    await expect(service.syncWithDevice('remote-peer', { signal: controller.signal }))
      .rejects.toThrow('cloud-generation-replaced');
    expect(syncOnce).toHaveBeenCalledTimes(2);
  });

  it('isolates concurrent Cloud generations so stale cancellation cannot abort fresh work', async () => {
    const staleController = new AbortController();
    const staleSync = vi.fn(async (options: SyncIoOptions = {}) =>
      new Promise<ChatSyncPassResult>((_resolve, reject) => {
        const signal = options.signal;
        const onAbort = (): void => {
          reject(signal?.reason instanceof Error ? signal.reason : new Error('sync_aborted'));
        };
        signal?.addEventListener('abort', onAbort, { once: true });
        if (signal?.aborted) onAbort();
      })
    );
    const freshSync = vi.fn(async () => pass(true));
    const engines = [staleSync, freshSync] as SyncOnce[];
    const service = new SyncTestService(() => {
      const next = engines.shift();
      if (!next) throw new Error('unexpected extra sync engine');
      return next;
    });

    const staleResult = service.syncWithDevice('remote-peer', {
      signal: staleController.signal,
    });
    await vi.waitFor(() => {
      expect(staleSync).toHaveBeenCalledOnce();
    });
    await expect(service.syncWithDevice('remote-peer')).resolves.toMatchObject({
      complete: true,
      progress: { passes: 1 },
    });

    staleController.abort(new Error('stale-cloud-generation'));
    await expect(staleResult).rejects.toThrow('stale-cloud-generation');
    expect(freshSync).toHaveBeenCalledOnce();
  });
});
