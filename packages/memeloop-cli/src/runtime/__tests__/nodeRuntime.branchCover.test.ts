import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { SQLiteAgentStorage } from '../../storage/sqliteStorage.js';
import { createNodeRuntime } from '../nodeRuntime.js';
import { ToolRegistry } from '../toolRegistry.js';

function mkLLMProvider() {
  return {
    name: 'embed-test',
    chat: async function*() {
      yield { type: 'text-delta' as const, content: 'ok', id: '1' };
    },
  };
}

describe('createNodeRuntime branch coverage', () => {
  it('throws when neither storage nor dataDir is provided', async () => {
    await expect(createNodeRuntime({} as any)).rejects.toThrow(/provide `dataDir`/);
  });

  it('covers configureTools and includeVscodeCli=false and wikiManager provided', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memeloop-cli-branch-'));
    try {
      const storage = new SQLiteAgentStorage({ filename: ':memory:' });
      const configureTools = vi.fn((reg: ToolRegistry) => {
        reg.registerTool('e2eDummy', async () => ({ ok: true }));
      });

      const wikiManager = {
        clearWikiCache: vi.fn(),
        listAgentDefinitionsFromWiki: vi.fn().mockResolvedValue([
          {
            id: 'wiki-agent-1',
            name: 'W',
            description: '',
            systemPrompt: '',
            tools: [],
            version: '1',
          },
        ]),
      } as any;

      const peerConnectionManager = {
        getPeers: vi.fn().mockResolvedValue([]),
        sendRpcToNode: vi.fn().mockResolvedValue(undefined),
        getPeerNodeIds: vi.fn().mockReturnValue(['peer-1']),
      } as any;

      const { toolRegistry, agentDefinitions, refreshWikiAgentDefinitions } = await createNodeRuntime({
        storage,
        llmProvider: mkLLMProvider() as any,
        toolRegistry: new ToolRegistry(),
        configureTools,
        includeVscodeCli: false,
        wikiManager,
        peerConnectionManager,
        conversationCancellation: new Set<string>(),
        config: { providers: [], nodeId: 'local-node' },
      });

      expect(configureTools).toHaveBeenCalled();
      expect(toolRegistry.listTools()).toContain('e2eDummy');
      expect(typeof refreshWikiAgentDefinitions).toBe('function');
      // wikiManager refresh runs async (void ...); wait a tick so definitions are merged.
      await new Promise((r) => setTimeout(r, 20));
      expect(agentDefinitions.some((d) => d.id === 'wiki-agent-1')).toBe(true);
      expect(wikiManager.clearWikiCache).toHaveBeenCalled();
    } finally {
      try {
        fs.rmSync(dataDir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  });
});
