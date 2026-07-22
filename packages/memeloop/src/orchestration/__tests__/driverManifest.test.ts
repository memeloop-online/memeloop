import { describe, expect, it } from 'vitest';

import { createDriverManifestManifest, DRIVER_MANIFEST_API_VERSION, DRIVER_MANIFEST_KIND, isDriverManifest } from '../resources.js';

describe('DriverManifest resource (24.62 item 4)', () => {
  it('builds a manifest and guards the resource shape', () => {
    const manifest = createDriverManifestManifest('kubernetes', {
      driverType: 'external-orchestrator',
      version: '1.0.0',
      capabilities: { maxConcurrency: 32 },
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
});
