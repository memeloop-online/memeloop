import { describe, expect, it, vi } from 'vitest';

import { type DeviceCloudConnectionAdapter, DeviceCloudConnectionCoordinator, type DeviceCloudStepResult } from '../deviceCloudConnectionCoordinator.js';

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
} {
  return {
    isConfigured: (value): value is Configuration => value !== undefined && value.url.length > 0,
    relayRequiredForOnline: (value) => value.relayRequired,
    ensureAuthorizer: vi.fn(async () => undefined),
    registerDevice: vi.fn(async () => undefined),
    ensureRelay: vi.fn(async () => undefined),
    heartbeat: vi.fn(async () => undefined),
    syncDirectory: vi.fn(async () => undefined),
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
    await coordinator.setConfiguration(configured('account-b'));
    oldRegistration.resolve({ commit: oldCommit });
    await oldRun;

    expect(oldCommit).not.toHaveBeenCalled();
    expect(newCommit).toHaveBeenCalledOnce();
    expect(coordinator.snapshot).toMatchObject({ generation: 1, status: 'online' });
    await coordinator.stop();
  });

  it('serializes concurrent maintenance and re-registers after heartbeat loss', async () => {
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

    expect(host.ensureAuthorizer).toHaveBeenCalledTimes(1);
    expect(host.registerDevice).toHaveBeenCalledTimes(1);
    expect(host.ensureRelay).toHaveBeenCalledTimes(2);
    expect(host.heartbeat).toHaveBeenCalledTimes(2);
    expect(host.syncDirectory).toHaveBeenCalledTimes(2);
    expect(coordinator.snapshot.status).toBe('online');
    await coordinator.stop();
  });
});
