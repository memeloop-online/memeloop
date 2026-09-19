import { describe, expect, it, vi } from 'vitest';

import { createTestStorage } from '../../../__tests__/testStorage.js';
import { LoopRegistryImpl } from '../../../loopAPI/registry.js';
import { OrchestrationError } from '../../../orchestration/index.js';
import type { AgentOrchestrationClient, OrchestrationResource, OrchestrationResourceManifest } from '../../../orchestration/index.js';
import type { IChatSyncAdapter, ILLMProvider, INetworkService, IToolRegistry } from '../../../types.js';
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
type RemoteAgentListResult = { targets?: unknown[]; error?: string };

function createMinimalContext(overrides: Partial<BuiltinToolContext> = {}): BuiltinToolContext {
  const storage = createTestStorage();
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
    localNodeId: 'test-node-builtins',
    loopRegistry: new LoopRegistryImpl(),
    promptPlugins: new Map(),
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
      expect(registry.registerTool).toHaveBeenCalledWith(
        'mcpClient',
        expect.any(Function),
        expect.anything(),
        undefined,
      );
      expect(registry.registerTool).toHaveBeenCalledWith(
        'spawnAgent',
        expect.any(Function),
        expect.anything(),
        undefined,
      );
      expect(registry.registerTool).toHaveBeenCalledWith(
        'remoteAgent',
        expect.any(Function),
        expect.anything(),
        undefined,
      );
      expect(registry.registerTool).toHaveBeenCalledWith(
        ORCHESTRATION_TOOL_ID,
        expect.any(Function),
        expect.anything(),
        undefined,
      );
      expect(registry.registerTool).toHaveBeenCalledWith(
        ASK_QUESTION_TOOL_ID,
        expect.any(Function),
        expect.anything(),
        undefined,
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
      const result = (await orchestrationImpl({ action: 'capabilities' }, createMinimalContext())) as {
        error?: { code: string; message: string; retryable: boolean };
      };
      expect(result.error).toEqual({
        code: 'UNSUPPORTED',
        message: 'Orchestration manager not configured.',
        retryable: false,
      });
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
        preconditions: undefined,
      });
    });

    it('returns structured validation and manager errors', async () => {
      const orchestration = {
        getCapabilities: vi.fn(),
        apply: vi.fn().mockRejectedValue(
          new OrchestrationError({
            code: 'FORBIDDEN',
            message: 'resource kind is not allowed',
            retryable: false,
            reason: 'SecurityProfileDenied',
          }),
        ),
        get: vi.fn(),
        list: vi.fn(),
        watch: vi.fn(),
        delete: vi.fn(),
      } as unknown as AgentOrchestrationClient;
      const context = createMinimalContext({ orchestration });

      const invalid = (await orchestrationImpl({ action: 'get', reference: {} }, context)) as Record<string, unknown>;
      const forbidden = (await orchestrationImpl({
        action: 'apply',
        resource: { apiVersion: 'v1', kind: 'Secret', metadata: { name: 'blocked' }, spec: {} },
      }, context)) as Record<string, unknown>;

      expect(invalid.error).toEqual({
        code: 'INVALID',
        message: 'reference requires apiVersion, kind, and name or uid',
        retryable: false,
        retryAfterMs: undefined,
        reason: undefined,
        details: undefined,
      });
      expect(forbidden.error).toEqual({
        code: 'FORBIDDEN',
        message: 'resource kind is not allowed',
        retryable: false,
        retryAfterMs: undefined,
        reason: 'SecurityProfileDenied',
        details: undefined,
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

    it('waits for a condition and returns the matched resource version', async () => {
      const resource: OrchestrationResource = {
        apiVersion: 'orchestration.memeloop.dev/v1alpha1',
        kind: 'AgentWorkload',
        metadata: {
          name: 'worker',
          uid: 'uid-1',
          generation: 1,
          resourceVersion: '7',
          creationTimestamp: '2026-07-16T00:00:00.000Z',
        },
        spec: {},
        status: {
          conditions: [{ type: 'Ready', status: 'True', reason: 'Ready', lastTransitionTime: '2026-07-16T00:00:00.000Z' }],
        },
      };
      const get = vi.fn().mockResolvedValue(resource);
      const orchestration = {
        getCapabilities: vi.fn(),
        apply: vi.fn(),
        get,
        list: vi.fn(),
        watch: vi.fn(),
        delete: vi.fn(),
      } as unknown as AgentOrchestrationClient;
      const context = createMinimalContext({ orchestration });

      const result = await orchestrationImpl({
        action: 'wait',
        reference: { apiVersion: 'orchestration.memeloop.dev/v1alpha1', kind: 'AgentWorkload', name: 'worker' },
        condition: { type: 'Ready', status: 'True' },
        options: { timeout: 1000, interval: 50 },
      }, context);

      expect(result).toEqual({ observedResourceVersion: '7', matched: true });
      expect(get).toHaveBeenCalledOnce();
    });

    it('times out when a condition is not met', async () => {
      const resource: OrchestrationResource = {
        apiVersion: 'orchestration.memeloop.dev/v1alpha1',
        kind: 'AgentWorkload',
        metadata: {
          name: 'worker',
          uid: 'uid-1',
          generation: 1,
          resourceVersion: '7',
          creationTimestamp: '2026-07-16T00:00:00.000Z',
        },
        spec: {},
        status: {
          conditions: [{ type: 'Ready', status: 'False', reason: 'Starting', lastTransitionTime: '2026-07-16T00:00:00.000Z' }],
        },
      };
      const get = vi.fn().mockResolvedValue(resource);
      const orchestration = {
        getCapabilities: vi.fn(),
        apply: vi.fn(),
        get,
        list: vi.fn(),
        watch: vi.fn(),
        delete: vi.fn(),
      } as unknown as AgentOrchestrationClient;
      const context = createMinimalContext({ orchestration });

      const result = (await orchestrationImpl({
        action: 'wait',
        reference: { apiVersion: 'orchestration.memeloop.dev/v1alpha1', kind: 'AgentWorkload', name: 'worker' },
        condition: { type: 'Ready', status: 'True' },
        options: { timeout: 80, interval: 20 },
      }, context)) as { error: { code: string; retryable: boolean } };

      expect(result.error.code).toBe('TIMEOUT');
      expect(result.error.retryable).toBe(true);
    });

    it('cancels an in-flight wait from the active ToolLoop conversation', async () => {
      vi.useFakeTimers();
      try {
        const resource: OrchestrationResource = {
          apiVersion: 'orchestration.memeloop.dev/v1alpha1',
          kind: 'AgentWorkload',
          metadata: {
            name: 'worker',
            uid: 'uid-1',
            generation: 1,
            resourceVersion: '7',
            creationTimestamp: '2026-07-16T00:00:00.000Z',
          },
          spec: {},
          status: {
            conditions: [{ type: 'Ready', status: 'False', reason: 'Starting', lastTransitionTime: '2026-07-16T00:00:00.000Z' }],
          },
        };
        const get = vi.fn().mockResolvedValue(resource);
        const orchestration = {
          getCapabilities: vi.fn(),
          apply: vi.fn(),
          get,
          list: vi.fn(),
          watch: vi.fn(),
          delete: vi.fn(),
        } as unknown as AgentOrchestrationClient;
        const conversationCancellation = new Set<string>();
        const context = createMinimalContext({
          orchestration,
          activeToolConversationId: 'conversation-1',
          conversationCancellation,
        });

        const pending = orchestrationImpl({
          action: 'wait',
          reference: { apiVersion: 'orchestration.memeloop.dev/v1alpha1', kind: 'AgentWorkload', name: 'worker' },
          condition: { type: 'Ready', status: 'True' },
          options: { timeout: 1000, interval: 100 },
        }, context);
        await vi.advanceTimersByTimeAsync(0);
        expect(get).toHaveBeenCalledOnce();

        conversationCancellation.add('conversation-1');
        await vi.advanceTimersByTimeAsync(50);

        await expect(pending).resolves.toEqual({
          error: expect.objectContaining({
            code: 'CANCELLED',
            retryable: false,
            details: { lastResourceVersion: '7' },
          }),
        });
        expect(get).toHaveBeenCalledOnce();
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    });

    it('validates condition fields for wait', async () => {
      const orchestration = {
        getCapabilities: vi.fn(),
        apply: vi.fn(),
        get: vi.fn(),
        list: vi.fn(),
        watch: vi.fn(),
        delete: vi.fn(),
      } as unknown as AgentOrchestrationClient;
      const context = createMinimalContext({ orchestration });

      const result = (await orchestrationImpl({
        action: 'wait',
        reference: { apiVersion: 'v1', kind: 'AgentWorkload', name: 'worker' },
        condition: {},
      }, context)) as { error: { code: string } };

      expect(result.error.code).toBe('INVALID');
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

    it('passes the turn signal to the remote MCP call and preserves cancellation', async () => {
      const controller = new AbortController();
      const mcpCallRemote = vi.fn((
        _nodeId: string,
        _serverName: string,
        _toolName: string,
        _arguments: Record<string, unknown>,
        options: { signal?: AbortSignal },
      ) =>
        new Promise<never>((_resolve, reject) => {
          options.signal?.addEventListener('abort', () => {
            const reason = options.signal?.reason;
            reject(reason instanceof Error ? reason : new Error(String(reason ?? 'aborted')));
          }, { once: true });
        })
      );
      const context = createMinimalContext({
        operationSignal: controller.signal,
        mcpCallRemote,
      });
      const pending = mcpClientImpl(
        { nodeId: 'n1', serverName: 's1', toolName: 't1', arguments: {} },
        context,
      );

      controller.abort(new Error('mcp-turn-cancelled'));

      await expect(pending).rejects.toThrow('mcp-turn-cancelled');
      expect(mcpCallRemote.mock.calls[0]?.[4]).toEqual({ signal: controller.signal });
    });
  });

  describe('spawnAgentImpl', () => {
    it('uses orchestration facade when configured for AgentWorkload', async () => {
      const getCapabilities = vi.fn().mockResolvedValue({
        operations: ['apply', 'get', 'delete'],
        resourceKinds: ['AgentWorkload', 'AgentRun'],
        interfaces: ['resource'],
      });
      const apply = vi.fn().mockImplementation(async (resource: OrchestrationResourceManifest) => {
        const baseMeta = { uid: 'uid-1', generation: 1, resourceVersion: '1', creationTimestamp: '2026-07-16T00:00:00.000Z' };
        if (resource.kind === 'AgentWorkload') {
          return {
            apiVersion: 'workload.memeloop.io/v1alpha1',
            kind: 'AgentWorkload',
            metadata: { ...baseMeta, name: resource.metadata.name },
            spec: resource.spec,
          };
        }
        return {
          apiVersion: 'run.memeloop.io/v1alpha1',
          kind: 'AgentRun',
          metadata: { ...baseMeta, name: resource.metadata.name },
          spec: resource.spec,
        };
      });
      const get = vi.fn().mockResolvedValue({
        apiVersion: 'run.memeloop.io/v1alpha1',
        kind: 'AgentRun',
        metadata: { name: 'spawn:def1:abc-run', uid: 'uid-2', generation: 1, resourceVersion: '2', creationTimestamp: '2026-07-16T00:00:00.000Z' },
        spec: {},
        status: {
          phase: 'Completed',
          summary: 'orchestrated output',
          conditions: [{ type: 'Completed', status: 'True', reason: 'Done', lastTransitionTime: '2026-07-16T00:00:00.000Z' }],
        },
      });
      const orchestration = {
        getCapabilities,
        apply,
        get,
        list: vi.fn(),
        watch: vi.fn(),
        delete: vi.fn(),
      } as unknown as AgentOrchestrationClient;
      const context = createMinimalContext({ orchestration, localNodeId: 'node-a' });

      const result = (await spawnAgentImpl({ definitionId: 'def1', message: 'hi' }, context)) as Record<string, unknown>;

      expect(result.summary).toBe('orchestrated output');
      expect(result.conversationId).toMatch(/^spawn:def1:/);
      const structured = result[MEMELOOP_STRUCTURED_TOOL_KEY] as {
        summary: string;
        detailRef: { type: string; conversationId: string; nodeId: string; resourceVersion: string };
      };
      expect(structured.detailRef.type).toBe('agent-run');
      expect(structured.detailRef.nodeId).toBe('node-a');
      expect(structured.detailRef.resourceVersion).toBe('2');
      expect(getCapabilities).toHaveBeenCalledOnce();
    });

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
    it('uses orchestration facade to place a workload on a required node', async () => {
      const getCapabilities = vi.fn().mockResolvedValue({
        operations: ['apply', 'get', 'delete'],
        resourceKinds: ['AgentWorkload', 'AgentRun'],
        interfaces: ['resource'],
      });
      const apply = vi.fn().mockImplementation(async (resource: OrchestrationResourceManifest) => {
        const baseMeta = { uid: 'uid-1', generation: 1, resourceVersion: '1', creationTimestamp: '2026-07-16T00:00:00.000Z' };
        if (resource.kind === 'AgentWorkload') {
          return {
            apiVersion: 'workload.memeloop.io/v1alpha1',
            kind: 'AgentWorkload',
            metadata: { ...baseMeta, name: resource.metadata.name },
            spec: resource.spec,
          };
        }
        return {
          apiVersion: 'run.memeloop.io/v1alpha1',
          kind: 'AgentRun',
          metadata: { ...baseMeta, name: resource.metadata.name },
          spec: resource.spec,
        };
      });
      const get = vi.fn().mockResolvedValue({
        apiVersion: 'run.memeloop.io/v1alpha1',
        kind: 'AgentRun',
        metadata: { name: 'remote:peer1:d1:abc-run', uid: 'uid-2', generation: 1, resourceVersion: '2', creationTimestamp: '2026-07-16T00:00:00.000Z' },
        spec: {},
        status: {
          phase: 'Completed',
          summary: 'remote orchestrated result',
          conditions: [{ type: 'Completed', status: 'True', reason: 'Done', lastTransitionTime: '2026-07-16T00:00:00.000Z' }],
        },
      });
      const orchestration = {
        getCapabilities,
        apply,
        get,
        list: vi.fn(),
        watch: vi.fn(),
        delete: vi.fn(),
      } as unknown as AgentOrchestrationClient;
      const context = createMinimalContext({ orchestration, localNodeId: 'node-x' });

      const result = (await remoteAgentImpl({ nodeId: 'peer1', definitionId: 'd1', message: 'm1' }, context)) as Record<string, unknown>;

      expect(result.summary).toBe('remote orchestrated result');
      expect(result.remoteNodeId).toBe('peer1');
      expect(result.definitionId).toBe('d1');
      const applyCalls = apply.mock.calls;
      const workloadCall = applyCalls.find(([resource]) => resource.kind === 'AgentWorkload')?.[0] as {
        spec?: { placement?: { requiredNode?: string }; profileId?: string };
      };
      expect(workloadCall?.spec?.placement?.requiredNode).toBe('peer1');
      expect(workloadCall?.spec?.profileId).toBe('d1');
      const structured = result[MEMELOOP_STRUCTURED_TOOL_KEY] as {
        detailRef: { type: string; nodeId: string; resourceVersion: string };
      };
      expect(structured.detailRef.type).toBe('agent-run');
      expect(structured.detailRef.nodeId).toBe('node-x');
      expect(structured.detailRef.resourceVersion).toBe('2');
    });

    it('dispatches once and falls back to remote chat log summary when stream is unavailable', async () => {
      const sendRpc = vi.fn(async (_nodeId: string, method: string, parameters: unknown) => {
        if (method === 'memeloop.agent.create') return { conversationId: 'remote-conv-1' };
        if (method === 'memeloop.agent.send') {
          const request = parameters as { requestId: string; turnId: string };
          return {
            ok: true,
            runId: 'run-1',
            requestId: request.requestId,
            turnId: request.turnId,
            conversationId: 'remote-conv-1',
            state: 'accepted',
          };
        }
        if (method === 'memeloop.chat.pullAgentRunLog') {
          return {
            messages: [
              { messageId: 'assistant-1', role: 'assistant', content: 'remote run complete' },
            ],
            nextCursor: 'cursor-1',
            hasMoreAfter: false,
            runStatus: {
              runId: 'run-1',
              conversationId: 'remote-conv-1',
              definitionId: 'd1',
              turnId: 'turn-1',
              requestPeerId: 'peer1',
              requestId: 'request-1',
              payloadDigest: 'digest-1',
              state: 'completed',
              acceptedAt: 1,
              updatedAt: 2,
            },
          };
        }
        throw new Error(`unexpected method ${method}`);
      });
      const context = createMinimalContext({ sendRpcToNode: sendRpc });
      const result = (await remoteAgentImpl(
        { nodeId: 'peer1', definitionId: 'd1', message: 'm1' },
        context,
      )) as Record<string, unknown>;
      expect(sendRpc).toHaveBeenCalledWith('peer1', 'memeloop.agent.create', {
        definitionId: 'd1',
      });
      expect(sendRpc).toHaveBeenCalledWith('peer1', 'memeloop.agent.send', expect.any(Object));
      const startTurnRequest = sendRpc.mock.calls.find(([, method]) => method === 'memeloop.agent.send')?.[2] as { requestId: string; turnId: string };
      expect(startTurnRequest.requestId).toMatch(/^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/u);
      expect(startTurnRequest.turnId).toMatch(/^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/u);
      expect(startTurnRequest.turnId).not.toBe(startTurnRequest.requestId);
      expect(startTurnRequest.turnId).not.toContain('remote-conv-1');
      expect(sendRpc).toHaveBeenCalledWith('peer1', 'memeloop.chat.pullAgentRunLog', {
        conversationId: 'remote-conv-1',
        runId: 'run-1',
        limit: 50,
        maxBytes: 256 * 1024,
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

    it('fails closed when a remote log page does not advance its cursor', async () => {
      const sendRpc = vi
        .fn()
        .mockResolvedValueOnce({ conversationId: 'remote-conv-stuck' })
        .mockImplementationOnce((_nodeId, _method, parameters: { requestId: string; turnId: string }) => ({
          ok: true,
          runId: 'run-stuck',
          requestId: parameters.requestId,
          turnId: parameters.turnId,
          conversationId: 'remote-conv-stuck',
          state: 'accepted',
        }))
        .mockResolvedValueOnce({
          messages: [{ messageId: 'assistant-1', role: 'assistant', content: 'partial' }],
          hasMoreAfter: true,
          runStatus: {
            runId: 'run-stuck',
            conversationId: 'remote-conv-stuck',
            definitionId: 'd1',
            turnId: 'turn-stuck',
            requestPeerId: 'peer1',
            requestId: 'request-stuck',
            payloadDigest: 'digest-stuck',
            state: 'running',
            acceptedAt: 1,
            updatedAt: 2,
          },
        });
      const context = createMinimalContext({ sendRpcToNode: sendRpc });

      await expect(remoteAgentImpl(
        { nodeId: 'peer1', definitionId: 'd1', message: 'm1' },
        context,
      )).resolves.toEqual({
        error: 'remoteAgent failed: remote_agent_log_cursor_did_not_advance',
      });
    });

    it('uses streamed output when subscribeRemoteStream is available', async () => {
      const sendRpc = vi
        .fn()
        .mockResolvedValueOnce({ conversationId: 'remote-conv-2' })
        .mockImplementationOnce((_nodeId, _method, parameters: { requestId: string; turnId: string }) => ({
          ok: true,
          runId: 'run-2',
          requestId: parameters.requestId,
          turnId: parameters.turnId,
          conversationId: 'remote-conv-2',
          state: 'accepted',
        }))
        .mockResolvedValueOnce({
          messages: [],
          hasMoreAfter: false,
          runStatus: {
            runId: 'run-2',
            conversationId: 'remote-conv-2',
            definitionId: 'd1',
            turnId: 'turn-2',
            requestPeerId: 'peer1',
            requestId: 'request-2',
            payloadDigest: 'digest-2',
            state: 'completed',
            acceptedAt: 1,
            updatedAt: 2,
          },
        });
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
      expect(sendRpc).toHaveBeenCalledTimes(3);
    });

    it('keeps a byte-bounded latest window across many remote log pages', async () => {
      const status = (state: 'running' | 'completed') => ({
        runId: 'run-bounded',
        conversationId: 'remote-conv-bounded',
        definitionId: 'd1',
        turnId: 'turn-bounded',
        requestPeerId: 'peer1',
        requestId: 'request-bounded',
        payloadDigest: 'digest-bounded',
        state,
        acceptedAt: 1,
        updatedAt: 2,
      });
      let page = 0;
      const sendRpc = vi.fn(async (_nodeId: string, method: string, parameters: unknown) => {
        if (method === 'memeloop.agent.create') return { conversationId: 'remote-conv-bounded' };
        if (method === 'memeloop.agent.send') {
          const request = parameters as { requestId: string; turnId: string };
          return {
            ok: true,
            runId: 'run-bounded',
            requestId: request.requestId,
            turnId: request.turnId,
            conversationId: 'remote-conv-bounded',
            state: 'accepted',
          };
        }
        page += 1;
        const prefix = page === 1 ? 'old-page' : 'latest-page';
        return {
          messages: Array.from({ length: 50 }, (_, index) => ({
            messageId: `${prefix}-${index}`,
            role: 'assistant',
            content: `${prefix}-${index}:${'x'.repeat(3900)}`,
          })),
          ...(page === 1 ? { nextCursor: 'cursor-bounded-1' } : {}),
          hasMoreAfter: page === 1,
          runStatus: status(page === 1 ? 'running' : 'completed'),
        };
      });
      const result = (await remoteAgentImpl(
        { nodeId: 'peer1', definitionId: 'd1', message: 'bounded' },
        createMinimalContext({ sendRpcToNode: sendRpc }),
      )) as { summary: string };

      expect(result).toHaveProperty('summary');
      expect(new TextEncoder().encode(result.summary).byteLength).toBeLessThanOrEqual(64 * 1024);
      expect(result.summary).toContain('latest-page-49');
      expect(result.summary).not.toContain('old-page-0');
      expect(result.summary).toContain('open the agent-run detail');
      const pulls = sendRpc.mock.calls.filter(([, method]) => method === 'memeloop.chat.pullAgentRunLog');
      expect(pulls).toHaveLength(2);
      for (const [, , parameters] of pulls) {
        expect(parameters).toMatchObject({ limit: 50, maxBytes: 256 * 1024 });
      }
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
      expect(list.targets).toBeDefined();
      expect(list.error).toContain('Direct peer enumeration is disabled');

      const missingConv = createMinimalContext({
        sendRpcToNode: vi.fn().mockResolvedValueOnce({}),
      });
      const r1 = (await remoteAgentImpl(
        { nodeId: 'n1', definitionId: 'd1', message: 'm1' },
        missingConv,
      )) as RemoteAgentErrorResult;
      expect(r1.error).toContain('Invalid Agent device RPC response.conversationId');

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
    it('returns policy-filtered targets when orchestration is configured', async () => {
      const orchestration = {
        getCapabilities: vi.fn().mockResolvedValue({
          operations: ['apply', 'get', 'list', 'delete'],
          resourceKinds: ['AgentWorkload', 'AgentRun'],
          interfaces: ['resource', 'loop-runtime'],
        }),
        apply: vi.fn(),
        get: vi.fn(),
        list: vi.fn(),
        watch: vi.fn(),
        delete: vi.fn(),
      } as unknown as AgentOrchestrationClient;
      const context = createMinimalContext({ orchestration });
      const result = (await remoteAgentListImpl({}, context)) as {
        targets: Array<{ kind: string; interfaces: string[]; operations: string[] }>;
        capabilities: string[];
      };
      expect(result.targets).toHaveLength(2);
      expect(result.targets[0]).toEqual({
        kind: 'AgentWorkload',
        interfaces: ['resource', 'loop-runtime'],
        operations: ['apply', 'get', 'list', 'delete'],
      });
      expect(result.capabilities).toEqual(['resource', 'loop-runtime']);
      expect(result).not.toHaveProperty('nodes');
    });

    it('returns empty targets and a disablement error when no orchestration is configured', async () => {
      const context = createMinimalContext();
      const result = (await remoteAgentListImpl({}, context)) as {
        targets: unknown[];
        error?: string;
      };
      expect(result.targets).toEqual([]);
      expect(result.error).toContain('Direct peer enumeration is disabled');
      expect(result).not.toHaveProperty('nodes');
    });
  });
});
