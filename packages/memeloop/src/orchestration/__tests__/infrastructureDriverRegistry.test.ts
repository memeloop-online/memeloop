import { describe, expect, it, vi } from 'vitest';

import { InfrastructureDriverRegistry } from '../drivers/infrastructureDriverRegistry.js';
import type { DriverManifestResource } from '../resources.js';

const admission = {
  packageDigest: `sha256:${'1'.repeat(64)}`,
  configurationDigest: `sha256:${'2'.repeat(64)}`,
  fixtureDigest: `sha256:${'3'.repeat(64)}`,
};

function manifest(status: 'not-run' | 'failed' | 'passed', namespace?: string): DriverManifestResource {
  const conformance = status === 'passed'
    ? {
      suiteVersion: 'v1',
      status,
      passedAt: '2026-08-26T00:00:00.000Z',
      ...admission,
      verifiedBy: 'verifier/driver-conformance',
      attestation: 'signature',
      testsPassed: 4,
    } as const
    : status === 'failed'
    ? {
      suiteVersion: 'v1',
      status,
      failedAt: '2026-08-26T00:00:00.000Z',
      failure: 'external_driver_conformance_failed',
    } as const
    : { suiteVersion: 'v1', status } as const;
  return {
    apiVersion: 'drivers.memeloop.io/v1alpha1',
    kind: 'DriverManifest',
    metadata: {
      name: 'external',
      ...(namespace === undefined ? {} : { namespace }),
      uid: 'driver-external',
      generation: 1,
      resourceVersion: '1',
      creationTimestamp: '2026-08-26T00:00:00.000Z',
    },
    spec: {
      driverType: 'external-orchestrator',
      version: '1',
      execution: { location: 'external', transport: 'container-api' },
      supportedTrustClasses: ['restricted'],
      resourceKinds: ['AgentWorkload'],
      capabilities: {},
      downgradeBehavior: 'reject',
      requiredHostPrivileges: [],
      isolation: { boundary: 'external', threatAssumptions: [] },
      configuration: { schemaRef: 'schema', secretRefs: [] },
      health: { mode: 'method' },
      lifecycle: { discoverable: true, hotReload: false, gracefulShutdown: true },
      conformance,
      supportsCancellation: true,
      supportsBackpressure: false,
      supportsAdoption: true,
      supportsFencing: false,
    },
    status: { phase: 'Ready' },
  };
}

describe('InfrastructureDriverRegistry', () => {
  it.each(['not-run', 'failed'] as const)('rejects %s conformance without invoking verifier', async status => {
    const verifyAdmission = vi.fn(() => true);
    const registry = new InfrastructureDriverRegistry<string>({ verifyAdmission });
    expect(await registry.register({ name: 'external', driver: 'driver', manifest: manifest(status), admission })).toBe(false);
    expect(registry.values()).toEqual([]);
    expect(verifyAdmission).not.toHaveBeenCalled();
  });

  it('accepts only an exact passed binding with a trusted attestation', async () => {
    const registry = new InfrastructureDriverRegistry<string>({ verifyAdmission: () => true });
    expect(await registry.register({ name: 'external', driver: 'driver', manifest: manifest('passed'), admission })).toBe(true);
    expect(registry.get({ name: 'external' })).toBe('driver');
  });

  it('rejects a passed self-report when the cryptographic verifier denies it', async () => {
    const registry = new InfrastructureDriverRegistry<string>({ verifyAdmission: () => false });
    expect(await registry.register({ name: 'external', driver: 'malicious', manifest: manifest('passed'), admission })).toBe(false);
    expect(registry.values()).toEqual([]);
  });

  it('isolates equal names in different namespaces', async () => {
    const registry = new InfrastructureDriverRegistry<string>({ verifyAdmission: () => true });
    expect(
      await registry.register({
        name: 'external',
        namespace: 'team-a',
        driver: 'driver-a',
        manifest: manifest('passed', 'team-a'),
        admission,
      }),
    ).toBe(true);
    expect(
      await registry.register({
        name: 'external',
        namespace: 'team-b',
        driver: 'driver-b',
        manifest: manifest('passed', 'team-b'),
        admission,
      }),
    ).toBe(true);
    expect(registry.get({ name: 'external', namespace: 'team-a' })).toBe('driver-a');
    expect(registry.get({ name: 'external', namespace: 'team-b' })).toBe('driver-b');
    expect(registry.get({ name: 'external' })).toBeUndefined();
  });
});
