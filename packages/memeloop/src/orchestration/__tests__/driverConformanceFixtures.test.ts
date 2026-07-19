import { describe, expect, it } from 'vitest';

import { runConformanceSuite } from '../driverConformance.js';
import {
  createAdoptionTests,
  createBackpressureTests,
  createCancellationTests,
  createCapabilityNegotiationTests,
  createDowngradeTests,
  createFencingTests,
  createIdempotencyTests,
  createRecordingDriver,
  createReplayingDriver,
  createSecurityTests,
  type DriverFixture,
  negotiateCapabilities,
} from '../driverConformanceFixtures.js';

describe('record/replay fixtures', () => {
  it('records driver interactions into a serializable fixture', async () => {
    const driver = {
      greet: async (name: string) => `hello ${name}`,
      fail: async () => {
        throw new Error('boom');
      },
    };
    const { driver: recording, fixture } = createRecordingDriver(driver, 'network', 'greeting-fixture');

    await recording.greet('world');
    await expect(recording.fail()).rejects.toThrow('boom');

    const recorded = fixture();
    expect(recorded.name).toBe('greeting-fixture');
    expect(recorded.driverKind).toBe('network');
    expect(recorded.interactions).toHaveLength(2);
    expect(recorded.interactions[0]).toMatchObject({ method: 'greet', arguments: ['world'], result: 'hello world' });
    expect(recorded.interactions[1]).toMatchObject({ method: 'fail', error: 'boom' });
    // Fixture must round-trip through JSON.
    expect(() => JSON.stringify(recorded)).not.toThrow();
  });

  it('replays a recorded fixture in order', async () => {
    const fixture: DriverFixture = {
      name: 'replay',
      driverKind: 'network',
      interactions: [
        { method: 'getCapabilities', arguments: [], result: { name: 'fake' }, recordedAt: '2026-07-19T00:00:00.000Z' },
        { method: 'explode', arguments: [], error: 'kaput', recordedAt: '2026-07-19T00:00:01.000Z' },
      ],
    };
    const replaying = createReplayingDriver<{ getCapabilities(): Promise<unknown>; explode(): Promise<unknown> }>(fixture);

    expect(await replaying.getCapabilities()).toEqual({ name: 'fake' });
    await expect(replaying.explode()).rejects.toThrow('kaput');
  });

  it('replay fails on method mismatch', async () => {
    const fixture: DriverFixture = {
      name: 'mismatch',
      driverKind: 'network',
      interactions: [{ method: 'a', arguments: [], result: 1, recordedAt: '2026-07-19T00:00:00.000Z' }],
    };
    const replaying = createReplayingDriver<{ b(): Promise<unknown> }>(fixture);
    await expect(replaying.b()).rejects.toThrow('replay mismatch');
  });
});

describe('negotiateCapabilities', () => {
  it('returns empty when all requirements are satisfied', () => {
    expect(negotiateCapabilities({ egress: true, level: 'process' }, { egress: true })).toEqual([]);
  });

  it('returns missing capabilities', () => {
    expect(negotiateCapabilities({ egress: false }, { egress: true, dns: true })).toEqual(['egress', 'dns']);
  });
});

describe('conformance test generators', () => {
  it('capability negotiation tests pass when driver covers requirements', async () => {
    const suite = {
      interfaceKind: 'network' as const,
      tests: createCapabilityNegotiationTests({
        getCapabilities: async () => ({ egress: true }),
        requiredCapabilities: { egress: true },
      }),
    };
    const result = await runConformanceSuite(suite, {});
    expect(result.failed).toBe(0);
    expect(result.passed).toBe(2);
  });

  it('capability negotiation tests fail when driver lacks requirements', async () => {
    const suite = {
      interfaceKind: 'network' as const,
      tests: createCapabilityNegotiationTests({
        getCapabilities: async () => ({ egress: false }),
        requiredCapabilities: { egress: true },
      }),
    };
    const result = await runConformanceSuite(suite, {});
    expect(result.failed).toBe(1);
  });

  it('cancellation tests verify abort semantics', async () => {
    const suite = {
      interfaceKind: 'tool-execution' as const,
      tests: createCancellationTests({
        startLongOperation: async (_driver, signal) =>
          new Promise<string>((resolve, reject) => {
            const timer = setTimeout(() => {
              resolve('done');
            }, 50);
            signal.addEventListener('abort', () => {
              clearTimeout(timer);
              reject(new Error('cancelled'));
            });
          }),
      }),
    };
    const result = await runConformanceSuite(suite, {});
    expect(result.failed).toBe(0);
  });

  it('backpressure tests detect unbounded acceptance', async () => {
    const suite = {
      interfaceKind: 'tool-execution' as const,
      tests: createBackpressureTests({
        submit: async () => 'accepted',
        concurrencyLimit: 1,
      }),
    };
    const result = await runConformanceSuite(suite, {});
    // Unbounded driver that accepts everything must be flagged.
    expect(result.failed).toBe(1);
  });

  it('adoption tests verify pre-crash resources are discovered', async () => {
    const store = new Set<string>();
    const suite = {
      interfaceKind: 'network' as const,
      tests: createAdoptionTests({
        createResource: async () => {
          store.add('resource-1');
          return 'resource-1';
        },
        recreateDriver: () => ({}),
        listResources: async () => [...store],
      }),
    };
    const result = await runConformanceSuite(suite, {});
    expect(result.failed).toBe(0);
  });

  it('adoption tests fail when restarted driver loses resources', async () => {
    const suite = {
      interfaceKind: 'network' as const,
      tests: createAdoptionTests({
        createResource: async () => 'resource-1',
        recreateDriver: () => ({}),
        listResources: async () => [],
      }),
    };
    const result = await runConformanceSuite(suite, {});
    expect(result.failed).toBe(1);
  });

  it('idempotency tests verify duplicate submissions return same result', async () => {
    const results = new Map<string, unknown>();
    const suite = {
      interfaceKind: 'tool-execution' as const,
      tests: createIdempotencyTests({
        submitWithIdempotencyKey: async (_driver, key) => {
          if (!results.has(key)) results.set(key, { id: key, created: true });
          return results.get(key);
        },
      }),
    };
    const result = await runConformanceSuite(suite, {});
    expect(result.failed).toBe(0);
  });

  it('fencing tests reject stale tokens', async () => {
    let highestFence = 0;
    const suite = {
      interfaceKind: 'storage' as const,
      tests: createFencingTests({
        operateWithFence: async (_driver, fenceToken) => {
          if (fenceToken < highestFence) throw new Error('stale fence');
          highestFence = Math.max(highestFence, fenceToken);
          return { fenceToken };
        },
      }),
    };
    const result = await runConformanceSuite(suite, {});
    expect(result.failed).toBe(0);
  });

  it('downgrade tests reject newer protocol versions', async () => {
    const suite = {
      interfaceKind: 'network' as const,
      tests: createDowngradeTests({
        callWithVersion: async (_driver, version) => {
          if (version !== 'v1') throw new Error(`unsupported version ${version}`);
          return { version };
        },
        supportedVersion: 'v1',
      }),
    };
    const result = await runConformanceSuite(suite, {});
    expect(result.failed).toBe(0);
  });

  it('security tests reject unauthorized actors', async () => {
    const suite = {
      interfaceKind: 'credential' as const,
      tests: createSecurityTests({
        callAsActor: async (_driver, actorId) => {
          if (actorId !== 'controller/trusted') throw new Error('forbidden');
          return { ok: true };
        },
        unauthorizedActorId: 'worker/evil',
        authorizedActorId: 'controller/trusted',
      }),
    };
    const result = await runConformanceSuite(suite, {});
    expect(result.failed).toBe(0);
  });

  it('security tests fail when unauthorized actor is accepted', async () => {
    const suite = {
      interfaceKind: 'credential' as const,
      tests: createSecurityTests({
        callAsActor: async () => ({ ok: true }),
        unauthorizedActorId: 'worker/evil',
        authorizedActorId: 'controller/trusted',
      }),
    };
    const result = await runConformanceSuite(suite, {});
    expect(result.failed).toBe(1);
  });
});
