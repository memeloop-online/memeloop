import { EventEmitter } from 'node:events';
import http from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';

let lastWs: any = null;

class MockWebSocket {
  static isWebSocket(_req: any) {
    return true;
  }
  sent: string[] = [];
  closed = false;
  onmessage: ((event: { data: any }) => void) | null = null;
  constructor(_request: any, _socket: any, _head: any) {
    lastWs = this;
  }
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.closed = true;
  }
}

import { __setWebSocketImplForTest, createGitProxyHandler, createNodeServer } from '../nodeServer.js';

function jsonrpc(method: string, params: any, id: number | null = 1) {
  return JSON.stringify({ jsonrpc: '2.0', method, params, id });
}

describe('createNodeServer', () => {
  let server: http.Server;

  afterEach(async () => {
    __setWebSocketImplForTest(null);
    if (server?.listening) {
      await new Promise<void>((resolve) =>
        server.close(() => {
          resolve();
        })
      );
    }
    lastWs = null;
  });

  it('serves / and /health', async () => {
    __setWebSocketImplForTest(MockWebSocket as any);
    server = createNodeServer({
      nodeId: 'n1',
      rpcHandler: vi.fn().mockResolvedValue({ ok: true }),
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const port = (server.address() as any).port;

    const res = await fetch(`http://127.0.0.1:${port}/`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, nodeId: 'n1' });

    const res2 = await fetch(`http://127.0.0.1:${port}/health`);
    expect(res2.status).toBe(200);
  });

  it('returns 404 when git handler not configured', async () => {
    __setWebSocketImplForTest(MockWebSocket as any);
    server = createNodeServer({
      nodeId: 'n1',
      rpcHandler: vi.fn().mockResolvedValue({ ok: true }),
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const port = (server.address() as any).port;

    const res = await fetch(`http://127.0.0.1:${port}/git/wiki/x`);
    expect(res.status).toBe(404);
  });

  it('routes /git/* to gitHandler', async () => {
    __setWebSocketImplForTest(MockWebSocket as any);
    const gitHandler = vi.fn(async (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('ok');
    });
    server = createNodeServer({
      nodeId: 'n1',
      rpcHandler: vi.fn().mockResolvedValue({ ok: true }),
      gitHandler,
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const port = (server.address() as any).port;

    const res = await fetch(`http://127.0.0.1:${port}/git/wiki1/abc?x=1`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('ok');
    expect(gitHandler).toHaveBeenCalled();
  });

  it('destroys socket for non-ws upgrade paths', async () => {
    __setWebSocketImplForTest(MockWebSocket as any);
    server = createNodeServer({
      nodeId: 'n1',
      rpcHandler: vi.fn().mockResolvedValue({ ok: true }),
      wsAuth: { verify: vi.fn().mockResolvedValue(true) },
    });
    const destroy = vi.fn();
    server.emit('upgrade', { url: '/not-ws' } as any, { destroy } as any, Buffer.alloc(0));
    expect(destroy).toHaveBeenCalledTimes(1);
  });

  it('wsAuth: rejects non-handshake first message', () => {
    __setWebSocketImplForTest(MockWebSocket as any);
    server = createNodeServer({
      nodeId: 'n1',
      rpcHandler: vi.fn().mockResolvedValue({ ok: true }),
      wsAuth: { verify: vi.fn().mockResolvedValue(true) },
    });
    server.emit('upgrade', { url: '/ws' } as any, { destroy: vi.fn() } as any, Buffer.alloc(0));
    lastWs.onmessage({ data: jsonrpc('memeloop.node.getInfo', {}, 2) });
    const m = JSON.parse(lastWs.sent[0]);
    expect(m.error.code).toBe(-32001);
    expect(lastWs.closed).toBe(true);
  });

  it('wsAuth: accepts handshake then processes queued RPC', async () => {
    __setWebSocketImplForTest(MockWebSocket as any);
    const rpcHandler = vi.fn().mockResolvedValue({ ok: true });
    let resolveVerify!: (v: boolean) => void;
    const verify = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          resolveVerify = resolve;
        }),
    );
    server = createNodeServer({
      nodeId: 'n1',
      rpcHandler,
      wsAuth: { verify },
    });
    server.emit('upgrade', { url: '/ws' } as any, { destroy: vi.fn() } as any, Buffer.alloc(0));
    lastWs.onmessage({ data: jsonrpc('memeloop.auth.handshake', { nodeId: 'x', authType: 'pin', credential: 'c' }, 1) });
    lastWs.onmessage({ data: jsonrpc('memeloop.node.getInfo', {}, 2) }); // queued while pending verify
    expect(rpcHandler).not.toHaveBeenCalled();
    resolveVerify(true);
    await Promise.resolve();
    await Promise.resolve();
    expect(rpcHandler).toHaveBeenCalledWith('memeloop.node.getInfo', {}, expect.any(Object));
    expect(lastWs.sent.some((s: string) => JSON.parse(s).result?.ok === true)).toBe(true);
  });

  it('wsAuth: invalid handshake params and verify failure', async () => {
    __setWebSocketImplForTest(MockWebSocket as any);
    const verify = vi.fn().mockResolvedValue(false);
    server = createNodeServer({
      nodeId: 'n1',
      rpcHandler: vi.fn().mockResolvedValue({ ok: true }),
      wsAuth: { verify },
    });
    server.emit('upgrade', { url: '/ws' } as any, { destroy: vi.fn() } as any, Buffer.alloc(0));
    lastWs.onmessage({ data: jsonrpc('memeloop.auth.handshake', { bad: 1 }, 1) });
    let m = JSON.parse(lastWs.sent[lastWs.sent.length - 1]);
    expect(m.error.code).toBe(-32602);
    expect(lastWs.closed).toBe(true);

    // verify false branch
    server.emit('upgrade', { url: '/ws' } as any, { destroy: vi.fn() } as any, Buffer.alloc(0));
    lastWs.onmessage({ data: jsonrpc('memeloop.auth.handshake', { nodeId: 'x', authType: 'pin', credential: 'bad' }, 1) });
    await Promise.resolve();
    m = JSON.parse(lastWs.sent[lastWs.sent.length - 1]);
    expect(m.error.code).toBe(-32002);
    expect(lastWs.closed).toBe(true);
  });

  it('wsAuth: handshake already in progress and verify throws', async () => {
    __setWebSocketImplForTest(MockWebSocket as any);
    let resolveVerify!: (v: boolean) => void;
    const verify = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          resolveVerify = resolve;
        }),
    );
    server = createNodeServer({
      nodeId: 'n1',
      rpcHandler: vi.fn().mockResolvedValue({ ok: true }),
      wsAuth: { verify },
    });
    server.emit('upgrade', { url: '/ws' } as any, { destroy: vi.fn() } as any, Buffer.alloc(0));
    lastWs.onmessage({ data: jsonrpc('memeloop.auth.handshake', { nodeId: 'x', authType: 'pin', credential: 'c' }, 1) });
    // second handshake while pending_verify
    lastWs.onmessage({ data: jsonrpc('memeloop.auth.handshake', { nodeId: 'x', authType: 'pin', credential: 'c' }, 2) });
    const m = JSON.parse(lastWs.sent[lastWs.sent.length - 1]);
    expect(m.error.code).toBe(-32600);
    resolveVerify(true);
    await Promise.resolve();

    // verify throws branch
    const verify2 = vi.fn().mockRejectedValue(new Error('verify-bad'));
    server = createNodeServer({
      nodeId: 'n1',
      rpcHandler: vi.fn().mockResolvedValue({ ok: true }),
      wsAuth: { verify: verify2 },
    });
    server.emit('upgrade', { url: '/ws' } as any, { destroy: vi.fn() } as any, Buffer.alloc(0));
    lastWs.onmessage({ data: jsonrpc('memeloop.auth.handshake', { nodeId: 'x', authType: 'pin', credential: 'c' }, 1) });
    await Promise.resolve();
    await Promise.resolve();
    expect(lastWs.sent.length).toBeGreaterThan(0);
    const m2 = JSON.parse(lastWs.sent[lastWs.sent.length - 1]);
    expect(m2.error.code).toBe(-32603);
    expect(lastWs.closed).toBe(true);
  });

  it('without wsAuth, invalid request and parse error return rpc errors', () => {
    __setWebSocketImplForTest(MockWebSocket as any);
    server = createNodeServer({
      nodeId: 'n1',
      rpcHandler: vi.fn().mockResolvedValue({ ok: true }),
    });
    server.emit('upgrade', { url: '/ws' } as any, { destroy: vi.fn() } as any, Buffer.alloc(0));
    lastWs.onmessage({ data: '{bad' });
    let m = JSON.parse(lastWs.sent[lastWs.sent.length - 1]);
    expect(m.error.code).toBe(-32700);
    lastWs.onmessage({ data: JSON.stringify({ jsonrpc: '2.0', id: 3 }) });
    m = JSON.parse(lastWs.sent[lastWs.sent.length - 1]);
    expect(m.error.code).toBe(-32600);
  });

  it('handles /im/webhook routes for GET/POST/bad channel/handler error', async () => {
    __setWebSocketImplForTest(MockWebSocket as any);
    const imWebhookHandler = vi.fn(async ({ method, channelId, body, res }) => {
      if (channelId === 'boom') throw new Error('boom');
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end(`${method}:${channelId}:${body.length}`);
    });
    server = createNodeServer({
      nodeId: 'n1',
      rpcHandler: vi.fn().mockResolvedValue({ ok: true }),
      imWebhookHandler,
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const port = (server.address() as any).port;

    const g = await fetch(`http://127.0.0.1:${port}/im/webhook/ch1?x=1`);
    expect(await g.text()).toBe('GET:ch1:0');
    const p = await fetch(`http://127.0.0.1:${port}/im/webhook/ch2`, { method: 'POST', body: 'abc' });
    expect(await p.text()).toBe('POST:ch2:3');
    const bad = await fetch(`http://127.0.0.1:${port}/im/webhook/`);
    expect(bad.status).toBe(400);
    const e = await fetch(`http://127.0.0.1:${port}/im/webhook/boom`);
    expect(e.status).toBe(500);
  });

  it('createGitProxyHandler covers auth/wiki/block/error branches', async () => {
    const mkRes = () => {
      const body: string[] = [];
      return {
        headersSent: false,
        statusCode: 0,
        writeHead(code: number) {
          this.statusCode = code;
          this.headersSent = true;
        },
        end(s?: string) {
          if (s) body.push(s);
        },
        getBody: () => body.join(''),
      } as any;
    };
    const req = new EventEmitter() as any;
    req.url = '/git/w1/a?x=1';
    req.method = 'GET';
    req.headers = {};
    req.pipe = vi.fn();

    const h1 = createGitProxyHandler({
      getBackendUrl: async () => 'http://example.com/wiki',
      verifyAuth: async () => false,
    });
    const r1 = mkRes();
    await h1(req, r1, 'w1', 'a', 'x=1');
    expect(r1.statusCode).toBe(401);

    const h2 = createGitProxyHandler({
      getBackendUrl: async () => null,
      verifyAuth: async () => true,
    });
    const r2 = mkRes();
    await h2(req, r2, 'w1', 'a', 'x=1');
    expect(r2.statusCode).toBe(404);

    const h3 = createGitProxyHandler({
      getBackendUrl: async () => 'http://127.0.0.1:8080/wiki',
      verifyAuth: async () => true,
    });
    const r3 = mkRes();
    await h3(req, r3, 'w1', 'a', 'x=1');
    expect(r3.statusCode).toBe(403);

    const oldRequest = http.request;
    (http as any).request = (_target: any, _opts: any, _cb: any) => {
      const proxyReq = new EventEmitter() as any;
      proxyReq.on = EventEmitter.prototype.on.bind(proxyReq);
      req.pipe.mockImplementation(() => proxyReq);
      queueMicrotask(() => proxyReq.emit('error', new Error('net')));
      return proxyReq;
    };
    try {
      const h4 = createGitProxyHandler({
        getBackendUrl: async () => 'http://example.com/wiki',
        verifyAuth: async () => true,
      });
      const r4 = mkRes();
      await h4(req, r4, 'w1', 'a', 'x=1');
      await Promise.resolve();
      expect(r4.statusCode).toBe(502);
      expect(r4.getBody()).toContain('Bad Gateway');
    } finally {
      (http as any).request = oldRequest;
    }
  });
});
