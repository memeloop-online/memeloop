import { describe, expect, it, vi } from 'vitest';

import {
  type DeviceCloudCommitFence,
  type DeviceCloudConnectionAdapter,
  DeviceCloudConnectionCoordinator,
  type DeviceCloudStepResult,
} from '../deviceCloudConnectionCoordinator.js';
import type { SyncResult } from '../types.js';

interface Configuration {
  accountId: string;
  url: string;
  relayRequired: boolean;
}

function configured(accountId = 'account-a', relayRequired = false): Configuration {
  return { accountId, url: `https://${accountId}.example.test`, relayRequired };
}

function adapter(): DeviceCloudConnectionAdapter<Configuration> & {
  ensureAuthorizer: ReturnType<typeof vi.fn>;
  registerDevice: ReturnType<typeof vi.fn>;
  ensureRelay: ReturnType<typeof vi.fn>;
  heartbeat: ReturnType<typeof vi.fn>;
  syncDirectory: ReturnType<typeof vi.fn>;
  dispose: ReturnType<typeof vi.fn>;
} {
  return {
    isConfigured: (value): value is Configuration => value !== undefined && value.url.length > 0,
    relayRequiredForOnline: (value) => value.relayRequired,
    ensureAuthorizer: vi.fn(async () => undefined),
    registerDevice: vi.fn(async () => undefined),
    ensureRelay: vi.fn(async () => undefined),
    heartbeat: vi.fn(async () => undefined),
    syncDirectory: vi.fn(async () => undefined),
    dispose: vi.fn(async () => undefined),
  };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolver) => {
    resolve = resolver;
  });
  return { promise, resolve };
}

function syncResult(complete: boolean): SyncResult {
  const result = {
    ok: true as const,
    peerId: 'peer-a',
    syncedAt: 1,
    complete,
    progress: {
      passes: 1,
      peers: 1,
      frontierPages: 1,
      pages: 1,
      events: 1,
      bytes: 1,
      elapsedMs: 1,
    },
  };
  return complete
    ? result
    : {
      ...result,
      continuation: { reason: 'pass-limit', resumeFrom: 'durable-frontier' },
    };
}

describe('DeviceCloudConnectionCoordinator', () => {
  it('publishes the fixed lifecycle and tracks every component independently', async () => {
    const host = adapter();
    const observed: string[] = [];
    const coordinator = new DeviceCloudConnectionCoordinator({
      adapter: host,
      configuration: configured(),
      heartbeatIntervalMs: 60_000,
      jitterRatio: 0,
      onStatus: (snapshot) => {
        observed.push(snapshot.status);
      },
    });

    await coordinator.start();

    expect(coordinator.snapshot).toMatchObject({
      status: 'online',
      generation: 0,
      components: {
        authorizer: 'ready',
        registration: 'ready',
        relay: 'ready',
        heartbeat: 'ready',
        directory: 'ready',
      },
    });
    expect(observed).toContain('connecting');
    await coordinator.stop();
  });

  it('never reports Mobile online when its required relay fails', async () => {
    const host = adapter();
    host.ensureRelay.mockRejectedValue(new Error('relay unavailable'));
    const coordinator = new DeviceCloudConnectionCoordinator({
      adapter: host,
      configuration: configured('mobile', true),
      heartbeatIntervalMs: 60_000,
      logWarning: vi.fn(),
    });

    await coordinator.start();

    expect(coordinator.snapshot.status).toBe('degraded');
    expect(coordinator.snapshot.components).toMatchObject({
      relay: 'failed',
      heartbeat: 'ready',
      directory: 'ready',
    });
    await coordinator.stop();
  });

  it('keeps a valid registration when only directory synchronization fails', async () => {
    const host = adapter();
    host.syncDirectory.mockRejectedValueOnce(new Error('directory unavailable'));
    const coordinator = new DeviceCloudConnectionCoordinator({
      adapter: host,
      configuration: configured(),
      heartbeatIntervalMs: 60_000,
      logWarning: vi.fn(),
    });

    await coordinator.start();
    expect(coordinator.snapshot.status).toBe('degraded');
    expect(host.registerDevice).toHaveBeenCalledOnce();

    await coordinator.runNow();
    expect(coordinator.snapshot.status).toBe('online');
    expect(host.registerDevice).toHaveBeenCalledOnce();
    await coordinator.stop();
  });

  it('discards old-generation commits after an account or URL switch', async () => {
    const host = adapter();
    const oldRegistration = deferred<DeviceCloudStepResult>();
    const oldCommit = vi.fn(async () => undefined);
    const newCommit = vi.fn(async () => undefined);
    host.registerDevice.mockImplementation(async (configuration: Configuration) => {
      if (configuration.accountId === 'account-a') return oldRegistration.promise;
      return { commit: newCommit };
    });
    const coordinator = new DeviceCloudConnectionCoordinator({
      adapter: host,
      configuration: configured('account-a'),
      heartbeatIntervalMs: 60_000,
    });

    const oldRun = coordinator.start();
    await vi.waitFor(() => {
      expect(host.registerDevice).toHaveBeenCalledOnce();
    });
    const changing = coordinator.setConfiguration(configured('account-b'));
    oldRegistration.resolve({ commit: oldCommit });
    await changing;
    await oldRun;

    expect(oldCommit).not.toHaveBeenCalled();
    expect(host.dispose).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: 'account-a' }),
      expect.any(AbortSignal),
    );
    expect(newCommit).toHaveBeenCalledOnce();
    expect(coordinator.snapshot).toMatchObject({ generation: 1, status: 'online' });
    await coordinator.stop();
  });

  it('serializes concurrent maintenance and keeps registration after heartbeat loss', async () => {
    const host = adapter();
    const heartbeat = deferred<undefined>();
    host.heartbeat.mockImplementationOnce(async () => heartbeat.promise);
    const coordinator = new DeviceCloudConnectionCoordinator({
      adapter: host,
      configuration: configured(),
      heartbeatIntervalMs: 60_000,
      initialBackoffMs: 10,
      jitterRatio: 0,
    });

    const first = coordinator.runNow();
    const second = coordinator.runNow();
    expect(first).toBe(second);
    heartbeat.resolve(undefined);
    await first;

    host.heartbeat.mockRejectedValueOnce(new Error('offline'));
    await expect(coordinator.runNow()).rejects.toThrow('offline');
    expect(coordinator.snapshot.status).toBe('offline');
    await coordinator.runNow();
    expect(host.registerDevice).toHaveBeenCalledOnce();
    await coordinator.stop();
  });

  it('uses 1x/2x/4x retry backoff and resets the sequence after one successful maintenance', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    try {
      const host = adapter();
      host.heartbeat
        .mockRejectedValueOnce(new Error('offline-1'))
        .mockRejectedValueOnce(new Error('offline-2'))
        .mockRejectedValueOnce(new Error('offline-3'));
      const coordinator = new DeviceCloudConnectionCoordinator({
        adapter: host,
        configuration: configured(),
        heartbeatIntervalMs: 60_000,
        initialBackoffMs: 100,
        maxBackoffMs: 1_000,
        jitterRatio: 0,
      });

      await expect(coordinator.start()).rejects.toThrow('offline-1');
      expect(coordinator.snapshot.nextRetryAt).toBe(1_100);
      await vi.advanceTimersByTimeAsync(100);
      expect(coordinator.snapshot.nextRetryAt).toBe(1_300);
      await vi.advanceTimersByTimeAsync(200);
      expect(coordinator.snapshot.nextRetryAt).toBe(1_700);
      await vi.advanceTimersByTimeAsync(400);
      expect(coordinator.snapshot.status).toBe('online');

      host.heartbeat.mockRejectedValueOnce(new Error('offline-after-success'));
      await expect(coordinator.runNow()).rejects.toThrow('offline-after-success');
      expect(coordinator.snapshot.nextRetryAt).toBe(1_800);
      await coordinator.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(
    [
      [0, 1_075],
      [1, 1_125],
    ] as const,
  )('keeps retry jitter inside the configured bound for random=%s', async (random, retryAt) => {
    const host = adapter();
    host.heartbeat.mockRejectedValueOnce(new Error('offline'));
    const coordinator = new DeviceCloudConnectionCoordinator({
      adapter: host,
      configuration: configured(),
      heartbeatIntervalMs: 60_000,
      initialBackoffMs: 100,
      jitterRatio: 0.25,
      now: () => 1_000,
      random: () => random,
    });

    await expect(coordinator.start()).rejects.toThrow('offline');
    expect(coordinator.snapshot.nextRetryAt).toBe(retryAt);
    await coordinator.stop();
  });

  it('clears an old-generation retry timer before activating replacement configuration', async () => {
    vi.useFakeTimers();
    try {
      const host = adapter();
      host.heartbeat.mockRejectedValueOnce(new Error('old-generation-offline'));
      const coordinator = new DeviceCloudConnectionCoordinator({
        adapter: host,
        configuration: configured('account-a'),
        heartbeatIntervalMs: 60_000,
        initialBackoffMs: 100,
        jitterRatio: 0,
      });

      await expect(coordinator.start()).rejects.toThrow('old-generation-offline');
      await coordinator.setConfiguration(configured('account-b'));
      expect(host.heartbeat).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(100);
      expect(host.heartbeat).toHaveBeenCalledTimes(2);
      expect(coordinator.snapshot).toMatchObject({ generation: 1, status: 'online' });
      await coordinator.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps Cloud online while single-flight background sync retries an incomplete result to completion', async () => {
    vi.useFakeTimers();
    try {
      const host = adapter();
      host.listBackgroundSyncPeerIds = vi.fn(async () => ['peer-a', 'peer-a']);
      host.syncDevice = vi.fn()
        .mockResolvedValueOnce(syncResult(false))
        .mockResolvedValueOnce(syncResult(true));
      const coordinator = new DeviceCloudConnectionCoordinator({
        adapter: host,
        configuration: configured(),
        heartbeatIntervalMs: 60_000,
        backgroundSyncInitialBackoffMs: 10,
        backgroundSyncMaxBackoffMs: 100,
        jitterRatio: 0,
      });

      await coordinator.start();
      expect(coordinator.snapshot.status).toBe('online');
      await Promise.resolve();
      await Promise.resolve();
      expect(host.syncDevice).toHaveBeenCalledOnce();

      // A foreground maintenance request must not create another peer run.
      await coordinator.runNow();
      expect(host.syncDevice).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(10);
      expect(host.syncDevice).toHaveBeenCalledTimes(2);
      expect(coordinator.snapshot.status).toBe('online');
      await coordinator.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('cancels stale background sync before activating replacement configuration', async () => {
    const host = adapter();
    host.listBackgroundSyncPeerIds = vi.fn(async () => ['peer-a']);
    const oldEntered = deferred<undefined>();
    let oldSignal: AbortSignal | undefined;
    const durableWrites: string[] = [];
    host.syncDevice = vi.fn(async (configuration: Configuration, _peerId: string, signal: AbortSignal) => {
      if (configuration.accountId === 'account-a') {
        oldSignal = signal;
        oldEntered.resolve(undefined);
        await new Promise<void>(resolve => {
          signal.addEventListener('abort', () => {
            resolve();
          }, { once: true });
        });
        if (!signal.aborted) durableWrites.push('account-a');
        return syncResult(true);
      }
      signal.throwIfAborted();
      durableWrites.push(configuration.accountId);
      return syncResult(true);
    });
    const coordinator = new DeviceCloudConnectionCoordinator({
      adapter: host,
      configuration: configured('account-a'),
      heartbeatIntervalMs: 60_000,
      jitterRatio: 0,
    });

    await coordinator.start();
    await oldEntered.promise;
    await coordinator.setConfiguration(configured('account-b'));
    await vi.waitFor(() => {
      expect(durableWrites).toContain('account-b');
    });

    expect(oldSignal?.aborted).toBe(true);
    expect(durableWrites).toEqual(['account-b']);
    expect(coordinator.snapshot).toMatchObject({ generation: 1, status: 'online' });
    await coordinator.stop();
  });

  it('automatically resumes durable incomplete work after coordinator process reconstruction', async () => {
    vi.useFakeTimers();
    try {
      const host = adapter();
      host.listBackgroundSyncPeerIds = vi.fn(async () => ['peer-a']);
      let durableEvents = 0;
      host.syncDevice = vi.fn(async () => {
        if (durableEvents === 0) {
          durableEvents = 4_096;
          return syncResult(false);
        }
        durableEvents = 10_000;
        return syncResult(true);
      });
      const firstProcess = new DeviceCloudConnectionCoordinator({
        adapter: host,
        configuration: configured(),
        heartbeatIntervalMs: 60_000,
        backgroundSyncInitialBackoffMs: 10,
        jitterRatio: 0,
      });

      await firstProcess.start();
      await Promise.resolve();
      await Promise.resolve();
      expect(durableEvents).toBe(4_096);
      await firstProcess.stop();

      const restartedProcess = new DeviceCloudConnectionCoordinator({
        adapter: host,
        configuration: configured(),
        heartbeatIntervalMs: 60_000,
        backgroundSyncInitialBackoffMs: 10,
        jitterRatio: 0,
      });
      await restartedProcess.start();
      await Promise.resolve();
      await Promise.resolve();

      expect(durableEvents).toBe(10_000);
      expect(host.syncDevice).toHaveBeenCalledTimes(2);
      expect(restartedProcess.snapshot.status).toBe('online');
      await restartedProcess.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('retries background network errors without degrading an online Cloud connection', async () => {
    vi.useFakeTimers();
    try {
      const host = adapter();
      const logWarning = vi.fn();
      host.listBackgroundSyncPeerIds = vi.fn(async () => ['peer-a']);
      host.syncDevice = vi.fn()
        .mockRejectedValueOnce(new Error('peer temporarily offline'))
        .mockResolvedValueOnce(syncResult(true));
      const coordinator = new DeviceCloudConnectionCoordinator({
        adapter: host,
        configuration: configured(),
        heartbeatIntervalMs: 60_000,
        backgroundSyncInitialBackoffMs: 10,
        backgroundSyncMaxBackoffMs: 100,
        jitterRatio: 0,
        logWarning,
      });

      await coordinator.start();
      await Promise.resolve();
      await Promise.resolve();
      expect(coordinator.snapshot.status).toBe('online');
      expect(host.syncDevice).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(10);

      expect(host.syncDevice).toHaveBeenCalledTimes(2);
      expect(coordinator.snapshot.status).toBe('online');
      expect(logWarning).toHaveBeenCalledWith(
        'Device Cloud background sync failed',
        expect.objectContaining({ code: 'DEVICE_CLOUD_STEP_FAILED' }),
      );
      await coordinator.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('invalidates registration only when the adapter explicitly classifies it invalid', async () => {
    const host = adapter();
    host.heartbeat.mockRejectedValueOnce(new Error('registration expired'));
    host.classifyError = error =>
      error instanceof Error && error.message === 'registration expired'
        ? 'registration-invalid'
        : 'offline';
    const coordinator = new DeviceCloudConnectionCoordinator({
      adapter: host,
      configuration: configured(),
      heartbeatIntervalMs: 60_000,
      initialBackoffMs: 10,
      jitterRatio: 0,
    });

    await expect(coordinator.start()).rejects.toThrow('registration expired');
    expect(coordinator.snapshot.components.registration).toBe('not-run');
    await coordinator.runNow();
    expect(host.registerDevice).toHaveBeenCalledTimes(2);
    await coordinator.stop();
  });

  it('clearing configuration aborts work and settles at not-configured', async () => {
    const host = adapter();
    let observedSignal: AbortSignal | undefined;
    host.ensureAuthorizer.mockImplementation(async (_configuration: Configuration, signal: AbortSignal) => {
      observedSignal = signal;
      await new Promise<void>((resolve) => {
        signal.addEventListener('abort', () => {
          resolve();
        }, { once: true });
      });
    });
    const coordinator = new DeviceCloudConnectionCoordinator({
      adapter: host,
      configuration: configured(),
    });

    const running = coordinator.start();
    await vi.waitFor(() => {
      expect(observedSignal).toBeDefined();
    });
    await coordinator.setConfiguration(undefined);
    await running;

    expect(observedSignal?.aborted).toBe(true);
    expect(coordinator.snapshot).toMatchObject({ status: 'not-configured', generation: 1 });
  });

  it('can restart the same coordinator after stop without changing configuration', async () => {
    const host = adapter();
    const coordinator = new DeviceCloudConnectionCoordinator({
      adapter: host,
      configuration: configured(),
      heartbeatIntervalMs: 60_000,
    });

    await coordinator.start();
    await coordinator.stop();
    await coordinator.start();

    expect(host.ensureAuthorizer).toHaveBeenCalledTimes(2);
    expect(host.registerDevice).toHaveBeenCalledTimes(2);
    expect(host.ensureRelay).toHaveBeenCalledTimes(2);
    expect(host.heartbeat).toHaveBeenCalledTimes(2);
    expect(host.syncDirectory).toHaveBeenCalledTimes(2);
    expect(coordinator.snapshot.status).toBe('online');
    await coordinator.stop();
  });

  it('serializes A to B to C switches and starts only the newest queued configuration', async () => {
    const host = adapter();
    const firstDispose = deferred<undefined>();
    host.dispose.mockImplementationOnce(async () => firstDispose.promise);
    const coordinator = new DeviceCloudConnectionCoordinator({
      adapter: host,
      configuration: configured('account-a'),
      heartbeatIntervalMs: 60_000,
    });
    await coordinator.start();

    const switchToB = coordinator.setConfiguration(configured('account-b'));
    await vi.waitFor(() => {
      expect(host.dispose).toHaveBeenCalledTimes(1);
    });
    const switchToC = coordinator.setConfiguration(configured('account-c'));
    firstDispose.resolve(undefined);
    await Promise.all([switchToB, switchToC]);

    const registeredAccounts = host.registerDevice.mock.calls
      .map(call => (call[0] as Configuration).accountId);
    expect(registeredAccounts).toEqual(['account-a', 'account-c']);
    expect(host.dispose.mock.calls.filter(call => (call[0] as Configuration).accountId === 'account-a')).toHaveLength(1);
    expect(coordinator.snapshot).toMatchObject({ generation: 2, status: 'online' });
    await coordinator.stop();
  });

  it('fences a delayed old-generation commit before its durable write', async () => {
    const host = adapter();
    const oldCommitEntered = deferred<undefined>();
    const releaseOldCommit = deferred<undefined>();
    const durableValues: string[] = [];
    host.registerDevice.mockImplementation(async (configuration: Configuration) => ({
      commit: async (fence: DeviceCloudCommitFence) => {
        if (fence.generation < 0) {
          // @ts-expect-error Async writes require a durable host CAS, not the synchronous fence.
          fence.commitSynchronous(async () => undefined);
        }
        if (configuration.accountId === 'account-a') {
          oldCommitEntered.resolve(undefined);
          await releaseOldCommit.promise;
        }
        fence.commitSynchronous(() => {
          durableValues.push(configuration.accountId);
        });
      },
    }));
    const coordinator = new DeviceCloudConnectionCoordinator({
      adapter: host,
      configuration: configured('account-a'),
      heartbeatIntervalMs: 60_000,
    });

    const oldRun = coordinator.start();
    await oldCommitEntered.promise;
    const switching = coordinator.setConfiguration(configured('account-b'));
    releaseOldCommit.resolve(undefined);
    await Promise.all([oldRun, switching]);

    expect(durableValues).toEqual(['account-b']);
    expect(host.dispose.mock.calls.filter(call => (call[0] as Configuration).accountId === 'account-a')).toHaveLength(1);
    await coordinator.stop();
  });

  it('does not let a stalled old-generation observer block a new generation', async () => {
    const host = adapter();
    const releaseOldStatus = deferred<undefined>();
    const events: string[] = [];
    const coordinator = new DeviceCloudConnectionCoordinator({
      adapter: host,
      configuration: configured('account-a'),
      heartbeatIntervalMs: 60_000,
      onStatus: async (snapshot, fence) => {
        if (snapshot.generation === 0 && snapshot.status === 'connecting') {
          events.push('old-start');
          await releaseOldStatus.promise;
          fence.commitSynchronous(() => {
            events.push('old-finish');
          });
          return;
        }
        if (snapshot.generation === 1) events.push(`new-${snapshot.status}`);
      },
    });
    const starting = coordinator.start();
    await vi.waitFor(() => {
      expect(events).toContain('old-start');
    });
    const switching = coordinator.setConfiguration(configured('account-b'));
    await Promise.all([starting, switching]);
    await vi.waitFor(() => {
      expect(events).toContain('new-online');
    });
    expect(events).not.toContain('old-finish');
    releaseOldStatus.resolve(undefined);
    await coordinator.stop();
  });

  it('isolates rejecting status observers and warning loggers from maintenance', async () => {
    const host = adapter();
    const warnings: unknown[] = [];
    const coordinator = new DeviceCloudConnectionCoordinator({
      adapter: host,
      configuration: configured(),
      heartbeatIntervalMs: 60_000,
      onStatus: async () => {
        throw new Error('secret-observer-value');
      },
      logWarning: (_message, error) => {
        warnings.push(error);
        throw new Error('logger failed');
      },
    });

    await expect(coordinator.start()).resolves.toBeUndefined();
    expect(coordinator.snapshot.status).toBe('online');
    await vi.waitFor(() => {
      expect(warnings.length).toBeGreaterThan(0);
    });
    expect(JSON.stringify(warnings)).not.toContain('secret-observer-value');
    await coordinator.stop();
  });

  it('exposes deeply immutable, typed, redacted failure snapshots', async () => {
    const host = adapter();
    host.heartbeat.mockRejectedValueOnce(new Error('token=super-secret'));
    const coordinator = new DeviceCloudConnectionCoordinator({
      adapter: host,
      configuration: configured(),
      heartbeatIntervalMs: 60_000,
      initialBackoffMs: 10,
      jitterRatio: 0,
    });

    await expect(coordinator.start()).rejects.toThrow('super-secret');
    const snapshot = coordinator.snapshot;
    expect(snapshot.lastError).toEqual({
      code: 'DEVICE_CLOUD_STEP_FAILED',
      classification: 'offline',
      component: 'heartbeat',
    });
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.components)).toBe(true);
    expect(Object.isFrozen(snapshot.lastError)).toBe(true);
    expect(JSON.stringify(snapshot)).not.toContain('super-secret');
    await coordinator.stop();
  });

  it.each(
    [
      ['heartbeatIntervalMs', 0],
      ['heartbeatIntervalMs', Number.NaN],
      ['heartbeatIntervalMs', Number.POSITIVE_INFINITY],
      ['heartbeatIntervalMs', 0.5],
      ['initialBackoffMs', 0],
      ['maxBackoffMs', 0],
      ['jitterRatio', Number.NaN],
      ['jitterRatio', Number.POSITIVE_INFINITY],
    ] as const,
  )('rejects unsafe %s=%s', (name, value) => {
    const host = adapter();
    expect(() =>
      new DeviceCloudConnectionCoordinator({
        adapter: host,
        configuration: configured(),
        [name]: value,
      })
    ).toThrow(TypeError);
  });

  it('rejects an invalid jitter source instead of scheduling a retry spin', async () => {
    const host = adapter();
    host.heartbeat.mockRejectedValueOnce(new Error('offline'));
    const coordinator = new DeviceCloudConnectionCoordinator({
      adapter: host,
      configuration: configured(),
      heartbeatIntervalMs: 60_000,
      random: () => Number.NaN,
    });

    await expect(coordinator.start()).rejects.toThrow('random()');
    await coordinator.stop();
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, 0.5, Number.MAX_SAFE_INTEGER])(
    'rejects unsafe now() result %s',
    async (now) => {
      const coordinator = new DeviceCloudConnectionCoordinator({
        adapter: adapter(),
        configuration: configured(),
        heartbeatIntervalMs: 60_000,
        now: () => now,
      });
      await expect(coordinator.start()).rejects.toThrow('now()');
      await coordinator.stop();
    },
  );
});
