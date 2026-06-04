/**
 * Node server type definitions.
 * The actual implementation (createNodeServer, createGitProxyHandler) lives in memeloop-cli.
 * These types define the contracts for the server transport adapter.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ParsedHandshake } from './authHandshake.js';
import type { NoiseStaticKeyPair } from './noiseXxHandshake.js';

/** Per-WebSocket 连接上下文：JSON-RPC handler 第三参数。 */
export type NodeRpcContext = {
  notify: (method: string, parameters: unknown) => void;
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
  rpcHandler: NodeRpcHandler;
  gitHandler?:
    | NodeGitHandler
    | {
      getBackendUrl(wikiId: string): Promise<string | null> | null;
      verifyAuth(authHeader: string | undefined): Promise<boolean>;
    };
  wsAuth?: WsAuthOptions;
  imWebhookHandler?: ImWebhookHandler;
  noise?: {
    staticKeyPair: NoiseStaticKeyPair;
    prologue?: Buffer;
  };
}
