import { describe, expect, it, vi } from 'vitest';

import type { AgentOrchestrationClient, OrchestrationResource } from '../../../orchestration/index.js';
import type { IAgentStorage, IChatSyncAdapter, ILLMProvider, INetworkService, IToolRegistry } from '../../../types.js';
import { MEMELOOP_STRUCTURED_TOOL_KEY } from '../../structuredToolResult.js';
import {
  ASK_QUESTION_TOOL_ID,
  mcpClientImpl,
  ORCHESTRATION_TOOL_ID,
  orchestrationImpl,
  registerBuiltinTools,
  remoteAgentImpl,
  remoteAgentListImpl,
  spawnAgentImpl,
} from '../index.js';
import type { BuiltinToolContext } from '../types.js';

type RemoteStreamCapableContext = BuiltinToolContext & {
  subscribeRemoteStream?: (
    nodeId: string,
    conversationId: string,
    onChunk: (chunk: unknown) => void,
  ) => () => void;
};

type RemoteAgentErrorResult = { error?: string };
type RemoteAgentListResult = { nodes?: unknown[]; error?: string };

function createMinimalContext(overrides: Partial<BuiltinToolContext> = {}): BuiltinToolContext {
  const storage: IAgentStorage = {
    listConversations: vi.fn().mockResolvedValue([]),
    getMessages: vi.fn().mockResolvedValue([]),
    appendMessage: vi.fn().mockResolvedValue(undefined),
    upsertConversationMetadata: vi.fn().mockResolvedValue(undefined),
    insertMessagesIfAbsent: vi.fn().mockResolvedValue(undefined),
    getAttachment: vi.fn().mockResolvedValue(null),
    saveAttachment: vi.fn().mockResolvedValue(undefined),
    getAgentDefinition: vi.fn().mockResolvedValue(null),
    saveAgentInstance: vi.fn().mockResolvedValue(undefined),
    getConversationMeta: vi.fn().mockResolvedValue(null),
  };
  const llmProvider: ILLMProvider = {
    name: 'mock',
    chat: vi.fn().mockResolvedValue([]),
  };
  const tools: IToolRegistry = {
    registerTool: vi.fn(),
    getTool: vi.fn(),
    listTools: vi.fn().mockReturnValue([]),
  };
  const syncAdapters: IChatSyncAdapter[] = [];
  const network: INetworkService = {
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
  };
  return {
    storage,
    llmProvider,
    tools,
    syncAdapters,
    network,
    ...overrides,
  };
}

describe('builtin tools', () => {
  describe('registerBuiltinTools', () => {
    it('registers mcpClient, spawnAgent, remoteAgent, askQuestion with registry and schema', () => {
      const registry: IToolRegistry = {
        registerTool: vi.fn(),
        getTool: vi.fn(),
        listTools: vi.fn().mockReturnValue([]),
      };
      const context = createMinimalContext();
      registerBuiltinTools(registry, context);
      expect(registry.registerTool).toHaveBeenCalledWith('mcpClient', expect.any(Function));
      expect(registry.registerTool).toHaveBeenCalledWith('spawnAgent', expect.any(Function));
      expect(registry.registerTool).toHaveBeenCalledWith('remoteAgent', expect.any(Function));
      expect(registry.registerTool).toHaveBeenCalledWith(ORCHESTRATION_TOOL_ID, expect.any(Function));
      expect(registry.registerTool).toHaveBeenCalledWith(
        ASK_QUESTION_TOOL_ID,
        expect.any(Function),
      );
    });

    it('does not register node-environment tools in core builtins', () => {
      const registry: IToolRegistry = {
        registerTool: vi.fn(),
        getTool: vi.fn(),
        listTools: vi.fn().mockReturnValue([]),
      };
      const context = createMinimalContext();
      registerBuiltinTools(registry, context);
      const registerToolMock = vi.mocked(registry.registerTool);
      const allCalls = registerToolMock.mock.calls.map(([toolId]) => toolId);
      expect(allCalls).not.toContain('terminal.execute');
      expect(allCalls).not.toContain('file.read');
      expect(allCalls).not.toContain('knowledge.wikiSearch');
    });
  });

  describe('orchestrationImpl', () => {
    it('returns an explicit error when the manager is not configured', async () => {
      const result = (await orchestrationImpl({ action: 'capabilities' }, createMinimalContext())) as { error?: string };
      expect(result.error).toContain('not configured');
    });

    it('forwards only normalized declarative resource fields', async () => {
      const applied: OrchestrationResource = {
        apiVersion: 'orchestration.memeloop.dev/v1alpha1',
        kind: 'AgentWorkload',
        metadata: {
          name: 'worker',
          uid: 'uid-1',
          generation: 1,
          resourceVersion: '1',
          creationTimestamp: '2026-07-16T00:00:00.000Z',
        },
        spec: { profileId: 'memeloop:build' },
      };
      const apply = vi.fn().mockResolvedValue(applied);
      const orchestration = {
        getCapabilities: vi.fn(),
        apply,
        get: vi.fn(),
        list: vi.fn(),
        watch: vi.fn(),
        delete: vi.fn(),
      } as unknown as AgentOrchestrationClient;
      const context = createMinimalContext({ orchestration });

      const result = await orchestrationImpl({
        action: 'apply',
        resource: {
          apiVersion: 'orchestration.memeloop.dev/v1alpha1',
          kind: 'AgentWorkload',
          metadata: { name: 'worker', labels: { fleet: 'lab' }, forbiddenActor: 'spoofed' },
          spec: { profileId: 'memeloop:build' },
          status: { phase: 'Verified' },
        },
        options: { idempotencyKey: 'child-1', forbiddenGrant: 'secret' },
      }, context);

      expect(result).toBe(applied);
      expect(apply).toHaveBeenCalledWith({
        apiVersion: 'orchestration.memeloop.dev/v1alpha1',
        kind: 'AgentWorkload',
        metadata: { name: 'worker', generateName: undefined, namespace: undefined, labels: { fleet: 'lab' }, annotations: undefined },
        spec: { profileId: 'memeloop:build' },
      }, {
        idempotencyKey: 'child-1',
        fieldManager: undefined,
        force: undefined,
        dryRun: undefined,
      });
    });

    it('uses the same manager for capabilities, get, list, and delete', async () => {
      const getCapabilities = vi.fn().mockResolvedValue({ operations: ['get'], resourceKinds: [], interfaces: ['resource'] });
      const get = vi.fn().mockResolvedValue(null);
      const list = vi.fn().mockResolvedValue({ items: [], resourceVersion: '4' });
      const delete_ = vi.fn().mockResolvedValue({ accepted: true, reference: { apiVersion: 'v1', kind: 'AgentRun', uid: 'run-1' } });
      const orchestration = {
        getCapabilities,
        apply: vi.fn(),
        get,
        list,
        watch: vi.fn(),
        delete: delete_,
      } as unknown as AgentOrchestrationClient;
      const context = createMinimalContext({ orchestration });

      await orchestrationImpl({ action: 'capabilities' }, context);
      await orchestrationImpl({ action: 'get', reference: { apiVersion: 'v1', kind: 'AgentRun', uid: 'run-1' } }, context);
      await orchestrationImpl({ action: 'list', query: { apiVersion: 'v1', kind: 'AgentRun', labels: { fleet: 'lab' } } }, context);
      await orchestrationImpl({ action: 'delete', reference: { apiVersion: 'v1', kind: 'AgentRun', uid: 'run-1' } }, context);

      expect(getCapabilities).toHaveBeenCalledOnce();
      expect(get).toHaveBeenCalledWith({ apiVersion: 'v1', kind: 'AgentRun', name: undefined, namespace: undefined, uid: 'run-1' }, undefined);
      expect(list).toHaveBeenCalledWith({ apiVersion: 'v1', kind: 'AgentRun', namespace: undefined, labels: { fleet: 'lab' } }, undefined);
      expect(delete_).toHaveBeenCalledWith({ apiVersion: 'v1', kind: 'AgentRun', name: undefined, namespace: undefined, uid: 'run-1' }, undefined);
    });
  });

  describe('mcpClientImpl', () => {
    it('returns error when mcpCallRemote not configured', async () => {
      const context = createMinimalContext();
      const result = (await mcpClientImpl(
        { nodeId: 'n1', serverName: 's1', toolName: 't1' },
        context,
      )) as { error?: string };
      expect(result.error).toContain('MCP proxy not configured');
    });

    it('returns error when required args missing', async () => {
      const context = createMinimalContext();
      const result = (await mcpClientImpl({}, context)) as { error?: string };
      expect(result.error).toContain('nodeId');
    });
  });

  describe('spawnAgentImpl', () => {
    it('returns error when runLocalAgent not configured', async () => {
      const context = createMinimalContext();
      const result = (await spawnAgentImpl(
        { definitionId: 'def1', message: 'hello' },
        context,
      )) as { error?: string };
      expect(result.error).toContain('Local agent runner not configured');
    });

    it('returns __memeloopToolResult with agent-run detailRef when runLocalAgent succeeds', async () => {
      async function* runLocal(): AsyncIterable<{ type: 'message'; data: string }> {
        yield { type: 'message', data: 'sub output' };
      }
      const context = createMinimalContext({
        runLocalAgent: runLocal,
        localNodeId: 'node-a',
      });
      const result = (await spawnAgentImpl(
        { definitionId: 'def1', message: 'hi' },
        context,
      )) as Record<string, unknown>;
      expect(result.summary).toBe('sub output');
      expect(typeof result.conversationId).toBe('string');
      expect(result.conversationId).toMatch(/^spawn:def1:/);
      const structured = result[MEMELOOP_STRUCTURED_TOOL_KEY] as {
        summary: string;
        detailRef: { type: string; conversationId: string; nodeId: string };
      };
      expect(structured.summary).toBe('sub output');
      expect(structured.detailRef.type).toBe('agent-run');
      expect(structured.detailRef.nodeId).toBe('node-a');
      expect(structured.detailRef.conversationId).toBe(result.conversationId);
    });

    it('handles object message chunks / no-text fallback / runner error', async () => {
      async function* runLocalObj(): AsyncIterable<{ type: 'message'; data: unknown }> {
        yield { type: 'message', data: { content: 'obj-output' } };
      }
      const okCtx = createMinimalContext({ runLocalAgent: runLocalObj });
      const ok = (await spawnAgentImpl({ definitionId: 'def1', message: 'hi' }, okCtx)) as Record<
        string,
        unknown
      >;
      expect(ok.summary).toBe('obj-output');

      async function* runLocalEmpty(): AsyncIterable<{ type: 'thinking'; data: string }> {
        yield { type: 'thinking', data: '...' };
      }
      const emptyCtx = createMinimalContext({
        runLocalAgent: runLocalEmpty as BuiltinToolContext['runLocalAgent'],
      });
      const empty = (await spawnAgentImpl(
        { definitionId: 'def1', message: 'hi' },
        emptyCtx,
      )) as Record<string, unknown>;
      expect(empty.summary).toBe('(no text output)');

      const throwingRunLocalAgent: NonNullable<BuiltinToolContext['runLocalAgent']> = () => {
        throw new Error('boom');
      };
      const badCtx = createMinimalContext({ runLocalAgent: throwingRunLocalAgent });
      const err = (await spawnAgentImpl({ definitionId: 'def1', message: 'hi' }, badCtx)) as {
        error?: string;
      };
      expect(err.error).toContain('spawnAgent failed');
    });
  });

  describe('remoteAgentImpl', () => {
    it('dispatches once and falls back to remote chat log summary when stream is unavailable', async () => {
      const sendRpc = vi
        .fn()
        .mockResolvedValueOnce({ conversationId: 'remote-conv-1' })
        .mockResolvedValueOnce(undefined)
        .mockResolvedValueOnce({
          messages: [
            { messageId: 'assistant-1', role: 'assistant', content: 'remote run complete' },
          ],
        })
        .mockResolvedValueOnce({ messages: [] })
        .mockResolvedValueOnce({ messages: [] });
      const context = createMinimalContext({ sendRpcToNode: sendRpc });
      const result = (await remoteAgentImpl(
        { nodeId: 'peer1', definitionId: 'd1', message: 'm1' },
        context,
      )) as Record<string, unknown>;
      expect(sendRpc).toHaveBeenCalledWith('peer1', 'memeloop.agent.create', {
        definitionId: 'd1',
      });
      expect(sendRpc).toHaveBeenCalledWith('peer1', 'memeloop.agent.send', expect.any(Object));
      expect(sendRpc).toHaveBeenCalledWith('peer1', 'memeloop.chat.pullAgentRunLog', {
        conversationId: 'remote-conv-1',
        knownMessageIds: [],
      });
      expect(result.remoteNodeId).toBe('peer1');
      expect(result.remoteConversationId).toBe('remote-conv-1');
      expect(result.summary).toBe('[assistant] remote run complete');
      const structured = result[MEMELOOP_STRUCTURED_TOOL_KEY] as {
        summary: string;
        detailRef: { type: string; conversationId: string; nodeId: string };
      };
      expect(structured.detailRef.type).toBe('agent-run');
      expect(structured.detailRef.nodeId).toBe('peer1');
      expect(structured.detailRef.conversationId).toBe('remote-conv-1');
    });

    it('uses streamed output when subscribeRemoteStream is available', async () => {
      const sendRpc = vi
        .fn()
        .mockResolvedValueOnce({ conversationId: 'remote-conv-2' })
        .mockResolvedValueOnce(undefined);
      const context = createMinimalContext({
        sendRpcToNode: sendRpc,
        remoteAgentStreamTimeoutMs: 20,
      }) as RemoteStreamCapableContext;
      context.subscribeRemoteStream = (_nodeId, _conversationId, onChunk) => {
        onChunk({ content: 'streamed remote output' });
        return () => undefined;
      };

      const result = (await remoteAgentImpl(
        { nodeId: 'peer1', definitionId: 'd1', message: 'm1' },
        context,
      )) as Record<string, unknown>;

      expect(result.summary).toBe('streamed remote output');
      expect(sendRpc).toHaveBeenCalledTimes(2);
    });

    it('covers list fallback, missing conversationId and rpc failure', async () => {
      const listCtx = createMinimalContext({
        getPeers: async () => [
          {
            peerId: 'n1',
            displayName: 'N1',
            platform: 'desktop' as const,
            trustMode: 'local-pairing' as const,
            reachability: { state: 'online' as const, paths: ['lan'] },
            capabilities: { tools: [], mcpServers: [], hasWiki: false, imChannels: [], wikis: [] },
            lastSeen: 1,
          },
        ],
      });
      const list = (await remoteAgentImpl({}, listCtx)) as RemoteAgentListResult;
      expect(list.nodes).toBeDefined();

      const missingConv = createMinimalContext({
        sendRpcToNode: vi.fn().mockResolvedValueOnce({}),
      });
      const r1 = (await remoteAgentImpl(
        { nodeId: 'n1', definitionId: 'd1', message: 'm1' },
        missingConv,
      )) as RemoteAgentErrorResult;
      expect(r1.error).toContain('did not return conversationId');

      const rpcFail = createMinimalContext({
        sendRpcToNode: vi.fn().mockRejectedValue(new Error('rpc-bad')),
      });
      const r2 = (await remoteAgentImpl(
        { nodeId: 'n1', definitionId: 'd1', message: 'm1' },
        rpcFail,
      )) as RemoteAgentErrorResult;
      expect(r2.error).toContain('remoteAgent failed');
    });
  });

  describe('remoteAgentListImpl', () => {
    it('returns empty nodes when getPeers not configured', async () => {
      const context = createMinimalContext();
      const result = (await remoteAgentListImpl({}, context)) as {
        nodes: unknown[];
        error?: string;
      };
      expect(result.nodes).toEqual([]);
      expect(result.error).toBeDefined();
    });

    it('returns peer list when getPeers provided', async () => {
      const context = createMinimalContext({
        getPeers: async () => [
          {
            peerId: 'n1',
            displayName: 'Node1',
            platform: 'desktop' as const,
            trustMode: 'local-pairing' as const,
            reachability: { state: 'online' as const, paths: ['lan'] },
            capabilities: { tools: [], mcpServers: [], hasWiki: false, imChannels: [], wikis: [] },
            lastSeen: Date.now(),
          },
        ],
      });
      const result = (await remoteAgentListImpl({}, context)) as {
        nodes: { nodeId: string; name: string }[];
      };
      expect(result.nodes).toHaveLength(1);
      expect(result.nodes[0].nodeId).toBe('n1');
      expect(result.nodes[0].name).toBe('Node1');
    });

    it('fetches agent definitions from remote nodes via RPC', async () => {
      const mockDefinitions = [
        { id: 'def1', name: 'Definition 1' },
        { id: 'def2', name: 'Definition 2' },
      ];
      const sendRpc = vi.fn().mockResolvedValue({ definitions: mockDefinitions });
      const context = createMinimalContext({
        getPeers: async () => [
          {
            peerId: 'n1',
            displayName: 'Node1',
            platform: 'desktop' as const,
            trustMode: 'local-pairing' as const,
            reachability: { state: 'online' as const, paths: ['lan'] },
            capabilities: { tools: [], mcpServers: [], hasWiki: false, imChannels: [], wikis: [] },
            lastSeen: Date.now(),
          },
        ],
        sendRpcToNode: sendRpc,
      });
      const result = (await remoteAgentListImpl({}, context)) as {
        nodes: { nodeId: string; name: string; definitions?: unknown[] }[];
      };
      expect(result.nodes).toHaveLength(1);
      expect(result.nodes[0].definitions).toEqual(mockDefinitions);
      expect(sendRpc).toHaveBeenCalledWith('n1', 'memeloop.agent.getDefinitions', {});
    });

    it('handles RPC errors gracefully when fetching definitions', async () => {
      const sendRpc = vi.fn().mockRejectedValue(new Error('RPC failed'));
      const context = createMinimalContext({
        getPeers: async () => [
          {
            peerId: 'n1',
            displayName: 'Node1',
            platform: 'desktop' as const,
            trustMode: 'local-pairing' as const,
            reachability: { state: 'online' as const, paths: ['lan'] },
            capabilities: { tools: [], mcpServers: [], hasWiki: false, imChannels: [], wikis: [] },
            lastSeen: Date.now(),
          },
        ],
        sendRpcToNode: sendRpc,
      });
      const result = (await remoteAgentListImpl({}, context)) as {
        nodes: { nodeId: string; name: string; definitions?: unknown[] }[];
      };
      expect(result.nodes).toHaveLength(1);
      expect(result.nodes[0].definitions).toEqual([]);
    });
  });
});
