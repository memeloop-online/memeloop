import { describe, expect, it } from 'vitest';

import type { FullAgentStorage } from '../../types.js';
import { SolidPodSyncAdapter, V2_EVENT_SYNC_UNSUPPORTED_CODE } from '../solidPodAdapter.js';

const unusedStorage = {} as FullAgentStorage;

describe('SolidPodSyncAdapter', () => {
  it('fails closed instead of serializing lossy message projections', async () => {
    const adapter = new SolidPodSyncAdapter({
      podRootUrl: 'https://pod.example.com/user/',
      storage: unusedStorage,
    });
    await expect(adapter.start()).rejects.toMatchObject({
      code: V2_EVENT_SYNC_UNSUPPORTED_CODE,
    });
    await expect(adapter.pushToPod()).rejects.toMatchObject({
      code: V2_EVENT_SYNC_UNSUPPORTED_CODE,
    });
    await expect(adapter.pullFromPod()).rejects.toMatchObject({
      code: V2_EVENT_SYNC_UNSUPPORTED_CODE,
    });
    await expect(adapter.mergePayloadIntoStorage({})).rejects.toMatchObject({
      code: V2_EVENT_SYNC_UNSUPPORTED_CODE,
    });
    await adapter.stop();
  });
});
