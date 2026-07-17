import { describe, expect, it } from 'vitest';

import { artifactTrustRank, assertArtifactAdmission, canArtifactEnter, deriveArtifactTrust } from '../artifactTrust.js';
import type { ArtifactRecordResource, ArtifactTrust } from '../resources.js';
import { createArtifactRecordManifest, isArtifactRecord } from '../resources.js';

function artifact(trust: ArtifactTrust, status?: ArtifactRecordResource['status'], name = 'a1'): ArtifactRecordResource {
  return {
    ...createArtifactRecordManifest(name, { contentHash: 'sha256:x', trust }),
    metadata: { name, uid: `u-${name}`, generation: 1, resourceVersion: '1', creationTimestamp: '' },
    ...(status ? { status } : {}),
  };
}

describe('ArtifactRecord schema', () => {
  it('creates manifests with content address, producer, parents, and trust', () => {
    const manifest = createArtifactRecordManifest('scan-report', {
      contentHash: 'sha256:abc',
      sizeBytes: 1024,
      mimeType: 'application/json',
      producer: {
        runRef: { apiVersion: 'run.memeloop.io/v1alpha1', kind: 'AgentRun', name: 'run-1', uid: 'u1' },
        trust: 'quarantine',
      },
      parents: [{ apiVersion: 'artifacts.memeloop.io/v1alpha1', kind: 'ArtifactRecord', name: 'raw-log' }],
      trust: 'quarantine',
    });

    expect(manifest.apiVersion).toBe('artifacts.memeloop.io/v1alpha1');
    expect(manifest.kind).toBe('ArtifactRecord');
    expect(manifest.spec.producer?.trust).toBe('quarantine');
    expect(isArtifactRecord(manifest)).toBe(true);
    expect(isArtifactRecord({ apiVersion: 'artifacts.memeloop.io/v1alpha1', kind: 'Other' })).toBe(false);
  });
});

describe('deriveArtifactTrust', () => {
  it('orders trust from untrusted to trusted', () => {
    expect(artifactTrustRank('untrusted')).toBeLessThan(artifactTrustRank('quarantine'));
    expect(artifactTrustRank('quarantine')).toBeLessThan(artifactTrustRank('restricted'));
    expect(artifactTrustRank('restricted')).toBeLessThan(artifactTrustRank('trusted'));
  });

  it('derived content inherits the lowest trust of parents and producer', () => {
    expect(deriveArtifactTrust([artifact('trusted')], 'trusted')).toBe('trusted');
    expect(deriveArtifactTrust([artifact('trusted'), artifact('quarantine')], 'trusted')).toBe('quarantine');
    expect(deriveArtifactTrust([artifact('restricted')], 'untrusted')).toBe('untrusted');
  });
});

describe('canArtifactEnter', () => {
  it('admits content meeting the destination minimum trust', () => {
    expect(canArtifactEnter(artifact('restricted'), 'prompt').admitted).toBe(true);
    expect(canArtifactEnter(artifact('trusted'), 'knowledge').admitted).toBe(true);
    expect(canArtifactEnter(artifact('restricted'), 'knowledge').admitted).toBe(false);
  });

  it('never admits quarantined artifacts', () => {
    const quarantined = artifact('trusted', { quarantined: true, quarantineReason: 'malware signature' });
    for (const destination of ['prompt', 'volume', 'backup', 'knowledge'] as const) {
      const decision = canArtifactEnter(quarantined, destination);
      expect(decision.admitted, destination).toBe(false);
      expect(decision.reason).toContain('quarantined');
    }
  });

  it('admits lower-trust content only with a verifier pass when override is allowed', () => {
    const unverified = artifact('quarantine');
    expect(canArtifactEnter(unverified, 'prompt').admitted).toBe(false);

    const verified = artifact('quarantine', { verified: 'passed', verifiedBy: 'verifier-1' });
    expect(canArtifactEnter(verified, 'prompt').admitted).toBe(true);

    // Backup disables verified override.
    expect(canArtifactEnter(verified, 'backup').admitted).toBe(false);

    // A 'passed' without a verifier identity is not a verifier pass.
    const selfReported = artifact('quarantine', { verified: 'passed' });
    expect(canArtifactEnter(selfReported, 'prompt').admitted).toBe(false);
  });

  it('assertArtifactAdmission throws FORBIDDEN with the reason', () => {
    expect(() => {
      assertArtifactAdmission(artifact('untrusted'), 'knowledge');
    }).toThrowError(
      expect.objectContaining({ code: 'FORBIDDEN' }) as Error,
    );
  });
});
