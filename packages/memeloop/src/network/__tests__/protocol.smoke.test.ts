import { describe, expect, it } from 'vitest';

import { isConversationMeta } from '../../sync/protocol.js';
import type { AuthChallenge } from '../protocol.js';
import { isJsonRpcRequest, sendJsonRpcMethod } from '../protocol.js';
import type { RpcMethodMap, RpcParams } from '../protocol.js';
import { buildMemeloopFileUri, parseMemeloopUri } from '../uri.js';

describe('memeloop network protocol', () => {
  it('loads public API', async () => {
    const m = await import('../index.js');
    expect(m).toBeTypeOf('object');
  });

  it('isJsonRpcRequest narrows JSON-RPC 2.0 requests', () => {
    expect(isJsonRpcRequest(null)).toBe(false);
    expect(isJsonRpcRequest({ jsonrpc: '2.0', method: 'x', id: 1 })).toBe(true);
  });

  it('RpcMethodMap params align for agent.create', () => {
    // compile-time check: RpcParams must satisfy the expected shape
    type _CheckAgentCreate = RpcParams<'memeloop.agent.create'>;
    const _p: _CheckAgentCreate = { definitionId: 'd' };
    void _p;
    const p: RpcParams<'memeloop.agent.create'> = {
      definitionId: 'd',
    };
    expect(p.definitionId).toBe('d');
    const _m: RpcMethodMap['memeloop.agent.create']['result'] = {
      conversationId: 'c',
    };
    expect(_m.conversationId).toBe('c');
  });

  it('AuthChallenge shape (compile-time)', () => {
    // compile-time check: AuthChallenge must satisfy the expected shape
    type _CheckAuth = AuthChallenge;
    const _a: _CheckAuth = {} as AuthChallenge;
    void _a;
  });

  it('isConversationMeta guards shape', () => {
    expect(isConversationMeta(null)).toBe(false);
    expect(
      isConversationMeta({
        conversationId: 'x',
        title: 't',
        lastMessagePreview: '',
        lastMessageTimestamp: 0,
        messageCount: 0,
        originNodeId: 'n',
        definitionId: 'd',
        isUserInitiated: true,
      }),
    ).toBe(true);
  });

  it('buildMemeloopFileUri / parseMemeloopUri round-trip', () => {
    const nodeId = 'n1+test';
    const path = 'src/foo bar/baz.ts';
    const uri = buildMemeloopFileUri(nodeId, path);
    expect(uri).toMatch(/^memeloop:\/\/node\//);
    const parsed = parseMemeloopUri(uri);
    expect(parsed).toEqual({
      scheme: 'memeloop',
      kind: 'file',
      nodeId: 'n1+test',
      filePath: 'src/foo bar/baz.ts',
    });
    expect(parseMemeloopUri('https://example.com')).toBeNull();
  });

  it('sendJsonRpcMethod forwards to sender', async () => {
    const r = await sendJsonRpcMethod(
      async (m, p) => ({ m, p }),
      'memeloop.agent.resolveQuestion',
      { questionId: 'q', answer: 'a' },
    );
    expect(r).toEqual({
      m: 'memeloop.agent.resolveQuestion',
      p: { questionId: 'q', answer: 'a' },
    });
  });
});
