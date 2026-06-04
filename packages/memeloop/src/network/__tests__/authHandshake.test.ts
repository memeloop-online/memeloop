import { describe, expect, it } from 'vitest';

import { buildAuthHandshakeMessage, parseAuthHandshakeMessage } from '../authHandshake.js';

describe('authHandshake', () => {
  it('buildAuthHandshakeMessage builds jsonrpc request with method/id', () => {
    const msg = buildAuthHandshakeMessage({ nodeId: 'n1', authType: 'pin', credential: '123' } as any);
    const parsed = JSON.parse(msg);
    expect(parsed).toMatchObject({
      jsonrpc: '2.0',
      id: 1,
      method: 'memeloop.auth.handshake',
      params: { nodeId: 'n1', authType: 'pin', credential: '123' },
    });
  });

  it('parseAuthHandshakeMessage returns null for invalid JSON or non-handshake', () => {
    expect(parseAuthHandshakeMessage('{bad')).toBeNull();
    expect(parseAuthHandshakeMessage(JSON.stringify({ jsonrpc: '2.0', method: 'x' }))).toBeNull();
  });

  it('parseAuthHandshakeMessage validates param types', () => {
    expect(
      parseAuthHandshakeMessage(
        JSON.stringify({ jsonrpc: '2.0', method: 'memeloop.auth.handshake', params: { nodeId: 1 } }),
      ),
    ).toBeNull();
  });

  it('parseAuthHandshakeMessage parses valid handshake', () => {
    const p = parseAuthHandshakeMessage(
      JSON.stringify({
        jsonrpc: '2.0',
        method: 'memeloop.auth.handshake',
        params: { nodeId: 'n1', authType: 'jwt', credential: 't' },
      }),
    );
    expect(p).toEqual({ nodeId: 'n1', authType: 'jwt', credential: 't' });
  });
});
