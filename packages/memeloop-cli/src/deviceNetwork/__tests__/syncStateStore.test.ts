import { mkdtemp, readFile, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { FileDeviceSyncStateStore } from '../syncStateStore.js';

describe('FileDeviceSyncStateStore', () => {
  it('persists a version vector atomically with private permissions', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'memeloop-sync-state-'));
    const filename = path.join(directory, 'device-sync-state.json');
    const store = new FileDeviceSyncStateStore(filename);

    expect(await store.loadVersionVector()).toEqual({});
    await store.saveVersionVector({ local: 7, remote: 3 });

    expect(await new FileDeviceSyncStateStore(filename).loadVersionVector()).toEqual({
      local: 7,
      remote: 3,
    });
    expect((await stat(filename)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(filename, 'utf8'))).toEqual({ local: 7, remote: 3 });
  });

  it('serializes concurrent writes and rejects malformed state', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'memeloop-sync-state-'));
    const filename = path.join(directory, 'device-sync-state.json');
    const store = new FileDeviceSyncStateStore(filename);

    await Promise.all([
      store.saveVersionVector({ local: 1 }),
      store.saveVersionVector({ local: 2 }),
      store.saveVersionVector({ local: 3 }),
    ]);
    expect(await store.loadVersionVector()).toEqual({ local: 3 });
    await expect(store.saveVersionVector({ local: -1 })).rejects.toThrow(
      'invalid_device_sync_state',
    );
  });
});
