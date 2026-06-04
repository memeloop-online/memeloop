/**
 * Unified node server: one port for HTTP and WebSocket (JSON-RPC 2.0).
 * Used by memeloop-cli CLI and TidGi-Desktop (and any host that runs a memeloop node).
 * faye-websocket is loaded lazily inside createNodeServer() so that importing this module
 * from a bundle that lacks the package (e.g. the main Electron process) does NOT throw
 * "Cannot find module 'faye-websocket'" at startup.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import http from 'node:http';
import https from 'node:https';

import { gitProxyTargetBlockReason } from './gitProxyUrlPolicy.js';
// Import as type only; the actual require happens lazily inside createNodeServer.
import type { WebSocket as FayeWebSocket } from 'faye-websocket';

import { parseAuthHandshakeMessage, type ParsedHandshake } from './authHandshake.js';
import { NoiseJsonRpcCodec } from './noiseTransport.js';
import { createNoiseXxResponder, getNoiseXxPeerCryptoMaterial, MEMELOOP_NOISE_PROLOGUE_V1, type NoiseStaticKeyPair, type NoiseXxHandshakePeer } from './noiseXxHandshake.js';

/** Per-WebSocket 连接上下文：JSON-RPC handler 第三参数。 */
export type NodeRpcContext = {
  notify: (method: string, parameters: unknown) => void;
  /** LAN PIN 确认失败计数；由 createNodeServer 每连接创建，供 memeloop.auth.confirmPin 限速。 */
  pinConfirmState?: { consecutiveFails: number; lockedUntil: number };
};

/** Handle one JSON-RPC call. Return value is sent as result; throw is sent as error. */
export type NodeRpcHandler = (method: string, parameters: unknown, context?: NodeRpcContext) => Promise<unknown>;

/** Handle /git/{wikiId}/{pathSuffix}. Optional; if not set, /git/* returns 404. */
export type NodeGitHandler = (
  request: IncomingMessage,
  res: ServerResponse,
  wikiId: string,
  pathSuffix: string,
  queryString?: string,
) => Promise<void>;

/** Verify WebSocket client's first message: memeloop.auth.handshake. */
export interface WsAuthOptions {
  verify(handshake: ParsedHandshake): Promise<boolean>;
}

/** 处理 /im/webhook/<channelId>（POST 为主；企业微信 URL 校验可能为 GET）。 */
export type ImWebhookHandler = (arguments_: {
  req: IncomingMessage;
  res: ServerResponse;
  channelId: string;
  body: Buffer;
  method?: string;
  queryString?: string;
}) => Promise<void>;

export interface CreateNodeServerOptions {
  nodeId: string;
  /** Called for each JSON-RPC request. */
  rpcHandler: NodeRpcHandler;
  /** If set, handles /git/* requests. Can be a function or { getBackendUrl, verifyAuth } for HTTP reverse proxy. */
  gitHandler?:
    | NodeGitHandler
    | {
      getBackendUrl(wikiId: string): Promise<string | null> | null;
      verifyAuth(authHeader: string | undefined): Promise<boolean>;
    };
  /**
   * If set, the first WebSocket message must be memeloop.auth.handshake and must pass verify().
   * Until then, other methods are rejected and the socket is closed.
   * Omit for backward-compatible behaviour (all messages go to rpcHandler).
   */
  wsAuth?: WsAuthOptions;
  /** 若设置，则提供 IM 平台直连 Webhook 端点。 */
  imWebhookHandler?: ImWebhookHandler;
  /**
   * 启用后：先交换 3 条 **binary** Noise_XX 消息，再对 JSON-RPC 做 ChaCha20-Poly1305 帧加密（§7.5.5）。
   * 未设置时保持明文 WebSocket 帧（兼容旧客户端与 Mock 单测）。
   */
  noise?: {
    staticKeyPair: NoiseStaticKeyPair;
    /** 默认 {@link MEMELOOP_NOISE_PROLOGUE_V1} */
    prologue?: Buffer;
  };
}

type WebSocketImpl = typeof FayeWebSocket & { isWebSocket(request: IncomingMessage): boolean };
let testWebSocketImpl: WebSocketImpl | null = null;

/** Test-only seam: inject WebSocket implementation for deterministic handshake tests. */
export function __setWebSocketImplForTest(impl: WebSocketImpl | null): void {
  testWebSocketImpl = impl;
}

/** Build git handler from getBackendUrl + verifyAuth (HTTP reverse proxy). Used by memeloop-cli. */
export function createGitProxyHandler(options: {
  getBackendUrl(wikiId: string): Promise<string | null> | null;
  verifyAuth(authHeader: string | undefined): Promise<boolean>;
}): NodeGitHandler {
  const { getBackendUrl, verifyAuth } = options;
  return async (request, res, wikiId, pathSuffix, _queryString) => {
    const authHeader = typeof request.headers.authorization === 'string' &&
        request.headers.authorization.toLowerCase().startsWith('bearer ')
      ? request.headers.authorization.slice(7).trim()
      : undefined;
    const allowed = await verifyAuth(authHeader);
    if (!allowed) {
      res.writeHead(401, { 'Content-Type': 'text/plain' });
      res.end('Unauthorized');
      return;
    }
    const baseUrl = getBackendUrl(wikiId);
    const url = typeof baseUrl === 'object' && baseUrl !== null && 'then' in baseUrl
      ? await baseUrl
      : baseUrl;
    if (!url) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Wiki not found');
      return;
    }
    const q = request.url?.includes('?') ? request.url.slice(request.url.indexOf('?')) : '';
    const target = new URL(
      (pathSuffix ? `/${pathSuffix}` : '/') + q,
      url.replace(/\/$/, ''),
    );
    const block = gitProxyTargetBlockReason(target);
    if (block) {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      res.end(`git proxy target blocked: ${block}`);
      return;
    }
    const requestModule = target.protocol === 'https:' ? https.request : http.request;
    const proxyRequest = requestModule(
      target,
      {
        method: request.method,
        headers: { ...request.headers, host: target.host },
      },
      (proxyRes: IncomingMessage) => {
        res.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers);
        proxyRes.pipe(res);
      },
    );
    proxyRequest.on('error', () => {
      if (!res.headersSent) {
        res.writeHead(502, { 'Content-Type': 'text/plain' });
        res.end('Bad Gateway');
      }
    });
    request.pipe(proxyRequest);
  };
}

function readHttpBody(request: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer | string) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    request.on('end', () => {
      resolve(Buffer.concat(chunks));
    });
    request.on('error', reject);
  });
}

function resolveGitHandler(
  options: CreateNodeServerOptions['gitHandler'],
): NodeGitHandler | null {
  if (!options) return null;
  if (typeof options === 'function') return options;
  return createGitProxyHandler(options);
}

export function createNodeServer(
  options: CreateNodeServerOptions,
): http.Server {
  const { nodeId, rpcHandler, wsAuth, imWebhookHandler, noise: noiseOpt } = options;
  const gitHandler = resolveGitHandler(options.gitHandler);
  // Lazy-load faye-websocket so this module can be imported in environments
  // that don't have the package installed (e.g. the main Electron process bundle).

  const WebSocket: WebSocketImpl = testWebSocketImpl ??
    (require('faye-websocket') as { WebSocket: WebSocketImpl }).WebSocket;

  const server = http.createServer((request, res) => {
    const url = request.url ?? '/';
    const qIndex = url.indexOf('?');
    const path = qIndex >= 0 ? url.slice(0, qIndex) : url;
    const queryString = qIndex >= 0 ? url.slice(qIndex + 1) : '';

    if (
      imWebhookHandler &&
      path.startsWith('/im/webhook/') &&
      (request.method === 'POST' || request.method === 'GET')
    ) {
      const rest = path.slice('/im/webhook/'.length);
      const channelId = rest.split('/')[0]?.trim() ?? '';
      if (!channelId) {
        res.writeHead(400, { 'Content-Type': 'text/plain' });
        res.end('Bad Request');
        return;
      }
      const run = (body: Buffer): void => {
        imWebhookHandler({
          req: request,
          res,
          channelId,
          body,
          method: request.method,
          queryString,
        }).catch(() => {
          if (!res.headersSent) {
            res.writeHead(500, { 'Content-Type': 'text/plain' });
            res.end('Internal Server Error');
          }
        });
      };
      if (request.method === 'GET') {
        run(Buffer.alloc(0));
      } else {
        readHttpBody(request)
          .then(run)
          .catch(() => {
            if (!res.headersSent) {
              res.writeHead(500, { 'Content-Type': 'text/plain' });
              res.end('Internal Server Error');
            }
          });
      }
      return;
    }

    if (gitHandler && path.startsWith('/git/')) {
      const rest = path.slice(5);
      const slash = rest.indexOf('/');
      const wikiId = slash >= 0 ? rest.slice(0, slash) : rest;
      const pathSuffix = slash >= 0 ? rest.slice(slash + 1) : '';
      gitHandler(request, res, wikiId, pathSuffix, queryString).catch(() => {
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'text/plain' });
          res.end('Internal Server Error');
        }
      });
      return;
    }

    if (path === '/' || path === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, nodeId }));
      return;
    }

    res.writeHead(404);
    res.end('Not Found');
  });

  server.on('upgrade', (request, socket, head) => {
    const path = request.url?.split('?')[0] ?? '/';
    if ((path !== '/' && path !== '/ws') || !WebSocket.isWebSocket(request)) {
      socket.destroy();
      return;
    }
    const ws = new WebSocket(request, socket, head);
    const noisePrologue = noiseOpt?.prologue ?? MEMELOOP_NOISE_PROLOGUE_V1;
    let noiseCodec: NoiseJsonRpcCodec | null = null;
    let noiseAwait: 'msg1' | 'msg3' | null = noiseOpt ? 'msg1' : null;
    let noisePeer: NoiseXxHandshakePeer | null = null;

    /** 无 wsAuth 时等同已认证；有 wsAuth 时经 handshake 后为 authed；有 Noise 时先 awaiting_noise。 */
    type WsAuthState =
      | 'awaiting_noise'
      | 'awaiting_handshake'
      | 'pending_verify'
      | 'authed'
      | 'rejected';
    let authState: WsAuthState = noiseOpt
      ? 'awaiting_noise'
      : wsAuth
      ? 'awaiting_handshake'
      : 'authed';
    /** 异步校验期间到达的消息，认证成功后按序处理（避免 verify 完成前误拒后续 RPC）。 */
    const pendingWhileVerifying: string[] = [];

    const sendWire = (text: string): void => {
      try {
        if (noiseCodec) {
          ws.send(noiseCodec.encrypt(text));
        } else {
          ws.send(text);
        }
      } catch {
        /* ignore */
      }
    };

    const sendRpc = (payload: Record<string, unknown>): void => {
      sendWire(JSON.stringify(payload));
    };

    const pinConfirmState = { consecutiveFails: 0, lockedUntil: 0 };

    const runRpcWithContext = (
      message: {
        jsonrpc?: string;
        method?: string;
        params?: unknown;
        id?: number | null;
      },
    ): void => {
      const notify = (method: string, parameters: unknown): void => {
        sendRpc({ jsonrpc: '2.0', method, params: parameters });
      };
      if (message.jsonrpc !== '2.0' || !message.method) {
        sendRpc({
          jsonrpc: '2.0',
          error: { code: -32600, message: 'Invalid Request' },
          id: message.id ?? null,
        });
        return;
      }
      void rpcHandler(message.method, message.params ?? {}, { notify, pinConfirmState })
        .then((result) => {
          if (message.id != null) {
            sendRpc({ jsonrpc: '2.0', id: message.id, result });
          }
        })
        .catch((error) => {
          sendRpc({
            jsonrpc: '2.0',
            error: { code: -32603, message: String(error) },
            id: message.id != null ? message.id : null,
          });
        });
    };

    const flushPendingQueue = (): void => {
      while (pendingWhileVerifying.length > 0) {
        const raw = pendingWhileVerifying.shift();
        if (raw === undefined) break;
        dispatchRawMessage(raw);
      }
    };

    const dispatchRawMessage = (raw: string): void => {
      let message: {
        jsonrpc?: string;
        method?: string;
        params?: unknown;
        id?: number | null;
      };
      try {
        message = JSON.parse(raw) as typeof message;
      } catch {
        sendRpc({
          jsonrpc: '2.0',
          error: { code: -32700, message: 'Parse error' },
          id: null,
        });
        return;
      }

      if (authState === 'awaiting_noise') {
        return;
      }

      if (authState === 'authed') {
        runRpcWithContext(message);
        return;
      }

      if (authState === 'rejected') {
        return;
      }

      if (!wsAuth) {
        runRpcWithContext(message);
        return;
      }

      if (authState === 'pending_verify') {
        if (message.method === 'memeloop.auth.handshake') {
          sendRpc({
            jsonrpc: '2.0',
            id: message.id ?? null,
            error: {
              code: -32600,
              message: 'Authentication already in progress',
            },
          });
          return;
        }
        pendingWhileVerifying.push(raw);
        return;
      }

      // awaiting_handshake
      if (message.jsonrpc !== '2.0' || !message.method) {
        sendRpc({
          jsonrpc: '2.0',
          error: { code: -32600, message: 'Invalid Request' },
          id: message.id ?? null,
        });
        try {
          ws.close();
        } catch {
          /* ignore */
        }
        return;
      }
      if (message.method !== 'memeloop.auth.handshake') {
        sendRpc({
          jsonrpc: '2.0',
          id: message.id ?? null,
          error: {
            code: -32001,
            message: 'Authentication required: send memeloop.auth.handshake first',
          },
        });
        try {
          ws.close();
        } catch {
          /* ignore */
        }
        return;
      }
      const parsed = parseAuthHandshakeMessage(raw);
      if (!parsed) {
        sendRpc({
          jsonrpc: '2.0',
          id: message.id ?? null,
          error: { code: -32602, message: 'Invalid handshake params' },
        });
        try {
          ws.close();
        } catch {
          /* ignore */
        }
        return;
      }
      authState = 'pending_verify';
      void wsAuth
        .verify(parsed)
        .then((ok) => {
          if (!ok) {
            authState = 'rejected';
            sendRpc({
              jsonrpc: '2.0',
              id: message.id ?? null,
              error: { code: -32002, message: 'Authentication failed' },
            });
            try {
              ws.close();
            } catch {
              /* ignore */
            }
            return;
          }
          authState = 'authed';
          if (message.id != null) {
            sendRpc({
              jsonrpc: '2.0',
              id: message.id,
              result: { ok: true, nodeId },
            });
          }
          flushPendingQueue();
        })
        .catch((error) => {
          authState = 'rejected';
          sendRpc({
            jsonrpc: '2.0',
            id: message.id ?? null,
            error: { code: -32603, message: String(error) },
          });
          try {
            ws.close();
          } catch {
            /* ignore */
          }
        });
    };

    ws.onmessage = (event: { data: string | Buffer | ArrayBuffer }) => {
      const data = event.data;

      if (noiseAwait !== null) {
        if (typeof data === 'string') {
          try {
            ws.close();
          } catch {
            /* ignore */
          }
          return;
        }
        const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
        if (noiseAwait === 'msg1') {
          void (async () => {
            try {
              if (!noiseOpt) return;
              noisePeer = await createNoiseXxResponder(noiseOpt.staticKeyPair, noisePrologue);
              noisePeer.recv(buf);
              ws.send(noisePeer.send());
              noiseAwait = 'msg3';
            } catch {
              try {
                ws.close();
              } catch {
                /* ignore */
              }
            }
          })();
          return;
        }
        if (noiseAwait === 'msg3') {
          void (async () => {
            try {
              if (!noisePeer) {
                try {
                  ws.close();
                } catch {
                  /* ignore */
                }
                return;
              }
              noisePeer.recv(buf);
              if (!noisePeer.complete) {
                try {
                  ws.close();
                } catch {
                  /* ignore */
                }
                return;
              }
              const mat = getNoiseXxPeerCryptoMaterial(noisePeer);
              noiseCodec = new NoiseJsonRpcCodec(mat.sendKey, mat.recvKey);
              noiseAwait = null;
              noisePeer = null;
              authState = wsAuth ? 'awaiting_handshake' : 'authed';
              flushPendingQueue();
            } catch {
              try {
                ws.close();
              } catch {
                /* ignore */
              }
            }
          })();
          return;
        }
      }

      if (noiseCodec) {
        if (typeof data === 'string') {
          try {
            ws.close();
          } catch {
            /* ignore */
          }
          return;
        }
        const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
        let text: string;
        try {
          text = noiseCodec.decrypt(buf);
        } catch {
          sendRpc({
            jsonrpc: '2.0',
            error: { code: -32700, message: 'noise: decrypt failed' },
            id: null,
          });
          return;
        }
        dispatchRawMessage(text);
        return;
      }

      const raw = typeof data === 'string'
        ? data
        : Buffer.isBuffer(data)
        ? data.toString()
        : String(data);
      dispatchRawMessage(raw);
    };
  });

  return server;
}
