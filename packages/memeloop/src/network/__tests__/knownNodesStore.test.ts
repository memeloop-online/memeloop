import { describe, expect, it } from 'vitest';

import type { KnownNodeEntry } from '../../protocol/index.js';
import { InMemoryKnownNodesRepository, KnownNodesService, parseKnownNodesFile, serializeKnownNodesFile } from '../knownNodesStore.js';

describe('KnownNodesService', () => {
  it('upserts and loads entries', async () => {
    const service = new KnownNodesService(new InMemoryKnownNodesRepository());
    const entry = {
      nodeId: 'n1',
      staticPublicKey: 'pk1',
      name: 'a',
      firstSeen: 1,
      lastConnected: 2,
      trustSource: 'pin-pairing' as const,
    };
    await service.upsertKnownNode(entry);
    const loaded = await service.listKnownNodes();
    expect(loaded).toHaveLength(1);
    expect(loaded[0]?.nodeId).toBe('n1');
    expect(loaded[0]?.staticPublicKey).toBe('pk1');
  });

  it('removes entries', async () => {
    const service = new KnownNodesService(
      new InMemoryKnownNodesRepository([
        {
          nodeId: 'a',
          staticPublicKey: 'p',
          firstSeen: 0,
          lastConnected: 0,
          trustSource: 'cloud-registry',
        },
      ]),
    );
    await service.removeKnownNode('a');
    expect(await service.listKnownNodes()).toHaveLength(0);
  });

  it('detects public key mismatches', async () => {
    const service = new KnownNodesService(
      new InMemoryKnownNodesRepository([
        {
          nodeId: 'n',
          staticPublicKey: 'old',
          firstSeen: 1,
          lastConnected: 2,
          trustSource: 'pin-pairing',
        },
      ]),
    );
    expect(await service.trustMatchesStored('n', 'old')).toBe(true);
    expect(await service.trustMatchesStored('n', 'new')).toBe(false);
    expect(await service.trustMatchesStored('unknown', 'new')).toBe(true);
  });

  it('treats repository load failures as an empty trust store', async () => {
    const service = new KnownNodesService({
      async load() {
        throw new Error('failed to load');
      },
      async save() {},
    });
    expect(await service.listKnownNodes()).toEqual([]);
    expect(await service.trustMatchesStored('n', 'new')).toBe(true);
  });
});

describe('known nodes file format', () => {
  const entry: KnownNodeEntry = {
    nodeId: 'n',
    staticPublicKey: 'pk',
    firstSeen: 1,
    lastConnected: 2,
    trustSource: 'pin-pairing',
  };

  it('parses current and legacy array payloads', () => {
    expect(parseKnownNodesFile(JSON.stringify({ version: 1, entries: [entry] }))).toEqual([entry]);
    expect(parseKnownNodesFile(JSON.stringify([entry]))).toEqual([entry]);
  });

  it('filters invalid entries and tolerates damaged data', () => {
    expect(parseKnownNodesFile('{broken')).toEqual([]);
    expect(
      parseKnownNodesFile(
        JSON.stringify({
          version: 1,
          entries: [
            entry,
            {
              nodeId: 'bad',
              staticPublicKey: 'pk',
              firstSeen: 1,
              lastConnected: 2,
              trustSource: 'manual',
            },
          ],
        }),
      ),
    ).toEqual([entry]);
  });

  it('serializes versioned payloads', () => {
    expect(parseKnownNodesFile(serializeKnownNodesFile([entry]))).toEqual([entry]);
  });
});
