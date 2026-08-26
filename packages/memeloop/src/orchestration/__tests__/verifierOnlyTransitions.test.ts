import { describe, expect, it } from 'vitest';

import { createVerifierOnlyAuthorizer, isVerifierActor } from '../artifacts/verifierOnlyTransitions.js';
import type { ControlStoreAuthorizationRequest } from '../controlStore.js';
import type { ArtifactRecordResource, ArtifactReviewEvidence } from '../resources.js';
import { createArtifactRecordManifest } from '../resources.js';

function makeArtifact(
  name = 'artifact-1',
  contentHash = 'sha256:abc123',
  status?: ArtifactRecordResource['status'],
): ArtifactRecordResource {
  return {
    ...createArtifactRecordManifest(name, { contentHash, trust: 'restricted' }),
    metadata: {
      name,
      namespace: 'default',
      uid: `uid-${name}`,
      generation: 1,
      resourceVersion: '1',
      creationTimestamp: '2026-07-18T00:00:00.000Z',
    },
    status,
  } as ArtifactRecordResource;
}

function makeReview(overrides?: Partial<ArtifactReviewEvidence>): ArtifactReviewEvidence {
  return {
    kind: 'scan',
    outcome: 'passed',
    reviewer: 'verifier/main',
    contentHash: 'sha256:abc123',
    policyDigest: 'builtin:artifact/prompt/v1',
    destinations: ['prompt'],
    recordedAt: '2026-07-18T00:00:00.000Z',
    ...overrides,
  };
}

function makeRequest(
  overrides: Omit<Partial<ControlStoreAuthorizationRequest>, 'current' | 'proposedStatus'> & {
    current?: ArtifactRecordResource;
    proposedStatus?: NonNullable<ArtifactRecordResource['status']>;
  },
): ControlStoreAuthorizationRequest {
  const { current, proposedStatus, ...rest } = overrides;
  return {
    actor: { id: 'controller/storage', kind: 'controller' },
    verb: 'update-status',
    reference: { apiVersion: 'artifacts.memeloop.io/v1alpha1', kind: 'ArtifactRecord', name: 'artifact-1', namespace: 'default' },
    ...rest,
    current: current === undefined ? undefined : {
      ...current,
      spec: { ...current.spec },
    },
    proposedStatus,
  };
}

describe('createVerifierOnlyAuthorizer', () => {
  it('allows ArtifactRecord creation by any actor', () => {
    const authorizer = createVerifierOnlyAuthorizer();
    expect(() => {
      authorizer(
        makeRequest({
          verb: 'create',
          current: undefined,
        }),
      );
    }).not.toThrow();
  });

  it('allows status update that does not change reviews or quarantine', () => {
    const authorizer = createVerifierOnlyAuthorizer();
    const current = makeArtifact('a1', 'sha256:abc123', { reviews: [makeReview()] });
    expect(() => {
      authorizer(
        makeRequest({
          current,
          proposedStatus: { reviews: [makeReview()], quarantined: false },
        }),
      );
    }).not.toThrow();
  });

  it('rejects review append by non-verifier actor', () => {
    const authorizer = createVerifierOnlyAuthorizer();
    const current = makeArtifact('a1', 'sha256:abc123', { reviews: [] });
    expect(() => {
      authorizer(
        makeRequest({
          actor: { id: 'controller/storage', kind: 'controller' },
          current,
          proposedStatus: { reviews: [makeReview()] },
        }),
      );
    }).toThrow('require a verifier actor');
  });

  it('allows review append by verifier actor', () => {
    const authorizer = createVerifierOnlyAuthorizer();
    const current = makeArtifact('a1', 'sha256:abc123', { reviews: [] });
    expect(() => {
      authorizer(
        makeRequest({
          actor: { id: 'verifier/main', kind: 'verifier' },
          current,
          proposedStatus: { reviews: [makeReview()] },
        }),
      );
    }).not.toThrow();
  });

  it('rejects review with mismatched contentHash', () => {
    const authorizer = createVerifierOnlyAuthorizer();
    const current = makeArtifact('a1', 'sha256:abc123', { reviews: [] });
    expect(() => {
      authorizer(
        makeRequest({
          actor: { id: 'verifier/main', kind: 'verifier' },
          current,
          proposedStatus: { reviews: [makeReview({ contentHash: 'sha256:other' })] },
        }),
      );
    }).toThrow('does not match artifact contentHash');
  });

  it('rejects review with mismatched reviewer', () => {
    const authorizer = createVerifierOnlyAuthorizer();
    const current = makeArtifact('a1', 'sha256:abc123', { reviews: [] });
    expect(() => {
      authorizer(
        makeRequest({
          actor: { id: 'verifier/main', kind: 'verifier' },
          current,
          proposedStatus: { reviews: [makeReview({ reviewer: 'verifier/other' })] },
        }),
      );
    }).toThrow('must match the acting verifier');
  });

  it('rejects review without recordedAt', () => {
    const authorizer = createVerifierOnlyAuthorizer();
    const current = makeArtifact('a1', 'sha256:abc123', { reviews: [] });
    expect(() => {
      authorizer(
        makeRequest({
          actor: { id: 'verifier/main', kind: 'verifier' },
          current,
          proposedStatus: { reviews: [makeReview({ recordedAt: '' })] },
        }),
      );
    }).toThrow('must record recordedAt timestamp');
  });

  it('rejects review removal', () => {
    const authorizer = createVerifierOnlyAuthorizer();
    const current = makeArtifact('a1', 'sha256:abc123', { reviews: [makeReview()] });
    expect(() => {
      authorizer(
        makeRequest({
          actor: { id: 'verifier/main', kind: 'verifier' },
          current,
          proposedStatus: { reviews: [] },
        }),
      );
    }).toThrow('reviews cannot be removed');
  });

  it('rejects review modification', () => {
    const authorizer = createVerifierOnlyAuthorizer();
    const current = makeArtifact('a1', 'sha256:abc123', { reviews: [makeReview()] });
    expect(() => {
      authorizer(
        makeRequest({
          actor: { id: 'verifier/main', kind: 'verifier' },
          current,
          proposedStatus: { reviews: [makeReview({ outcome: 'failed' })] },
        }),
      );
    }).toThrow('reviews cannot be modified');
  });

  it('allows quarantine by any actor (fail-safe)', () => {
    const authorizer = createVerifierOnlyAuthorizer();
    const current = makeArtifact('a1', 'sha256:abc123', { reviews: [] });
    expect(() => {
      authorizer(
        makeRequest({
          actor: { id: 'controller/storage', kind: 'controller' },
          current,
          proposedStatus: { reviews: [], quarantined: true, quarantineReason: 'suspicious' },
        }),
      );
    }).not.toThrow();
  });

  it('rejects unquarantine by non-verifier actor', () => {
    const authorizer = createVerifierOnlyAuthorizer();
    const current = makeArtifact('a1', 'sha256:abc123', { reviews: [], quarantined: true, quarantineReason: 'suspicious' });
    expect(() => {
      authorizer(
        makeRequest({
          actor: { id: 'controller/storage', kind: 'controller' },
          current,
          proposedStatus: { reviews: [], quarantined: false },
        }),
      );
    }).toThrow('require a verifier actor');
  });

  it('allows unquarantine by verifier with passing verify review', () => {
    const authorizer = createVerifierOnlyAuthorizer();
    const current = makeArtifact('a1', 'sha256:abc123', { reviews: [], quarantined: true, quarantineReason: 'suspicious' });
    expect(() => {
      authorizer(
        makeRequest({
          actor: { id: 'verifier/main', kind: 'verifier' },
          current,
          proposedStatus: {
            reviews: [makeReview({ kind: 'verify', outcome: 'passed' })],
            quarantined: false,
          },
        }),
      );
    }).not.toThrow();
  });

  it('ignores non-ArtifactRecord resources', () => {
    const authorizer = createVerifierOnlyAuthorizer();
    expect(() => {
      authorizer(
        makeRequest({
          reference: { apiVersion: 'memeloop/v1', kind: 'AgentRun', name: 'run-1' },
        }),
      );
    }).not.toThrow();
  });
});

describe('isVerifierActor', () => {
  it('identifies verifier actors by prefix', () => {
    expect(isVerifierActor('verifier/main')).toBe(true);
    expect(isVerifierActor('verifier/artifact-scan')).toBe(true);
    expect(isVerifierActor('controller/storage')).toBe(false);
    expect(isVerifierActor('worker/node-1')).toBe(false);
  });

  it('supports custom verifier prefix', () => {
    expect(isVerifierActor('custom-verifier/x', 'custom-verifier/')).toBe(true);
    expect(isVerifierActor('verifier/main', 'custom-verifier/')).toBe(false);
  });
});
