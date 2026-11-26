import { describe, expect, it } from 'vitest';

import { computeMissingVersionRanges, parseVersionVectorKey, versionVectorKey } from '../protocol.js';

describe('computeMissingVersionRanges', () => {
  it('computes the missing ranges independently in both directions', () => {
    const local = {
      [versionVectorKey('one', 'A')]: 5,
      [versionVectorKey('one', 'B')]: 1,
      [versionVectorKey('two', 'D')]: 2,
    };
    const remote = {
      [versionVectorKey('one', 'A')]: 2,
      [versionVectorKey('one', 'B')]: 4,
      [versionVectorKey('two', 'C')]: 3,
    };

    expect(computeMissingVersionRanges(remote, local)).toEqual([
      { conversationId: 'one', originNodeId: 'A', fromExclusive: 2, toInclusive: 5 },
      { conversationId: 'two', originNodeId: 'D', fromExclusive: 0, toInclusive: 2 },
    ]);
    expect(computeMissingVersionRanges(local, remote)).toEqual([
      { conversationId: 'one', originNodeId: 'B', fromExclusive: 1, toInclusive: 4 },
      { conversationId: 'two', originNodeId: 'C', fromExclusive: 0, toInclusive: 3 },
    ]);
  });

  it('uses an unambiguous conversation+origin composite key', () => {
    const first = versionVectorKey('a:b', 'c');
    const second = versionVectorKey('a', 'b:c');
    expect(first).not.toBe(second);
    expect(parseVersionVectorKey(first)).toEqual({ conversationId: 'a:b', originNodeId: 'c' });
    expect(parseVersionVectorKey(second)).toEqual({ conversationId: 'a', originNodeId: 'b:c' });
    expect(parseVersionVectorKey('legacy-node-only-key')).toBeUndefined();
  });
});
