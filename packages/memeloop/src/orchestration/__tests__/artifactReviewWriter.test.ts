import { describe, expect, it, vi } from 'vitest';
import { createControlStoreArtifactReviewWriter } from '../artifactReviewWriter.js';
import type { OrchestrationResource, OrchestrationResourceReference } from '../client.js';
import type { ControlStore, ControlStoreActor } from '../controlStore.js';
import type { ArtifactRecordResource, ArtifactReviewEvidence } from '../resources.js';
import { createArtifactRecordManifest } from '../resources.js';
import { createVerifierOnlyAuthorizer } from '../verifierOnlyTransitions.js';

function makeArtifact(name = 'sha256:abc'): ArtifactRecordResource {
  return {
    ...createArtifactRecordManifest(name, { contentHash: 'sha256:abc', trust: 'restricted' }),
    metadata: {
      name,
      namespace: 'default',
      uid: `uid-${name}`,
      generation: 1,
      resourceVersion: '1',
      creationTimestamp: '2026-07-19T00:00:00.000Z',
    },
    status: {
      reviews: [],
      quarantined: false,
    },
  } as ArtifactRecordResource;
}

function makeReview(overrides: Partial<ArtifactReviewEvidence> = {}): ArtifactReviewEvidence {
  return {
    contentHash: 'sha256:abc',
    kind: 'scan',
    outcome: 'passed',
    reviewer: 'verifier/scanner-1',
    destinations: ['volume'],
    policyDigest: 'builtin:artifact/volume/v1',
    recordedAt: '2026-07-19T00:00:00.000Z',
    ...overrides,
  };
}

function makeFakeStore(resource: ArtifactRecordResource): ControlStore {
  let stored = { ...resource };

  return {
    get: vi.fn(async () => ({ ...stored })),
    updateStatus: vi.fn(async (_actor, _ref, status, _options) => {
      stored = {
        ...stored,
        status: status as ArtifactRecordResource['status'],
        metadata: { ...stored.metadata, resourceVersion: String(Number(stored.metadata.resourceVersion) + 1) },
      };
      return { ...stored };
    }),
    list: vi.fn(async () => ({ items: [] })),
    create: vi.fn(async () => ({} as OrchestrationResource)),
    delete: vi.fn(async () => ({ deleted: true })),
    watch: vi.fn(() => ({
      [Symbol.asyncIterator]() {
        return { next: () => new Promise(() => {}), return: () => Promise.resolve({ done: true }) };
      },
    })),
    acquireLease: vi.fn(async () => ({ name: '', holder: '', leaseId: '', epoch: '1', acquiredAt: '', renewedAt: '', expiresAt: '', resourceVersion: '1' })),
    renewLease: vi.fn(async () => ({ name: '', holder: '', leaseId: '', epoch: '1', acquiredAt: '', renewedAt: '', expiresAt: '', resourceVersion: '1' })),
    releaseLease: vi.fn(async () => undefined),
    compact: vi.fn(async () => ({ compactedThrough: '0', resourceVersion: '0' })),
    snapshot: vi.fn(async () => ({ resourceVersion: '0', createdAt: '' })),
    getHealth: vi.fn(async () => ({ healthy: true, resourceVersion: '0' })),
    close: vi.fn(async () => undefined),
  } as unknown as ControlStore;
}

describe('createControlStoreArtifactReviewWriter', () => {
  const verifierActor: ControlStoreActor = { id: 'verifier/scanner-1', kind: 'verifier' };
  const nonVerifierActor: ControlStoreActor = { id: 'controller/storage', kind: 'controller' };

  it('verifier actor appends review through ControlStore CAS', async () => {
    const artifact = makeArtifact();
    const store = makeFakeStore(artifact);
    const authorizer = createVerifierOnlyAuthorizer();
    const writer = createControlStoreArtifactReviewWriter(store, verifierActor, authorizer);

    const review = makeReview();
    await writer.appendReview('sha256:abc', review);

    expect(store.updateStatus).toHaveBeenCalled();
    const call = (store.updateStatus as ReturnType<typeof vi.fn>).mock.calls[0] as unknown[];
    const ref = call[1] as OrchestrationResourceReference;
    // resourceVersion is in options, not reference
    expect(ref.kind).toBe('ArtifactRecord');

    const status = call[2] as ArtifactRecordResource['status'];
    expect(status?.reviews?.length).toBe(1);
    expect(status?.reviews?.[0].reviewer).toBe('verifier/scanner-1');
  });

  it('non-verifier actor cannot append review', async () => {
    const artifact = makeArtifact();
    const store = makeFakeStore(artifact);
    const authorizer = createVerifierOnlyAuthorizer();
    const writer = createControlStoreArtifactReviewWriter(store, nonVerifierActor, authorizer);

    await expect(writer.appendReview('sha256:abc', makeReview())).rejects.toThrow('verifier actor');
    expect(store.updateStatus).not.toHaveBeenCalled();
  });

  it('any actor may quarantine (fail-safe)', async () => {
    const artifact = makeArtifact();
    const store = makeFakeStore(artifact);
    const authorizer = createVerifierOnlyAuthorizer();
    const writer = createControlStoreArtifactReviewWriter(store, nonVerifierActor, authorizer);

    await writer.quarantine('sha256:abc', 'detected threat');

    expect(store.updateStatus).toHaveBeenCalled();
    const call = (store.updateStatus as ReturnType<typeof vi.fn>).mock.calls[0] as unknown[];
    const status = call[2] as ArtifactRecordResource['status'];
    expect(status?.quarantined).toBe(true);
    expect(status?.quarantineReason).toBe('detected threat');
  });

  it('throws when artifact is not found', async () => {
    const store = makeFakeStore(makeArtifact());
    store.get = vi.fn(async () => null);

    const authorizer = createVerifierOnlyAuthorizer();
    const writer = createControlStoreArtifactReviewWriter(store, verifierActor, authorizer);

    await expect(writer.appendReview('sha256:bad', makeReview({ contentHash: 'sha256:bad' }))).rejects.toThrow('not found');
  });

  it('binds review evidence to current content hash', async () => {
    const artifact = makeArtifact();
    const store = makeFakeStore(artifact);
    // Verifier authorizer rejects review whose contentHash doesn't match artifact
    const authorizer = createVerifierOnlyAuthorizer();
    const writer = createControlStoreArtifactReviewWriter(store, verifierActor, authorizer);

    const badReview = makeReview({ contentHash: 'sha256:xyz' });
    await expect(writer.appendReview('sha256:abc', badReview)).rejects.toThrow();
    expect(store.updateStatus).not.toHaveBeenCalled();
  });
});
