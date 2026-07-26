import { describe, expect, it } from 'vitest';

import { runConformanceSuite } from '../drivers/driverConformance.js';
import { DRIVER_REQUEST_API_VERSION, type DriverRequestEnvelope } from '../drivers/driverRequest.js';
import {
  createFakeNetworkManagementDriver,
  createFakeNetworkManagementState,
  createNetworkManagementConformanceSuite,
  type NetworkPreparePayload,
} from '../drivers/networkManagement.js';

const now = () => new Date('2026-07-26T12:00:00.000Z');

function createRequest<T>(
  method: string,
  payload: T,
  idempotencyKey: string,
  fencingEpoch = 1,
  resourceUid = 'network-uid-1',
): DriverRequestEnvelope<T> {
  return {
    apiVersion: DRIVER_REQUEST_API_VERSION,
    method,
    resource: {
      apiVersion: 'network.memeloop.io/v1alpha1',
      kind: 'NetworkAttachment',
      name: 'network-1',
      uid: resourceUid,
      generation: 1,
    },
    run: { uid: 'run-uid-1', attempt: 1 },
    fencingEpoch,
    requestId: `${method}:${idempotencyKey}`,
    idempotencyKey,
    deadline: '2026-07-26T12:01:00.000Z',
    actor: { id: 'controller/network', kind: 'controller' },
    session: { id: 'node-session-1', keyFingerprint: 'ed25519:key-1' },
    capabilityHandleRef: 'capability:network-1',
    trace: { traceId: 'trace-1', spanId: `${method}:${idempotencyKey}` },
    payloadSchemaDigest: `sha256:${'e'.repeat(64)}`,
    payload,
  };
}

function preparePayload(): NetworkPreparePayload {
  return {
    sandboxHandle: 'opaque-sandbox',
    networkClass: 'external-restricted',
    networkClassDigest: `sha256:${'a'.repeat(64)}`,
    requestedFeatures: ['egress'],
    minimumEnforcementLevel: 'external',
    trustClass: 'quarantine',
    policy: {
      digest: `sha256:${'b'.repeat(64)}`,
      egress: { defaultAction: 'deny' },
    },
  };
}

describe('managed Network driver', () => {
  it('passes the complete network lifecycle conformance suite', async () => {
    const state = createFakeNetworkManagementState();
    const suite = createNetworkManagementConformanceSuite({
      createRequest,
      recreate: () => createFakeNetworkManagementDriver({ state, now }),
    });
    const result = await runConformanceSuite(
      suite,
      createFakeNetworkManagementDriver({ state, now }),
    );

    expect(result).toEqual({ passed: 5, failed: 0, failures: [] });
  });

  it('rejects false enforcement and unsupported trust claims', async () => {
    const weak = createFakeNetworkManagementDriver({
      now,
      capabilities: {
        enforcementLevel: 'process',
        enforcedFeatures: ['egress'],
        supportedTrustClasses: ['trusted'],
      },
    });
    await expect(weak.prepareNetwork(createRequest(
      'network.prepare',
      preparePayload(),
      'weak-prepare',
    ))).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('rejects method confusion, expired requests, and verifier actors', async () => {
    const driver = createFakeNetworkManagementDriver({ now });
    await expect(driver.prepareNetwork({
      ...createRequest('network.check', preparePayload(), 'wrong-method'),
    })).rejects.toMatchObject({ code: 'INVALID' });
    await expect(driver.prepareNetwork({
      ...createRequest('network.prepare', preparePayload(), 'expired'),
      deadline: '2026-07-26T11:59:59.000Z',
    })).rejects.toMatchObject({ code: 'TIMEOUT' });
    await expect(driver.prepareNetwork({
      ...createRequest('network.prepare', preparePayload(), 'verifier'),
      actor: { id: 'verifier/network', kind: 'verifier' },
    })).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('rejects unknown secret-bearing prepare and nested policy fields', async () => {
    const driver = createFakeNetworkManagementDriver({ now });
    await expect(driver.prepareNetwork(createRequest(
      'network.prepare',
      { ...preparePayload(), apiKey: 'must-not-be-ignored' } as NetworkPreparePayload,
      'unknown-prepare',
    ))).rejects.toMatchObject({ code: 'INVALID' });
    await expect(driver.prepareNetwork(createRequest(
      'network.prepare',
      {
        ...preparePayload(),
        policy: {
          ...preparePayload().policy,
          proxy: { httpsProxy: 'http://proxy.test', password: 'secret' },
        },
      } as NetworkPreparePayload,
      'unknown-policy',
    ))).rejects.toMatchObject({ code: 'INVALID' });
  });
});
