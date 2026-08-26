import type { Stream } from '@libp2p/interface';
import { describe, expect, it, vi } from 'vitest';

import { AGENT_DEVICE_RPC_METHODS, type DeviceAuthorizer, type DeviceConnectionGrant, type DeviceRpcHandler, encodeJsonFrame } from 'memeloop';
import { type DeviceRpcRunGrantResources, PortableLibp2pDeviceNetworkService } from '../portableLibp2pDeviceNetworkService.js';

const REMOTE_PEER_ID = 'remote-peer';

function connectionGrant(input: {
  methods?: string[] | 'all';
  conversations?: string[] | 'all';
  definitions?: string[] | 'all';
} = {}): DeviceConnectionGrant {
  const scope = (value: string[] | 'all' | undefined) =>
    value === 'all' || value === undefined
      ? { mode: 'all' as const }
      : { mode: 'ids' as const, ids: [...value].sort() };
  return {
    issuer: 'memeloop-cloud',
    accountId: 'account-1',
    subjectPeerId: REMOTE_PEER_ID,
    allowedPeerIds: ['local-peer'],
    protocols: ['/memeloop/rpc/2.0.0'],
    rpcMethodScope: scope(input.methods),
    conversationScope: scope(input.conversations),
    definitionScope: scope(input.definitions),
    issuedAt: 1_000,
    expiresAt: 10_000,
    signature: 'test-signature',
  };
}

function decodeFrame(frame: Uint8Array): unknown {
  const length = new DataView(frame.buffer, frame.byteOffset, 4).getUint32(0, false);
  return JSON.parse(new TextDecoder().decode(frame.subarray(4, 4 + length))) as unknown;
}

async function invokeRpc(input: {
  method?: string;
  parameters?: unknown;
  grant?: DeviceConnectionGrant;
  authorized?: boolean;
  rpcHandler?: DeviceRpcHandler;
  resolveRunGrantResources?: (
    runId: string,
    remotePeerId: string,
  ) => Promise<DeviceRpcRunGrantResources | undefined>;
  sourceError?: Error;
}): Promise<{
  response: unknown;
  abort: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
}> {
  const sent: Uint8Array[] = [];
  const abort = vi.fn();
  const close = vi.fn(async () => undefined);
  const request = encodeJsonFrame({
    type: 'memeloop-rpc-request-v2',
    id: 'request-1',
    method: input.method ?? AGENT_DEVICE_RPC_METHODS.getConversationMeta,
    params: input.parameters ?? { conversationId: 'conversation-1' },
    ...(input.grant ? { grant: input.grant } : {}),
  });
  const stream = {
    send: (chunk: Uint8Array) => {
      sent.push(chunk);
    },
    close,
    abort,
    async *[Symbol.asyncIterator]() {
      if (input.sourceError) throw input.sourceError;
      yield request;
    },
  } as unknown as Stream;
  const authorizer: DeviceAuthorizer = {
    canOpenProtocol: async () => input.authorized ?? true,
  };
  const service = new PortableLibp2pDeviceNetworkService({
    identity: {
      peerId: 'local-peer',
      publicKeyMultibase: 'libp2p-pub:test',
      privateKeyRef: 'test',
      privateKeyRawSeedBase64Url: 'test',
      createdAt: 1,
      deviceName: 'local',
      platform: 'cli',
    },
    authorizer,
    rpcHandler: input.rpcHandler,
    resolveRunGrantResources: input.resolveRunGrantResources,
    nodeFactory: async () => {
      throw new Error('node factory must not run');
    },
  });

  await (service as unknown as {
    handleRpcStream(stream: Stream, remotePeerId: string): Promise<void>;
  }).handleRpcStream(stream, REMOTE_PEER_ID);
  return {
    response: sent[0] ? decodeFrame(sent[0]) : undefined,
    abort,
    close,
  };
}

describe('portable inbound RPC grant scopes', () => {
  it('rejects unauthorized peers before dispatch', async () => {
    const rpcHandler = vi.fn(async () => ({ ok: true }));

    const { response } = await invokeRpc({ authorized: false, rpcHandler });

    expect(response).toMatchObject({ ok: false, error: { code: 'device_not_trusted' } });
    expect(rpcHandler).not.toHaveBeenCalled();
  });

  it('rejects unknown and invalid typed methods before dispatch', async () => {
    const rpcHandler = vi.fn(async () => ({ ok: true }));

    const unknown = await invokeRpc({ method: 'memeloop.test.ping', rpcHandler });
    const missingResource = await invokeRpc({
      method: AGENT_DEVICE_RPC_METHODS.getConversationMeta,
      parameters: {},
      rpcHandler,
    });

    expect(unknown.response).toMatchObject({
      ok: false,
      error: { code: 'rpc_method_not_found' },
    });
    expect(missingResource.response).toMatchObject({ ok: false });
    expect(rpcHandler).not.toHaveBeenCalled();
  });

  it('rejects conversation scope escalation before dispatch', async () => {
    const rpcHandler = vi.fn(async () => ({ ok: true }));
    const grant = connectionGrant({
      methods: [AGENT_DEVICE_RPC_METHODS.getConversationMeta],
      conversations: ['conversation-allowed'],
    });

    const { response } = await invokeRpc({
      grant,
      parameters: { conversationId: 'conversation-denied' },
      rpcHandler,
    });

    expect(response).toMatchObject({
      ok: false,
      error: { code: 'device_grant_rpc_scope_violation' },
    });
    expect(rpcHandler).not.toHaveBeenCalled();
  });

  it('requires all-conversation and all-definition scope for broad enumeration', async () => {
    const rpcHandler = vi.fn(async () => ({ ok: true }));
    const listResult = await invokeRpc({
      method: AGENT_DEVICE_RPC_METHODS.listConversations,
      parameters: {},
      grant: connectionGrant({
        methods: [AGENT_DEVICE_RPC_METHODS.listConversations],
        conversations: ['conversation-1'],
      }),
      rpcHandler,
    });
    const definitionsResult = await invokeRpc({
      method: AGENT_DEVICE_RPC_METHODS.getDefinitions,
      parameters: {},
      grant: connectionGrant({
        methods: [AGENT_DEVICE_RPC_METHODS.getDefinitions],
        definitions: ['definition-1'],
      }),
      rpcHandler,
    });

    expect(listResult.response).toMatchObject({
      ok: false,
      error: { code: 'device_grant_rpc_scope_violation' },
    });
    expect(definitionsResult.response).toMatchObject({
      ok: false,
      error: { code: 'device_grant_rpc_scope_violation' },
    });
    expect(rpcHandler).not.toHaveBeenCalled();
  });

  it('resolves run-id authorization from the durable owner and resources', async () => {
    const rpcHandler = vi.fn(async () => ({ status: 'ok' }));
    const resolveRunGrantResources = vi.fn(async () => ({
      requestPeerId: REMOTE_PEER_ID,
      conversationId: 'conversation-1',
      definitionId: 'definition-1',
    }));
    const grant = connectionGrant({
      methods: [AGENT_DEVICE_RPC_METHODS.getRunStatus],
      conversations: ['conversation-1'],
      definitions: ['definition-1'],
    });

    const { response } = await invokeRpc({
      method: AGENT_DEVICE_RPC_METHODS.getRunStatus,
      parameters: { runId: 'run-1' },
      grant,
      rpcHandler,
      resolveRunGrantResources,
    });

    expect(response).toMatchObject({ ok: true, result: { status: 'ok' } });
    expect(resolveRunGrantResources).toHaveBeenCalledWith('run-1', REMOTE_PEER_ID);
    expect(rpcHandler).toHaveBeenCalledOnce();
  });

  it('fails closed for missing, cross-peer, and caller-asserted run resources', async () => {
    const rpcHandler = vi.fn(async () => ({ ok: true }));
    const statusGrant = connectionGrant({
      methods: [AGENT_DEVICE_RPC_METHODS.getRunStatus],
      conversations: ['conversation-1'],
      definitions: ['definition-1'],
    });
    const missing = await invokeRpc({
      method: AGENT_DEVICE_RPC_METHODS.getRunStatus,
      parameters: { runId: 'run-1' },
      grant: statusGrant,
      rpcHandler,
    });
    const crossPeer = await invokeRpc({
      method: AGENT_DEVICE_RPC_METHODS.getRunStatus,
      parameters: { runId: 'run-1' },
      grant: statusGrant,
      rpcHandler,
      resolveRunGrantResources: async () => ({
        requestPeerId: 'different-peer',
        conversationId: 'conversation-1',
        definitionId: 'definition-1',
      }),
    });
    const logMismatch = await invokeRpc({
      method: AGENT_DEVICE_RPC_METHODS.pullAgentRunLog,
      parameters: { runId: 'run-1', conversationId: 'caller-conversation' },
      grant: connectionGrant({
        methods: [AGENT_DEVICE_RPC_METHODS.pullAgentRunLog],
        conversations: ['caller-conversation', 'durable-conversation'],
        definitions: ['definition-1'],
      }),
      rpcHandler,
      resolveRunGrantResources: async () => ({
        requestPeerId: REMOTE_PEER_ID,
        conversationId: 'durable-conversation',
        definitionId: 'definition-1',
      }),
    });

    expect(missing.response).toMatchObject({
      ok: false,
      error: { code: 'device_grant_run_scope_unavailable' },
    });
    expect(crossPeer.response).toMatchObject({
      ok: false,
      error: { code: 'device_grant_run_peer_mismatch' },
    });
    expect(logMismatch.response).toMatchObject({
      ok: false,
      error: { code: 'device_grant_run_conversation_mismatch' },
    });
    expect(rpcHandler).not.toHaveBeenCalled();
  });

  it('rejects a disallowed run method without probing durable run state', async () => {
    const rpcHandler = vi.fn(async () => ({ ok: true }));
    const resolveRunGrantResources = vi.fn(async () => ({
      requestPeerId: REMOTE_PEER_ID,
      conversationId: 'conversation-1',
      definitionId: 'definition-1',
    }));

    const { response } = await invokeRpc({
      method: AGENT_DEVICE_RPC_METHODS.getRunStatus,
      parameters: { runId: 'run-1' },
      grant: connectionGrant({
        methods: [AGENT_DEVICE_RPC_METHODS.cancel],
        conversations: 'all',
        definitions: 'all',
      }),
      rpcHandler,
      resolveRunGrantResources,
    });

    expect(response).toMatchObject({
      ok: false,
      error: { code: 'device_grant_rpc_scope_violation' },
    });
    expect(resolveRunGrantResources).not.toHaveBeenCalled();
    expect(rpcHandler).not.toHaveBeenCalled();
  });

  it('aborts a failed source once and never dispatches it', async () => {
    const rpcHandler = vi.fn(async () => ({ ok: true }));

    const { response, abort, close } = await invokeRpc({
      sourceError: new Error('remote_aborted'),
      rpcHandler,
    });

    expect(response).toMatchObject({ ok: false });
    expect(abort).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
    expect(rpcHandler).not.toHaveBeenCalled();
  });

  it('never serializes raw handler diagnostics to a remote peer', async () => {
    const rpcHandler = vi.fn(async () => {
      throw new Error('provider key sk-secret-value');
    });

    const { response } = await invokeRpc({ rpcHandler });

    expect(response).toEqual({
      type: 'memeloop-rpc-response-v2',
      id: 'request-1',
      ok: false,
      error: { code: 'rpc_handler_failed' },
    });
    expect(JSON.stringify(response)).not.toContain('sk-secret-value');
  });
});
