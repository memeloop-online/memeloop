import { describe, expect, it } from 'vitest';

import { computeMissingVersionRanges } from '../protocol.js';

describe('computeMissingVersionRanges', () => {
  it('computes the missing ranges independently in both directions', () => {
    const local = { A: 5, B: 1, D: 2 };
    const remote = { A: 2, B: 4, C: 3 };

    expect(computeMissingVersionRanges(remote, local)).toEqual([
      { originNodeId: 'A', fromExclusive: 2, toInclusive: 5 },
      { originNodeId: 'D', fromExclusive: 0, toInclusive: 2 },
    ]);
    expect(computeMissingVersionRanges(local, remote)).toEqual([
      { originNodeId: 'B', fromExclusive: 1, toInclusive: 4 },
      { originNodeId: 'C', fromExclusive: 0, toInclusive: 3 },
    ]);
  });
});
