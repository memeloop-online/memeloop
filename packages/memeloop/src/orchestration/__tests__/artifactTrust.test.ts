import { describe, expect, it } from 'vitest';

import { artifactTrustRank, assertArtifactAdmission, canArtifactEnter, deriveArtifactTrust, inspectAndRecordArtifact } from '../artifactTrust.js';
import type { ArtifactRecordResource, ArtifactReviewEvidence, ArtifactTrust } from '../resources.js';
import { createArtifactRecordManifest, isArtifactRecord } from '../resources.js';

function artifact(trust: ArtifactTrust, status?: ArtifactRecordResource['status'], name = 'a1'): ArtifactRecordResource {
  return {
    ...createArtifactRecordManifest(name, { contentHash: 'sha256:x', trust }),
    metadata: { name, uid: `u-${name}`, generation: 1, resourceVersion: '1', creationTimestamp: '' },
    ...(status ? { status } : {}),
  };
}

function review(kind: ArtifactReviewEvidence['kind'], destination: ArtifactReviewEvidence['destinations'][number], policyDigest: string): ArtifactReviewEvidence {
  return {
    kind,
    outcome: 'passed',
    reviewer: `reviewer-${kind}`,
    contentHash: 'sha256:x',
    policyDigest,
    destinations: [destination],
    recordedAt: '2026-07-17T00:00:00.000Z',
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
    expect(
      canArtifactEnter(
        artifact('restricted', {
          reviews: [review('sanitize', 'prompt', 'builtin:artifact/prompt/v1')],
        }),
        'prompt',
      ).admitted,
    ).toBe(true);
    expect(
      canArtifactEnter(
        artifact('trusted', {
          reviews: [
            review('scan', 'knowledge', 'builtin:artifact/knowledge/v1'),
            review('sanitize', 'knowledge', 'builtin:artifact/knowledge/v1'),
            review('verify', 'knowledge', 'builtin:artifact/knowledge/v1'),
          ],
        }),
        'knowledge',
      ).admitted,
    ).toBe(true);
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

  it('admits lower-trust content only under a destination-bound policy with all reviews', () => {
    const unverified = artifact('quarantine');
    expect(canArtifactEnter(unverified, 'prompt').admitted).toBe(false);

    const policy = {
      minimumTrust: 'restricted' as const,
      policyDigest: 'sha256:explicit-prompt-policy',
      requiredReviews: ['sanitize', 'verify'] as const,
      allowLowerTrust: true,
    };
    const verified = artifact('quarantine', {
      reviews: [
        review('sanitize', 'prompt', policy.policyDigest),
        review('verify', 'prompt', policy.policyDigest),
      ],
    });
    expect(canArtifactEnter(verified, 'prompt', { ...policy, requiredReviews: [...policy.requiredReviews] }).admitted).toBe(true);
    expect(canArtifactEnter(verified, 'knowledge', { ...policy, requiredReviews: [...policy.requiredReviews] }).admitted).toBe(false);
  });

  it('fails closed on failed, stale, or wrong-policy reviews', () => {
    const failed = { ...review('scan', 'volume', 'builtin:artifact/volume/v1'), outcome: 'failed' as const };
    expect(canArtifactEnter(artifact('trusted', { reviews: [failed] }), 'volume').admitted).toBe(false);

    const stale = { ...review('scan', 'volume', 'builtin:artifact/volume/v1'), contentHash: 'sha256:old' };
    expect(canArtifactEnter(artifact('trusted', { reviews: [stale, review('verify', 'volume', 'builtin:artifact/volume/v1')] }), 'volume').admitted).toBe(false);
  });

  it('assertArtifactAdmission throws FORBIDDEN with the reason', () => {
    expect(() => {
      assertArtifactAdmission(artifact('untrusted'), 'knowledge');
    }).toThrowError(
      expect.objectContaining({ code: 'FORBIDDEN' }) as Error,
    );
  });
});

describe('inspectAndRecordArtifact', () => {
  it('records bound evidence and quarantines failed inspection', async () => {
    const appended: ArtifactReviewEvidence[] = [];
    const quarantined: string[] = [];
    const failed = { ...review('scan', 'volume', 'sha256:policy'), outcome: 'failed' as const };
    const result = await inspectAndRecordArtifact(
      artifact('trusted'),
      { policyDigest: 'sha256:policy', destinations: ['volume'], maxBytes: 1024 },
      { inspect: async () => ({ contentHash: 'sha256:x', policyDigest: 'sha256:policy', reviews: [failed] }) },
      {
        appendReview: async (_contentHash, evidence) => {
          appended.push(evidence);
        },
        quarantine: async (_contentHash, reason) => {
          quarantined.push(reason);
        },
      },
    );
    expect(result.reviews).toEqual([failed]);
    expect(appended).toEqual([failed]);
    expect(quarantined).toEqual(['scan review failed']);
  });

  it('quarantines and rejects evidence bound to another content hash', async () => {
    const quarantined: string[] = [];
    await expect(inspectAndRecordArtifact(
      artifact('trusted'),
      { policyDigest: 'sha256:policy', destinations: ['volume'], maxBytes: 1024 },
      { inspect: async () => ({ contentHash: 'sha256:other', policyDigest: 'sha256:policy', reviews: [] }) },
      {
        appendReview: async () => undefined,
        quarantine: async (_contentHash, reason) => {
          quarantined.push(reason);
        },
      },
    )).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(quarantined).toEqual(['artifact inspection result binding mismatch']);
  });
});
