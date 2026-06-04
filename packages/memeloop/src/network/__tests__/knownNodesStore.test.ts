import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { loadKnownNodes, removeKnownNode, saveKnownNodes, trustMatchesStored, upsertKnownNode } from '../knownNodesStore.js';

describe('knownNodesStore', () => {
  let tmp: string;

  afterEach(() => {
    if (tmp && fs.existsSync(tmp)) fs.unlinkSync(tmp);
  });

  it('upsert and load round-trip', () => {
    tmp = path.join(os.tmpdir(), `known_nodes_${Date.now()}.json`);
    const entry = {
      nodeId: 'n1',
      staticPublicKey: 'pk1',
      name: 'a',
      firstSeen: 1,
      lastConnected: 2,
      trustSource: 'pin-pairing' as const,
    };
    upsertKnownNode(entry, tmp);
    const loaded = loadKnownNodes(tmp);
    expect(loaded).toHaveLength(1);
    expect(loaded[0]?.nodeId).toBe('n1');
    expect(loaded[0]?.staticPublicKey).toBe('pk1');
  });

  it('removeKnownNode', () => {
    tmp = path.join(os.tmpdir(), `known_nodes_${Date.now()}_b.json`);
    saveKnownNodes(
      [
        {
          nodeId: 'a',
          staticPublicKey: 'p',
          firstSeen: 0,
          lastConnected: 0,
          trustSource: 'cloud-registry',
        },
      ],
      tmp,
    );
    removeKnownNode('a', tmp);
    expect(loadKnownNodes(tmp)).toHaveLength(0);
  });

  it('trustMatchesStored detects pubkey mismatch', () => {
    tmp = path.join(os.tmpdir(), `known_nodes_${Date.now()}_c.json`);
    upsertKnownNode(
      {
        nodeId: 'n',
        staticPublicKey: 'old',
        firstSeen: 1,
        lastConnected: 2,
        trustSource: 'pin-pairing',
      },
      tmp,
    );
    expect(trustMatchesStored('n', 'old', tmp)).toBe(true);
    expect(trustMatchesStored('n', 'new', tmp)).toBe(false);
  });
});
