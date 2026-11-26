import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import type { IToolRegistry } from 'memeloop';

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
      const configureTools = vi.fn((reg: IToolRegistry) => {
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

      const getPeers = vi.fn().mockResolvedValue([]);
      const sendRpcToNode = vi.fn().mockResolvedValue(undefined);

      const { toolRegistry, agentDefinitions, refreshWikiAgentDefinitions } = await createNodeRuntime({
        storage,
        llmProvider: mkLLMProvider() as any,
        toolRegistry: new ToolRegistry(),
        configureTools,
        includeVscodeCli: false,
        wikiManager,
        builtinToolContext: { getPeers, sendRpcToNode },
        conversationCancellation: new Set<string>(),
        localNodeId: 'local-node',
        config: { providers: [] },
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

  it('persists loop checkpoints in dataDir/control.db across runtime restart', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memeloop-cli-control-'));
    try {
      const first = await createNodeRuntime({
        dataDir,
        llmProvider: mkLLMProvider() as any,
        includeVscodeCli: false,
        localNodeId: 'checkpoint-node',
        config: { providers: [] },
      });
      await first.context.loopCheckpoints?.saveCheckpoint('conversation-1', 'quality-gate:1:attempt', { text: 'draft-v1' });
      expect(fs.existsSync(path.join(dataDir, 'control.db'))).toBe(true);
      await first.stop();
      await expect(first.controlStore?.getHealth()).rejects.toThrow(/closed/);

      const second = await createNodeRuntime({
        dataDir,
        llmProvider: mkLLMProvider() as any,
        includeVscodeCli: false,
        localNodeId: 'checkpoint-node',
        config: { providers: [] },
      });
      await expect(second.context.loopCheckpoints?.loadCheckpoint('conversation-1', 'quality-gate:1:attempt'))
        .resolves.toEqual({ text: 'draft-v1' });
      await second.stop();
      await expect(second.controlStore?.getHealth()).rejects.toThrow(/closed/);
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('removes only runtime-owned registrations from a reused host tool registry', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'memeloop-cli-registry-owner-'));
    const toolRegistry = new ToolRegistry();
    const hostTool = async () => 'host';
    const hostPrompt = () => undefined;
    toolRegistry.registerTool('host.tool', hostTool);
    toolRegistry.getPromptPlugins().set('host.prompt', hostPrompt);
    const start = () =>
      createNodeRuntime({
        dataDir,
        toolRegistry,
        llmProvider: mkLLMProvider() as any,
        includeVscodeCli: false,
        localNodeId: 'registry-owner-node',
        config: { providers: [] },
      });
    let runtime = await start();
    try {
      expect(toolRegistry.getTool('host.tool')).toBe(hostTool);
      expect(toolRegistry.getTool('file.read')).toBeDefined();
      expect(toolRegistry.getTool('task')).toBeDefined();
      await runtime.stop();
      expect(toolRegistry.listTools()).toEqual(['host.tool']);
      expect(toolRegistry.getPromptPlugins()).toEqual(new Map([['host.prompt', hostPrompt]]));
      expect(runtime.context.loopRegistry?.listLoops()).toEqual([]);
      expect(runtime.context.hooks?.hasHooks('PreToolUse')).toBe(false);
      expect(runtime.context.agentProfiles?.getAgentProfile('memeloop:build')).toBeDefined();

      runtime = await start();
      expect(toolRegistry.getTool('file.read')).toBeDefined();
      expect(toolRegistry.getTool('task')).toBeDefined();
    } finally {
      await runtime.stop();
      expect(toolRegistry.listTools()).toEqual(['host.tool']);
      expect(toolRegistry.getPromptPlugins()).toEqual(new Map([['host.prompt', hostPrompt]]));
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  }, 30_000);

  it('owns non-tool file-plugin capabilities across stop and restart', async () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'memeloop-cli-plugin-'));
    const dataDir = path.join(projectRoot, 'data');
    const pluginDir = path.join(projectRoot, '.memeloop', 'plugins', 'non-tool');
    fs.mkdirSync(pluginDir, { recursive: true });
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(
      path.join(pluginDir, 'memeloop-plugin.json'),
      JSON.stringify({
        name: 'node-non-tool-plugin',
        version: '1.0.0',
        entry: 'index.mjs',
        exports: {
          agentProfiles: ['node-plugin:agent'],
          loopDefinitions: ['node-plugin:loop'],
          loopProfiles: ['node-plugin:profile'],
          loopPlugins: ['node-plugin:loop-plugin'],
          modelProviders: ['node-plugin-provider'],
        },
      }),
    );
    fs.writeFileSync(
      path.join(pluginDir, 'index.mjs'),
      `
export default {
  name: 'node-non-tool-plugin',
  activate(api) {
    api.registerAgentProfile({
      id: 'node-plugin:agent',
      name: 'Node plugin agent',
      type: 'plugin-role',
      prompt: 'Plugin prompt',
      permissions: { default: 'deny', rules: [] },
      protocolDef: {
        id: 'node-plugin:agent',
        name: 'Node plugin agent',
        description: 'Node plugin agent',
        systemPrompt: 'Plugin prompt',
        tools: [],
        version: '1.0.0'
      }
    });
    api.registerLoopDefinition({
      id: 'node-plugin:loop',
      name: 'Node plugin loop',
      description: 'Node plugin loop',
      createRunner: () => async function* () {}
    });
    api.registerLoopProfile({
      id: 'node-plugin:profile',
      name: 'Node plugin profile',
      description: 'Node plugin profile',
      loopId: 'node-plugin:loop'
    });
    api.registerLoopPlugin({
      id: 'node-plugin:loop-plugin',
      targetLoopId: 'node-plugin:loop'
    });
    api.registerModelProvider({
      name: 'node-plugin-provider',
      chat: async () => 'ok'
    }, {
      models: [{
        modelId: 'node-plugin-model',
        wireModelId: 'node-plugin-model',
        apiMode: 'chat-completions'
      }]
    });
  }
};
`,
    );

    const start = () =>
      createNodeRuntime({
        dataDir,
        llmProvider: mkLLMProvider() as any,
        includeVscodeCli: false,
        localNodeId: 'plugin-node',
        config: { providers: [] },
        plugins: {
          enabled: true,
          projectRoot,
          allowedPluginPaths: [pluginDir],
        },
      });
    let runtime = await start();
    try {
      const assertInstalled = () => {
        expect(runtime.loadedPlugins.map(plugin => plugin.manifest.name))
          .toEqual(['node-non-tool-plugin']);
        expect(runtime.context.agentProfiles?.getAgentProfile('node-plugin:agent')).toBeDefined();
        expect(runtime.context.loopRegistry?.getLoop('node-plugin:loop')).toBeDefined();
        expect(runtime.context.loopRegistry?.getProfile('node-plugin:profile')).toBeDefined();
        expect(runtime.context.loopRegistry?.getPlugin('node-plugin:loop-plugin')).toBeDefined();
        expect(runtime.providerRegistry.get('node-plugin-provider')).toBeDefined();
      };
      assertInstalled();
      const firstContext = runtime.context;
      const firstProviders = runtime.providerRegistry;
      await runtime.stop();
      expect(firstContext.agentProfiles?.getAgentProfile('node-plugin:agent')).toBeUndefined();
      expect(firstContext.loopRegistry?.getLoop('node-plugin:loop')).toBeUndefined();
      expect(firstContext.loopRegistry?.getProfile('node-plugin:profile')).toBeUndefined();
      expect(firstContext.loopRegistry?.getPlugin('node-plugin:loop-plugin')).toBeUndefined();
      expect(firstProviders.get('node-plugin-provider')).toBeUndefined();

      runtime = await start();
      assertInstalled();
    } finally {
      await runtime.stop();
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  }, 30_000);
});
