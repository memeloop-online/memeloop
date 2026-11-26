import { describe, expect, it } from 'vitest';

import { isLibp2pRpcRequest, isLibp2pRpcResponse, LIBP2P_RPC_REQUEST_TYPE, LIBP2P_RPC_RESPONSE_TYPE } from '../libp2pRpcProtocol.js';

describe('v2 RPC envelopes', () => {
  it('accepts only exact, bounded request envelopes', () => {
    const request = {
      type: LIBP2P_RPC_REQUEST_TYPE,
      id: 'request-1',
      method: 'memeloop.agent.getDefinitions',
      params: {},
    };

    expect(isLibp2pRpcRequest(request)).toBe(true);
    expect(isLibp2pRpcRequest({ ...request, unknown: true })).toBe(false);
    expect(isLibp2pRpcRequest({ ...request, id: '' })).toBe(false);
    expect(isLibp2pRpcRequest({ ...request, id: 'x'.repeat(129) })).toBe(false);
    expect(isLibp2pRpcRequest({ ...request, method: '' })).toBe(false);
    expect(isLibp2pRpcRequest({ ...request, method: 'x'.repeat(257) })).toBe(false);
    expect(isLibp2pRpcRequest({
      ...request,
      grant: {
        issuer: 'memeloop-cloud',
        accountId: 'account-1',
        subjectPeerId: 'peer-1',
        allowedPeerIds: ['peer-2'],
        protocols: ['/memeloop/rpc/2.0.0'],
        rpcMethodScope: { mode: 'all' },
        conversationScope: { mode: 'all' },
        definitionScope: { mode: 'all' },
        issuedAt: 1_000,
        expiresAt: 2_000,
        signature: 'signature',
      },
    })).toBe(true);
    expect(isLibp2pRpcRequest({
      ...request,
      grant: { issuer: 'memeloop-cloud', signature: 'incomplete' },
    })).toBe(false);
    const { params: _params, ...withoutParams } = request;
    expect(isLibp2pRpcRequest(withoutParams)).toBe(false);
  });

  it('accepts only the exact success or stable-code failure response union', () => {
    const success = {
      type: LIBP2P_RPC_RESPONSE_TYPE,
      id: 'request-1',
      ok: true,
      result: { value: 1 },
    };
    const failure = {
      type: LIBP2P_RPC_RESPONSE_TYPE,
      id: 'request-1',
      ok: false,
      error: { code: 'rpc_handler_failed' },
    };

    expect(isLibp2pRpcResponse(success)).toBe(true);
    expect(isLibp2pRpcResponse(failure)).toBe(true);
    expect(isLibp2pRpcResponse({ ...success, diagnostics: 'secret' })).toBe(false);
    expect(isLibp2pRpcResponse({ ...failure, error: 'raw provider error' })).toBe(false);
    expect(isLibp2pRpcResponse({ ...failure, error: { code: 'bad-code' } })).toBe(false);
    expect(isLibp2pRpcResponse({ ...failure, error: { code: 'rpc_handler_failed', message: 'secret' } })).toBe(false);
  });
});
