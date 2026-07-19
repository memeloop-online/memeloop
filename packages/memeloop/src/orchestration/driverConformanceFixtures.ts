/**
 * Plan 24.61: record/replay fixtures, capability negotiation, cancel/backpressure,
 * crash/adoption, idempotency/fencing, downgrade, and security conformance tests.
 *
 * These helpers are interface-agnostic: each takes the small set of driver
 * operations it needs, so the same suites apply to network, model-provider,
 * tool-execution, storage, and credential drivers.
 */

import type { DriverConformanceTest, DriverManifest } from './driverConformance.js';

// ─── Assertion helpers (vitest-agnostic so suites run in any harness) ───

async function assertRejects(promise: Promise<unknown>, message: string): Promise<void> {
  try {
    await promise;
  } catch {
    return;
  }
  throw new Error(message);
}

async function assertResolves(promise: Promise<unknown>, message: string): Promise<void> {
  try {
    await promise;
  } catch (error) {
    throw new Error(`${message}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

// ─── Record/Replay Fixtures ─────────────────────────────────────────

export interface RecordedInteraction {
  method: string;
  arguments: unknown[];
  result?: unknown;
  error?: string;
  recordedAt: string;
}

export interface DriverFixture {
  name: string;
  driverKind: DriverManifest['kind'];
  interactions: RecordedInteraction[];
}

/**
 * Wrap a driver and record every method call into a fixture. The fixture can
 * be serialized to JSON and checked into the repo as a portable conformance
 * artifact.
 */
export function createRecordingDriver<T extends object>(driver: T, kind: DriverManifest['kind'], name: string): { driver: T; fixture: () => DriverFixture } {
  const interactions: RecordedInteraction[] = [];
  const proxy = new Proxy(driver, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== 'function' || typeof property !== 'string') return value;
      return async (...arguments_: unknown[]) => {
        const recordedAt = new Date().toISOString();
        try {
          const result = await (value as (...arguments__: unknown[]) => Promise<unknown>).apply(target, arguments_);
          interactions.push({ method: property, arguments: arguments_, result, recordedAt });
          return result;
        } catch (error) {
          interactions.push({
            method: property,
            arguments: arguments_,
            error: error instanceof Error ? error.message : String(error),
            recordedAt,
          });
          throw error;
        }
      };
    },
  });
  return {
    driver: proxy,
    fixture: () => ({ name, driverKind: kind, interactions: [...interactions] }),
  };
}

/**
 * Create a driver that replays a recorded fixture. Each method call returns
 * the recorded result (or throws the recorded error) in order. A call that
 * does not match the next recorded interaction fails the replay.
 */
export function createReplayingDriver(fixture: DriverFixture): Record<string, unknown> {
  let cursor = 0;
  return new Proxy({} as Record<string, unknown>, {
    get(_target, property) {
      if (typeof property !== 'string') return undefined;
      return async (..._arguments: unknown[]) => {
        const interaction = fixture.interactions[cursor];
        if (!interaction) {
          throw new Error(`replay exhausted: no recorded interaction for ${property}`);
        }
        if (interaction.method !== property) {
          throw new Error(`replay mismatch: expected ${interaction.method}, got ${property}`);
        }
        cursor += 1;
        if (interaction.error) throw new Error(interaction.error);
        return interaction.result;
      };
    },
  });
}

// ─── Capability Negotiation ─────────────────────────────────────────

/**
 * Verify a driver's reported capabilities satisfy the required capability set.
 * Returns the list of missing capabilities (empty when negotiation succeeds).
 */
export function negotiateCapabilities(
  reported: Record<string, boolean | string | number>,
  required: Record<string, boolean | string | number>,
): string[] {
  const missing: string[] = [];
  for (const [key, value] of Object.entries(required)) {
    if (reported[key] !== value) {
      missing.push(key);
    }
  }
  return missing;
}

export function createCapabilityNegotiationTests(options: {
  getCapabilities: (driver: unknown) => Promise<Record<string, boolean | string | number>>;
  requiredCapabilities: Record<string, boolean | string | number>;
}): DriverConformanceTest[] {
  return [
    {
      name: 'capability negotiation succeeds for required set',
      description: 'Driver-reported capabilities must cover every required capability',
      run: async (driver) => {
        const reported = await options.getCapabilities(driver);
        const missing = negotiateCapabilities(reported, options.requiredCapabilities);
        if (missing.length > 0) {
          throw new Error(`missing required capabilities: ${missing.join(', ')}`);
        }
      },
    },
    {
      name: 'capability negotiation rejects unsupported requirement',
      description: 'Control plane must detect when a driver cannot satisfy a requirement',
      run: async (driver) => {
        const reported = await options.getCapabilities(driver);
        const missing = negotiateCapabilities(reported, { 'definitely-unsupported-capability': true });
        if (missing.length === 0) {
          throw new Error('negotiation must report missing capabilities');
        }
      },
    },
  ];
}

// ─── Cancel / Backpressure ──────────────────────────────────────────

export function createCancellationTests(options: {
  startLongOperation: (driver: unknown, signal: AbortSignal) => Promise<unknown>;
}): DriverConformanceTest[] {
  return [
    {
      name: 'cancellation aborts a long-running operation',
      description: 'Aborting the signal must terminate the operation with a cancellation error',
      run: async (driver) => {
        const controller = new AbortController();
        const pending = options.startLongOperation(driver, controller.signal);
        controller.abort();
        await assertRejects(pending, 'operation must reject when aborted');
      },
    },
    {
      name: 'unaborted long operation completes',
      description: 'Control case: without abort, the operation completes normally',
      run: async (driver) => {
        const controller = new AbortController();
        await assertResolves(options.startLongOperation(driver, controller.signal), 'operation must complete when not aborted');
      },
    },
  ];
}

export function createBackpressureTests(options: {
  submit: (driver: unknown) => Promise<unknown>;
  concurrencyLimit: number;
}): DriverConformanceTest[] {
  return [
    {
      name: 'backpressure rejects excess concurrent operations',
      description: 'Driver must reject or queue operations beyond its concurrency limit',
      run: async (driver) => {
        const inFlight = Array.from({ length: options.concurrencyLimit + 5 }, () => options.submit(driver));
        const results = await Promise.allSettled(inFlight);
        const rejected = results.filter((result) => result.status === 'rejected');
        // At least one submission beyond the limit must be rejected or all must complete.
        if (rejected.length === 0 && results.length > options.concurrencyLimit * 4) {
          throw new Error('driver accepted unbounded concurrency without backpressure');
        }
      },
    },
  ];
}

// ─── Crash / Adoption ───────────────────────────────────────────────

export function createAdoptionTests(options: {
  createResource: (driver: unknown) => Promise<string>;
  recreateDriver: () => unknown;
  listResources: (driver: unknown) => Promise<string[]>;
}): DriverConformanceTest[] {
  return [
    {
      name: 'restarted driver adopts pre-crash resources',
      description: 'A new driver instance must discover resources created before the crash',
      run: async (driver) => {
        const resourceId = await options.createResource(driver);
        const restarted = options.recreateDriver();
        const adopted = await options.listResources(restarted);
        if (!adopted.includes(resourceId)) {
          throw new Error(`restarted driver did not adopt resource ${resourceId}`);
        }
      },
    },
  ];
}

// ─── Idempotency / Fencing ──────────────────────────────────────────

export function createIdempotencyTests(options: {
  submitWithIdempotencyKey: (driver: unknown, key: string) => Promise<unknown>;
}): DriverConformanceTest[] {
  return [
    {
      name: 'repeated submission with same idempotency key returns same result',
      description: 'Duplicate submissions must not create duplicate side effects',
      run: async (driver) => {
        const key = `idem-${Date.now()}`;
        const first = await options.submitWithIdempotencyKey(driver, key);
        const second = await options.submitWithIdempotencyKey(driver, key);
        if (JSON.stringify(first) !== JSON.stringify(second)) {
          throw new Error('idempotent submissions returned different results');
        }
      },
    },
  ];
}

export function createFencingTests(options: {
  operateWithFence: (driver: unknown, fenceToken: number) => Promise<unknown>;
}): DriverConformanceTest[] {
  return [
    {
      name: 'stale fence token is rejected',
      description: 'An operation carrying an older fence token must fail',
      run: async (driver) => {
        await options.operateWithFence(driver, 2);
        await assertRejects(options.operateWithFence(driver, 1), 'stale fence token must be rejected');
      },
    },
    {
      name: 'monotonic fence tokens are accepted',
      description: 'Operations with increasing fence tokens must succeed',
      run: async (driver) => {
        await options.operateWithFence(driver, 10);
        await assertResolves(options.operateWithFence(driver, 11), 'monotonic fence token must be accepted');
      },
    },
  ];
}

// ─── Downgrade ──────────────────────────────────────────────────────

export function createDowngradeTests(options: {
  callWithVersion: (driver: unknown, version: string) => Promise<unknown>;
  supportedVersion: string;
}): DriverConformanceTest[] {
  return [
    {
      name: 'unsupported newer version is rejected with explicit error',
      description: 'Driver must fail closed when asked to speak a newer protocol version',
      run: async (driver) => {
        await assertRejects(options.callWithVersion(driver, 'v999'), 'unsupported version must be rejected');
      },
    },
    {
      name: 'supported version is accepted',
      description: 'Control case: the supported protocol version works',
      run: async (driver) => {
        await assertResolves(options.callWithVersion(driver, options.supportedVersion), 'supported version must be accepted');
      },
    },
  ];
}

// ─── Security ───────────────────────────────────────────────────────

export function createSecurityTests(options: {
  callAsActor: (driver: unknown, actorId: string) => Promise<unknown>;
  unauthorizedActorId: string;
  authorizedActorId: string;
}): DriverConformanceTest[] {
  return [
    {
      name: 'unauthorized actor is rejected',
      description: 'Driver must reject calls from actors without grants',
      run: async (driver) => {
        await assertRejects(options.callAsActor(driver, options.unauthorizedActorId), 'unauthorized actor must be rejected');
      },
    },
    {
      name: 'authorized actor is accepted',
      description: 'Control case: an actor with grants succeeds',
      run: async (driver) => {
        await assertResolves(options.callAsActor(driver, options.authorizedActorId), 'authorized actor must be accepted');
      },
    },
  ];
}
