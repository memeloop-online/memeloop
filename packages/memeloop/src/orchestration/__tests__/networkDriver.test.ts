import { describe, expect, it } from 'vitest';

import { canDriverSatisfyClass, featuresRequiredByClass, type NetworkDriverCapabilities } from '../networkDriver.js';
import {
  createNetworkAttachmentManifest,
  createNetworkClassManifest,
  isNetworkAttachment,
  isNetworkClass,
  NETWORK_CLASS_API_VERSION,
  type NetworkClassResource,
} from '../resources.js';

function classResource(spec: Parameters<typeof createNetworkClassManifest>[1]): NetworkClassResource {
  const manifest = createNetworkClassManifest('net-1', spec);
  return {
    ...manifest,
    metadata: {
      name: 'net-1',
      uid: 'uid-net-1',
      generation: 1,
      resourceVersion: '1',
      creationTimestamp: '2026-07-17T00:00:00.000Z',
    },
  } as NetworkClassResource;
}

const FULL_DRIVER: NetworkDriverCapabilities = {
  name: 'full',
  enforcedFeatures: ['dns', 'proxy', 'ingress', 'egress', 'bandwidth', 'service-access'],
  supportsRequiredEnforcement: true,
};

describe('NetworkClass and NetworkAttachment schemas', () => {
  it('creates a NetworkClass manifest with dns, proxy, ingress, egress, service access, bandwidth, data policy, and enforcement', () => {
    const manifest = createNetworkClassManifest('isolated-egress', {
      description: 'Only model gateway egress allowed',
      driver: 'process-env',
      dns: { policy: 'custom', servers: ['1.1.1.1'] },
      proxy: { httpsProxy: 'http://proxy:8080', mandatory: true },
      ingress: { defaultAction: 'deny' },
      egress: {
        defaultAction: 'deny',
        rules: [{ target: 'gateway.memeloop.local', ports: [443], protocol: 'https', action: 'allow' }],
      },
      serviceAccess: { allowModelGateway: true, allowControlPlane: false },
      bandwidth: { egressKbps: 1024 },
      dataPolicy: { classification: 'internal' },
      enforcement: 'required',
    });

    expect(manifest.apiVersion).toBe(NETWORK_CLASS_API_VERSION);
    expect(manifest.spec.egress?.rules?.[0].target).toBe('gateway.memeloop.local');
    expect(manifest.spec.enforcement).toBe('required');
    expect(isNetworkClass(manifest)).toBe(true);

    const attachment = createNetworkAttachmentManifest('attach-1', {
      networkClassRef: { apiVersion: NETWORK_CLASS_API_VERSION, kind: 'NetworkClass', name: 'isolated-egress' },
      workloadRef: { apiVersion: 'workload.memeloop.io/v1alpha1', kind: 'AgentWorkload', name: 'w1', uid: 'uid-w1' },
      nodeId: 'node-a',
    });
    expect(attachment.spec.networkClassRef.name).toBe('isolated-egress');
    expect(isNetworkAttachment(attachment)).toBe(true);
    expect(isNetworkClass(attachment)).toBe(false);
  });
});

describe('featuresRequiredByClass', () => {
  it('lists only the features the class actually configures', () => {
    expect(featuresRequiredByClass(classResource({ driver: 'd', enforcement: 'best-effort' }))).toEqual([]);
    expect(
      featuresRequiredByClass(classResource({
        driver: 'd',
        enforcement: 'best-effort',
        dns: { policy: 'none' },
        egress: { defaultAction: 'deny' },
      })),
    ).toEqual(['dns', 'egress']);
    expect(
      featuresRequiredByClass(classResource({
        driver: 'd',
        enforcement: 'best-effort',
        dns: { policy: 'default' },
        bandwidth: { egressKbps: 1 },
      })),
    ).toEqual(['bandwidth']);
  });
});

describe('canDriverSatisfyClass', () => {
  it('accepts a required class when the driver enforces every configured feature', () => {
    const result = canDriverSatisfyClass(
      FULL_DRIVER,
      classResource({ driver: 'full', enforcement: 'required', egress: { defaultAction: 'deny' } }),
    );
    expect(result.satisfied).toBe(true);
    expect(result.unsupportedFeatures).toEqual([]);
  });

  it('rejects a required class when the driver misses a feature', () => {
    const result = canDriverSatisfyClass(
      { name: 'egress-only', enforcedFeatures: ['egress'], supportsRequiredEnforcement: true },
      classResource({ driver: 'egress-only', enforcement: 'required', proxy: { mandatory: true }, egress: { defaultAction: 'deny' } }),
    );
    expect(result.satisfied).toBe(false);
    expect(result.unsupportedFeatures).toEqual(['proxy']);
  });

  it('rejects a required class when the driver cannot do required enforcement at all', () => {
    const result = canDriverSatisfyClass(
      { name: 'weak', enforcedFeatures: ['egress'], supportsRequiredEnforcement: false },
      classResource({ driver: 'weak', enforcement: 'required', egress: { defaultAction: 'deny' } }),
    );
    expect(result.satisfied).toBe(false);
    expect(result.reason).toContain('required enforcement');
  });

  it('reports degraded features for best-effort classes without failing', () => {
    const result = canDriverSatisfyClass(
      { name: 'egress-only', enforcedFeatures: ['egress'], supportsRequiredEnforcement: false },
      classResource({ driver: 'egress-only', enforcement: 'best-effort', proxy: { mandatory: true }, egress: { defaultAction: 'deny' } }),
    );
    expect(result.satisfied).toBe(true);
    expect(result.unsupportedFeatures).toEqual(['proxy']);
    expect(result.reason).toContain('degrade');
  });
});
