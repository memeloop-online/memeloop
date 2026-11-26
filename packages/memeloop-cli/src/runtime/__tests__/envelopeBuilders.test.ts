import { describe, expect, it } from 'vitest';

import { OrchestrationError } from 'memeloop';
import { createDriverRequestBuilder, positiveLeaseEpoch, sha256DriverValue } from '../envelopeBuilders.js';

const resource = {
  apiVersion: 'runtime.memeloop.io/v1alpha1',
  kind: 'TestResource',
  metadata: { name: 'test', uid: 'uid-1', generation: 3 },
};

describe('runtime driver envelope builders', () => {
  it('projects resource identity and validates a shared fencing epoch', () => {
    const build = createDriverRequestBuilder({
      actor: { id: 'controller/test', kind: 'controller' },
      sessionId: 'session-1',
      capabilityHandleRef: 'capability:test',
      controller: 'test',
    });
    const envelope = build({
      method: 'test.prepare',
      payload: { value: 'ok' },
      resource,
      run: { uid: 'run-1', attempt: 1 },
      fencingEpoch: '4',
      idempotencyKey: 'idempotent-1',
      payloadSchema: { fields: ['value'] },
    });

    expect(envelope).toMatchObject({
      apiVersion: 'drivers.memeloop.io/v1alpha1',
      method: 'test.prepare',
      resource: {
        apiVersion: resource.apiVersion,
        kind: resource.kind,
        name: resource.metadata.name,
        uid: resource.metadata.uid,
        generation: resource.metadata.generation,
      },
      run: { uid: 'run-1', attempt: 1 },
      fencingEpoch: 4,
      session: { id: 'session-1' },
      capabilityHandleRef: 'capability:test',
      payload: { value: 'ok' },
    });
    expect(envelope.payloadSchemaDigest).toBe(
      sha256DriverValue({
        apiVersion: 'drivers.memeloop.io/test.prepare/v1alpha1',
        fields: ['value'],
      }),
    );
  });

  it.each(['', '0', '-1', 'not-a-number'])('rejects malformed epoch %j', (epoch) => {
    expect(() => positiveLeaseEpoch(epoch, 'test')).toThrow(OrchestrationError);
  });

  it('rejects missing payload schema metadata instead of inventing a contract', () => {
    const build = createDriverRequestBuilder({
      actor: { id: 'controller/test', kind: 'controller' },
    });
    expect(() =>
      build({
        method: 'test.invalid',
        payload: null,
        resource,
        idempotencyKey: 'idempotent-2',
      })
    ).toThrow(/payload schema digest is required/);
  });
});
