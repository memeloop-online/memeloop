import { describe, expect, it } from 'vitest';

import { createControlStoreConformanceSuite } from '../drivers/controlStoreConformance.js';
import { runConformanceSuite } from '../drivers/driverConformance.js';
import { QuorumControlStore } from '../stores/quorumControlStore.js';

describe('ControlStore shared conformance', () => {
  it('passes unchanged against the Quorum reference backend', async () => {
    const suite = createControlStoreConformanceSuite({
      actor: { id: 'controller/conformance', kind: 'controller' },
      prefix: 'quorum',
      create: () => new QuorumControlStore({ memberId: 'n1', voters: ['n1'] }),
      snapshotTarget: (testName) => `memory://${testName}`,
    });
    const result = await runConformanceSuite(suite, undefined);

    expect(result).toEqual({ passed: 5, failed: 0, failures: [] });
  });
});
