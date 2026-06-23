/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-call, @typescript-eslint/restrict-plus-operands, unicorn/prevent-abbreviations */

import { createPublicKey, randomBytes, verify } from 'node:crypto';
import http from 'node:http';

export interface StartedMockCloud {
  server: http.Server;
  port: number;
  baseUrl: string;
  stop(): Promise<void>;
}

export async function startMockCloud(): Promise<StartedMockCloud> {
  const nodeSecrets = new Map<string, string>();
  const nodePubkeys = new Map<string, string>();
  const issuedTokens = new Map<string, { nodeId: string }>();
  const challenges = new Map<string, string>();

  function json(res: http.ServerResponse, status: number, body: unknown) {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  }

  function readBody(request: http.IncomingMessage): Promise<any> {
    return new Promise((resolve) => {
      let data = '';
      request.on('data', (d) => (data += d.toString()));
      request.on('end', () => {
        try {
          resolve(data ? JSON.parse(data) : {});
        } catch {
          resolve({});
        }
      });
    });
  }

  function requireAuth(request: http.IncomingMessage): { ok: true; token: string } | { ok: false } {
    const h = request.headers['authorization'];
    if (!h || typeof h !== 'string') return { ok: false };
    const m = /^Bearer\s+(.+)$/.exec(h);
    if (!m) return { ok: false };
    const token = m[1];
    if (!issuedTokens.has(token)) return { ok: false };
    return { ok: true, token };
  }

  const server = http.createServer(async (request, res) => {
    const url = request.url ?? '/';
    const method = request.method ?? 'GET';

    if (method === 'POST' && url === '/api/nodes/register') {
      const body = await readBody(request);
      if (!body.otp || typeof body.otp !== 'string') {
        json(res, 400, { error: 'missing otp' });
        return;
      }
      // In real cloud, otp would be validated. Here: any otp works.
      const nodeId = `node_${Math.random().toString(16).slice(2, 10)}`;
      const nodeSecret = `secret_${Math.random().toString(16).slice(2, 18)}`;
      nodeSecrets.set(nodeId, nodeSecret);
      if (typeof body.ed25519PublicKey === 'string') nodePubkeys.set(nodeId, body.ed25519PublicKey);
      json(res, 200, { nodeId, nodeSecret });
      return;
    }
    if (method === 'POST' && url === '/api/nodes/auth/challenge') {
      const body = await readBody(request);
      const nodeId = typeof body?.nodeId === 'string' ? body.nodeId : '';
      if (!nodeId) {
        json(res, 400, { error: 'missing nodeId' });
        return;
      }
      if (!nodePubkeys.has(nodeId)) {
        json(res, 404, { error: 'node_not_found_or_no_pubkey' });
        return;
      }
      const challenge = randomBytes(32).toString('base64url');
      challenges.set(nodeId, challenge);
      json(res, 200, { challenge, expiresIn: 300 });
      return;
    }

    if (method === 'POST' && url === '/api/nodes/auth/verify') {
      const body = await readBody(request);
      const nodeId = typeof body?.nodeId === 'string' ? body.nodeId : '';
      const signature = typeof body?.signature === 'string' ? body.signature : '';
      if (!nodeId || !signature) {
        json(res, 400, { error: 'missing nodeId/signature' });
        return;
      }
      const challenge = challenges.get(nodeId);
      const pub = nodePubkeys.get(nodeId);
      if (!challenge || !pub) {
        json(res, 401, { error: 'challenge_not_found' });
        return;
      }
      const ok = verify(
        null,
        Buffer.from(challenge, 'base64url'),
        createPublicKey({ key: Buffer.from(pub, 'base64url'), format: 'der', type: 'spki' }),
        Buffer.from(signature, 'base64url'),
      );
      if (!ok) {
        json(res, 401, { error: 'invalid_signature' });
        return;
      }
      const accessToken = `jwt_${Math.random().toString(16).slice(2, 18)}`;
      issuedTokens.set(accessToken, { nodeId: String(nodeId) });
      challenges.delete(nodeId);
      json(res, 200, { accessToken, expiresIn: 900 });
      return;
    }

    if (method === 'POST' && url === '/api/nodes/token') {
      const body = await readBody(request);
      const { nodeId, nodeSecret } = body ?? {};
      if (!nodeId || !nodeSecret) {
        json(res, 400, { error: 'missing nodeId/nodeSecret' });
        return;
      }
      const expected = nodeSecrets.get(String(nodeId));
      if (!expected || expected !== String(nodeSecret)) {
        json(res, 401, { error: 'invalid credentials' });
        return;
      }
      const accessToken = `jwt_${Math.random().toString(16).slice(2, 18)}`;
      issuedTokens.set(accessToken, { nodeId: String(nodeId) });
      json(res, 200, { accessToken, expiresIn: 900 });
      return;
    }

    const putNodeMatch = /^\/api\/nodes\/([^/]+)$/.exec(url);
    if (method === 'PUT' && putNodeMatch) {
      const auth = requireAuth(request);
      if (!auth.ok) {
        json(res, 401, { error: 'unauthorized' });
        return;
      }
      // We accept any payload here as long as it's valid JSON.
      await readBody(request);
      json(res, 200, { ok: true });
      return;
    }

    const heartbeatMatch = /^\/api\/nodes\/([^/]+)\/heartbeat$/.exec(url);
    if (method === 'POST' && heartbeatMatch) {
      const auth = requireAuth(request);
      if (!auth.ok) {
        json(res, 401, { error: 'unauthorized' });
        return;
      }
      json(res, 200, { ok: true });
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
  });
  const sockets = new Set<import('node:net').Socket>();
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });

  await new Promise<void>((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => {
      resolve();
    });
    server.on('error', reject);
  });

  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('Failed to start mock cloud server');

  const port = addr.port;
  const baseUrl = `http://127.0.0.1:${port}`;

  return {
    server,
    port,
    baseUrl,
    async stop() {
      for (const s of sockets) s.destroy();
      await new Promise<void>((resolve) =>
        server.close(() => {
          resolve();
        })
      );
    },
  };
}
