import { describe, expect, it } from 'vitest';

import type { OrchestrationResource } from '../client.js';
import type { ControlStoreAuthorizationRequest } from '../controlStore.js';
import { createNodeTrustAuthorizer, isNodeAllowedForRole, NODE_KIND, type NodeSpec, type NodeStatus, validateNodeSpec } from '../nodeTrustAdmission.js';

function makeNodeResource(trustClass: string, name = 'node-1'): OrchestrationResource<NodeSpec, NodeStatus> {
  return {
    apiVersion: 'memeloop/v1',
    kind: NODE_KIND,
    metadata: {
      name,
      namespace: 'default',
      uid: `uid-${name}`,
      generation: 1,
      resourceVersion: '1',
      creationTimestamp: '2026-07-18T00:00:00.000Z',
    },
    spec: {
      nodeId: name,
      faultDomain: 'zone-1',
    },
    status: {
      trustClass: trustClass as NodeStatus['trustClass'],
    },
  };
}

function makeRequest(
  overrides: Partial<ControlStoreAuthorizationRequest>,
): ControlStoreAuthorizationRequest {
  return {
    actor: { id: 'node/node-1', kind: 'controller' },
    verb: 'update-status',
    reference: { apiVersion: 'memeloop/v1', kind: NODE_KIND, name: 'node-1', namespace: 'default' },
    ...overrides,
  };
}

describe('createNodeTrustAuthorizer', () => {
  it('allows Node creation with explicit trustClass', () => {
    const authorizer = createNodeTrustAuthorizer();
    expect(() => {
      authorizer(
        makeRequest({
          verb: 'create',
          current: undefined,
        }),
      );
    }).not.toThrow();
  });

  it('allows status update that does not change trustClass', () => {
    const authorizer = createNodeTrustAuthorizer();
    const current = makeNodeResource('trusted');
    expect(() => {
      authorizer(
        makeRequest({
          current,
          proposedStatus: { trustClass: 'trusted', conditions: [] },
        }),
      );
    }).not.toThrow();
  });

  it('rejects trustClass change by non-verifier actor', () => {
    const authorizer = createNodeTrustAuthorizer();
    const current = makeNodeResource('restricted');
    expect(() => {
      authorizer(
        makeRequest({
          actor: { id: 'node/node-1', kind: 'controller' },
          current,
          proposedStatus: { trustClass: 'trusted' },
        }),
      );
    }).toThrow('Node trust class can only be changed by verifier actors');
  });

  it('rejects trustClass change without evidence', () => {
    const authorizer = createNodeTrustAuthorizer();
    const current = makeNodeResource('restricted');
    expect(() => {
      authorizer(
        makeRequest({
          actor: { id: 'verifier/main', kind: 'verifier' },
          current,
          proposedStatus: { trustClass: 'trusted' },
        }),
      );
    }).toThrow('Node trust class change requires trustEvidence');
  });

  it('rejects trustClass change when verifiedBy does not match actor', () => {
    const authorizer = createNodeTrustAuthorizer();
    const current = makeNodeResource('restricted');
    expect(() => {
      authorizer(
        makeRequest({
          actor: { id: 'verifier/main', kind: 'verifier' },
          current,
          proposedStatus: {
            trustClass: 'trusted',
            trustEvidence: 'evidence-123',
            trustVerifiedBy: 'verifier/other',
          },
        }),
      );
    }).toThrow('must record trustVerifiedBy matching the actor id');
  });

  it('allows trustClass change by verifier with valid evidence', () => {
    const authorizer = createNodeTrustAuthorizer();
    const current = makeNodeResource('restricted');
    expect(() => {
      authorizer(
        makeRequest({
          actor: { id: 'verifier/main', kind: 'verifier' },
          current,
          proposedStatus: {
            trustClass: 'trusted',
            trustEvidence: 'evidence-123',
            trustVerifiedBy: 'verifier/main',
            trustVerifiedAt: '2026-07-18T00:00:00.000Z',
          },
        }),
      );
    }).not.toThrow();
  });

  it('rejects lease acquisition for forbidden roles by restricted node', () => {
    const authorizer = createNodeTrustAuthorizer();
    const current = makeNodeResource('restricted');
    expect(() => {
      authorizer(
        makeRequest({
          verb: 'acquire-lease',
          reference: { apiVersion: 'memeloop/v1', kind: NODE_KIND, name: 'controller/storage' },
          current,
        }),
      );
    }).toThrow('cannot acquire lease for forbidden role controller');
  });

  it('rejects lease acquisition for forbidden roles by quarantine node', () => {
    const authorizer = createNodeTrustAuthorizer();
    const current = makeNodeResource('quarantine');
    expect(() => {
      authorizer(
        makeRequest({
          verb: 'acquire-lease',
          reference: { apiVersion: 'memeloop/v1', kind: NODE_KIND, name: 'scheduler/main' },
          current,
        }),
      );
    }).toThrow('cannot acquire lease for forbidden role scheduler');
  });

  it('allows lease acquisition for non-forbidden roles by restricted node', () => {
    const authorizer = createNodeTrustAuthorizer();
    const current = makeNodeResource('restricted');
    expect(() => {
      authorizer(
        makeRequest({
          verb: 'acquire-lease',
          reference: { apiVersion: 'memeloop/v1', kind: NODE_KIND, name: 'worker/restricted' },
          current,
        }),
      );
    }).not.toThrow();
  });

  it('allows lease acquisition by trusted node for any role', () => {
    const authorizer = createNodeTrustAuthorizer();
    const current = makeNodeResource('trusted');
    expect(() => {
      authorizer(
        makeRequest({
          verb: 'acquire-lease',
          reference: { apiVersion: 'memeloop/v1', kind: NODE_KIND, name: 'controller/storage' },
          current,
        }),
      );
    }).not.toThrow();
  });

  it('ignores non-Node resources', () => {
    const authorizer = createNodeTrustAuthorizer();
    expect(() => {
      authorizer(
        makeRequest({
          reference: { apiVersion: 'memeloop/v1', kind: 'AgentRun', name: 'run-1' },
        }),
      );
    }).not.toThrow();
  });
});

describe('validateNodeSpec', () => {
  it('rejects spec with self-asserted trust labels', () => {
    expect(() => {
      validateNodeSpec({
        nodeId: 'node-1',
        faultDomain: 'zone-1',
        labels: { 'trust-class': 'trusted' },
      });
    }).toThrow('cannot self-assert trust through label');
  });

  it('allows spec without trust labels', () => {
    expect(() => {
      validateNodeSpec({
        nodeId: 'node-1',
        faultDomain: 'zone-1',
        labels: { env: 'prod' },
      });
    }).not.toThrow();
  });
});

describe('isNodeAllowedForRole', () => {
  it('allows trusted node for any role', () => {
    expect(isNodeAllowedForRole('trusted', 'controller')).toBe(true);
    expect(isNodeAllowedForRole('trusted', 'voter')).toBe(true);
    expect(isNodeAllowedForRole('trusted', 'scheduler')).toBe(true);
  });

  it('rejects restricted node for forbidden roles', () => {
    expect(isNodeAllowedForRole('restricted', 'controller')).toBe(false);
    expect(isNodeAllowedForRole('restricted', 'voter')).toBe(false);
    expect(isNodeAllowedForRole('restricted', 'scheduler')).toBe(false);
    expect(isNodeAllowedForRole('restricted', 'plugin-host')).toBe(false);
    expect(isNodeAllowedForRole('restricted', 'control-store-client')).toBe(false);
    expect(isNodeAllowedForRole('restricted', 'storage-replica')).toBe(false);
  });

  it('allows restricted node for non-forbidden roles', () => {
    expect(isNodeAllowedForRole('restricted', 'worker')).toBe(true);
    expect(isNodeAllowedForRole('restricted', 'tool-executor')).toBe(true);
  });

  it('rejects quarantine node for forbidden roles', () => {
    expect(isNodeAllowedForRole('quarantine', 'controller')).toBe(false);
    expect(isNodeAllowedForRole('quarantine', 'scheduler')).toBe(false);
  });
});
