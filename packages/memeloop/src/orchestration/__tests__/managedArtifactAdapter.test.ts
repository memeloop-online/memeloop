import { describe, expect, it, vi } from 'vitest';

import { type ArtifactInspector, type ArtifactManagementStateSnapshot, createFakeArtifactManagementState, restoreArtifactManagementState } from '../drivers/artifactManagement.js';
import { DRIVER_REQUEST_API_VERSION, type DriverRequestEnvelope } from '../drivers/driverRequest.js';
import { createManagedArtifactDriverAdapter } from '../drivers/managedArtifactAdapter.js';

const now = () => new Date('2026-07-27T02:00:00.000Z');

function request<T>(
  method: string,
  payload: T,
  idempotencyKey: string,
  resourceUid = 'artifact-production-1',
): DriverRequestEnvelope<T> {
  return {
    apiVersion: DRIVER_REQUEST_API_VERSION,
    method,
    resource: {
      apiVersion: 'artifacts.memeloop.io/v1alpha1',
      kind: 'ArtifactRecord',
      name: resourceUid,
      uid: resourceUid,
      generation: 1,
    },
    fencingEpoch: 1,
    requestId: `${method}:${idempotencyKey}`,
    idempotencyKey,
    deadline: '2026-07-27T02:01:00.000Z',
    actor: { id: 'controller/artifact', kind: 'controller' },
    session: { id: 'artifact-session-1' },
    capabilityHandleRef: 'capability:artifact-production',
    trace: { traceId: 'trace-1', spanId: idempotencyKey },
    payloadSchemaDigest: `sha256:${'a'.repeat(64)}`,
    payload,
  };
}

function content(value: string): AsyncIterable<Uint8Array> {
  return {
    async *[Symbol.asyncIterator]() {
      yield new TextEncoder().encode(value);
    },
  };
}

const inspector: ArtifactInspector = {
  scan: vi.fn(async () => []),
  sanitize: vi.fn(async (input) => ({
    bytes: input.bytes,
    mimeType: 'text/plain',
    properties: ['render-as:plain-text'],
  })),
  verify: vi.fn(async () => true),
};

describe('managed production Artifact adapter', () => {
  it('uses an isolated inspector, commits durable state, and restores verified bytes', async () => {
    let snapshot: ArtifactManagementStateSnapshot | undefined;
    const driver = createManagedArtifactDriverAdapter({
      state: createFakeArtifactManagementState(),
      inspector,
      name: 'host-artifacts',
      inspectionIsolation: 'process',
      persistence: 'host',
      now,
      authorizeRequest: (input) => input.capabilityHandleRef === 'capability:artifact-production',
      persistState: async (value) => {
        snapshot = structuredClone(value);
      },
      threatAssumptions: [
        'the host state file and isolated inspector process are trusted',
      ],
    });
    const artifact = await driver.put(
      request(
        'artifact.put',
        {
          mimeType: 'text/plain',
          trust: 'restricted' as const,
          maxBytes: 1024,
        },
        'put',
      ),
      content('safe value'),
    );
    await expect(driver.scan(request(
      'artifact.scan',
      {
        artifactHandle: artifact.artifactHandle,
        policyDigest: `sha256:${'b'.repeat(64)}`,
        destinations: ['prompt' as const],
      },
      'scan',
    ))).resolves.toMatchObject({ outcome: 'passed' });
    expect(inspector.scan).toHaveBeenCalledOnce();
    expect(snapshot).toBeDefined();

    const restored = await restoreArtifactManagementState(snapshot!);
    const recreated = createManagedArtifactDriverAdapter({
      state: restored,
      inspector,
      name: 'host-artifacts',
      inspectionIsolation: 'process',
      persistence: 'host',
      now,
      authorizeRequest: () => true,
      persistState: async () => {},
      threatAssumptions: ['the restored host state is trusted'],
    });
    const chunks: Uint8Array[] = [];
    for await (
      const chunk of recreated.read(request(
        'artifact.read',
        { artifactHandle: artifact.artifactHandle },
        'read',
      ))
    ) chunks.push(chunk);
    expect(new TextDecoder().decode(chunks[0])).toBe('safe value');
    await expect(recreated.getCapabilities()).resolves.toMatchObject({
      inspectionIsolation: 'process',
      persistence: 'host',
    });
  });

  it('rejects capabilities and unknown payload fields before touching state', async () => {
    const persistState = vi.fn(async () => {});
    const driver = createManagedArtifactDriverAdapter({
      state: createFakeArtifactManagementState(),
      inspector,
      name: 'host-artifacts',
      inspectionIsolation: 'process',
      persistence: 'host',
      now,
      authorizeRequest: (input) => input.capabilityHandleRef === 'capability:artifact-production',
      persistState,
      threatAssumptions: ['the host state is trusted'],
    });
    await expect(driver.resolve({
      ...request('artifact.resolve', {
        contentHash: `sha256:${'c'.repeat(64)}`,
      }, 'denied'),
      capabilityHandleRef: 'capability:wrong',
    })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(driver.resolve(request(
      'artifact.resolve',
      {
        contentHash: `sha256:${'c'.repeat(64)}`,
        rawSecret: 'must-not-cross',
      } as never,
      'extension',
    ))).rejects.toMatchObject({ code: 'INVALID' });
    expect(persistState).not.toHaveBeenCalled();
  });

  it('fails persistence uncertainty closed and releases the serialization lock', async () => {
    let failPersistence = true;
    const driver = createManagedArtifactDriverAdapter({
      state: createFakeArtifactManagementState(),
      inspector,
      name: 'host-artifacts',
      inspectionIsolation: 'process',
      persistence: 'host',
      now,
      authorizeRequest: () => true,
      persistState: async () => {
        if (failPersistence) throw new Error('disk unavailable');
      },
      threatAssumptions: ['the host state is trusted'],
    });
    const putRequest = request(
      'artifact.put',
      {
        mimeType: 'text/plain',
        trust: 'restricted' as const,
        maxBytes: 1024,
      },
      'uncertain-put',
    );
    await expect(driver.put(putRequest, content('committed in memory')))
      .rejects.toMatchObject({ code: 'UNKNOWN_EFFECT' });

    failPersistence = false;
    await expect(driver.resolve(request(
      'artifact.resolve',
      {
        contentHash: 'sha256:1bd3678d8c96683d6553545e7201b3e0f62fd3114d655bd480a4740543c396f0',
      },
      'resolve-after-failure',
    ))).resolves.toMatchObject({
      contentHash: 'sha256:1bd3678d8c96683d6553545e7201b3e0f62fd3114d655bd480a4740543c396f0',
    });
  });
});
