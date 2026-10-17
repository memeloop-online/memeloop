import { describe, expect, it } from 'vitest';

import { assertControlStoreApplyPreconditions, decideControlStoreApplyOwnership, validateControlStoreApplyOptions } from '../controlStoreApply.js';

const actorResource = {
  apiVersion: 'v1',
  kind: 'Test',
  metadata: {
    name: 'owned',
    uid: 'uid-1',
    generation: 1,
    resourceVersion: '3',
    creationTimestamp: '2026-01-01T00:00:00.000Z',
  },
  spec: { replicas: 1, image: 'one' },
};

describe('control store apply decision helpers', () => {
  it('validates effective resourceVersion and all identity predicates', () => {
    expect(validateControlStoreApplyOptions({ preconditions: { resourceVersion: '3' } })).toBe('3');
    expect(() => {
      assertControlStoreApplyPreconditions(
        actorResource,
        { preconditions: { uid: 'wrong' } },
        undefined,
      );
    }).toThrowError(/uid precondition/);
    expect(() => validateControlStoreApplyOptions({ force: true })).toThrowError(/fieldManager/);
  });

  it('detects overlapping ownership conflicts and force transfers claims', () => {
    const proposed = { ...actorResource, spec: { replicas: 2, image: 'one' } };
    const owners = [{ fieldPath: 'spec.replicas', manager: 'manager-a' }];
    expect(() =>
      decideControlStoreApplyOwnership(
        actorResource,
        proposed,
        { fieldManager: 'manager-b' },
        owners,
      )
    ).toThrowError(/manager-a/);
    expect(decideControlStoreApplyOwnership(
      actorResource,
      proposed,
      { fieldManager: 'manager-b', force: true },
      owners,
    )).toEqual([{ fieldPath: 'spec.replicas', manager: 'manager-b' }, { fieldPath: 'spec.image', manager: 'manager-b' }]);
  });
});
