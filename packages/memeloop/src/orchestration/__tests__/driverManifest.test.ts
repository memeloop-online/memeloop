import { describe, expect, it } from 'vitest';

import { createDriverManifestManifest, DRIVER_MANIFEST_API_VERSION, DRIVER_MANIFEST_KIND, isDriverManifest, isDriverManifestAdmitted } from '../resources.js';

describe('DriverManifest resource (24.62 item 4)', () => {
  it('builds a manifest and guards the resource shape', () => {
    const manifest = createDriverManifestManifest('kubernetes', {
      driverType: 'external-orchestrator',
      version: '1.0.0',
      execution: { location: 'external', transport: 'container-api' },
      supportedTrustClasses: ['trusted'],
      resourceKinds: ['AgentWorkload', 'ToolOperation'],
      capabilities: { maxConcurrency: 32 },
      downgradeBehavior: 'reject',
      requiredHostPrivileges: ['kubernetes-api'],
      isolation: { boundary: 'external', threatAssumptions: ['cluster policy is trusted'] },
      configuration: { schemaRef: 'memeloop://schemas/test/v1', secretRefs: ['tokenRef'] },
      health: { mode: 'method' },
      lifecycle: { discoverable: true, hotReload: false, gracefulShutdown: true },
      conformance: {
        suiteVersion: 'v1',
        status: 'passed',
        passedAt: '2026-07-26T00:00:00.000Z',
        fixtureDigest: 'sha256:fixture',
      },
      supportsCancellation: true,
      supportsBackpressure: false,
      supportsAdoption: false,
      supportsFencing: false,
      manages: ['AgentWorkload', 'ToolOperation'],
      supportsColocation: true,
    });

    expect(manifest.apiVersion).toBe(DRIVER_MANIFEST_API_VERSION);
    expect(manifest.kind).toBe(DRIVER_MANIFEST_KIND);
    expect(manifest.metadata.name).toBe('kubernetes');
    expect(manifest.spec.manages).toEqual(['AgentWorkload', 'ToolOperation']);

    expect(isDriverManifest(manifest)).toBe(true);
    expect(isDriverManifest({ apiVersion: DRIVER_MANIFEST_API_VERSION, kind: 'Other' })).toBe(false);
    expect(isDriverManifest({ apiVersion: 'v1', kind: DRIVER_MANIFEST_KIND })).toBe(false);
  });

  it('admits only a Ready manifest with passing conformance evidence', () => {
    const manifest = createDriverManifestManifest('network', {
      driverType: 'network',
      version: '1.0.0',
      execution: { location: 'node', transport: 'in-process' },
      supportedTrustClasses: ['trusted', 'restricted'],
      resourceKinds: ['NetworkAttachment'],
      capabilities: { egress: true },
      downgradeBehavior: 'reject',
      requiredHostPrivileges: [],
      isolation: { boundary: 'process', threatAssumptions: [] },
      configuration: { schemaRef: 'memeloop://schemas/test/v1', secretRefs: [] },
      health: { mode: 'method' },
      lifecycle: { discoverable: true, hotReload: false, gracefulShutdown: true },
      conformance: { suiteVersion: 'v1', status: 'not-run' },
      supportsCancellation: false,
      supportsBackpressure: false,
      supportsAdoption: true,
      supportsFencing: true,
    });
    const resource = {
      ...manifest,
      metadata: {
        ...manifest.metadata,
        uid: 'manifest-1',
        generation: 1,
        resourceVersion: '1',
        creationTimestamp: '2026-07-26T00:00:00.000Z',
      },
      status: { phase: 'Ready' as const },
    };

    expect(isDriverManifestAdmitted(resource)).toBe(false);
    expect(isDriverManifestAdmitted({
      ...resource,
      spec: {
        ...resource.spec,
        conformance: {
          suiteVersion: 'v1',
          status: 'passed',
          passedAt: '2026-07-26T00:00:00.000Z',
          fixtureDigest: 'sha256:fixture',
        },
      },
    })).toBe(true);
    expect(isDriverManifestAdmitted({
      ...resource,
      status: { phase: 'Pending' },
      spec: {
        ...resource.spec,
        conformance: {
          suiteVersion: 'v1',
          status: 'passed',
          passedAt: '2026-07-26T00:00:00.000Z',
          fixtureDigest: 'sha256:fixture',
        },
      },
    })).toBe(false);
  });
});
