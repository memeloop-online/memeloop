/**
 * Node server: delegates to local nodeServerImpl; adds startNodeServerWithMdns (listen + mDNS).
 */

import type { NoiseStaticKeyPair } from "memeloop";
import http from "node:http";
import type { ImWebhookHandler, NodeGitHandler, WsAuthOptions } from "./nodeServerImpl";

import { register } from "./lanDiscovery";
import { createNodeServer as createNodeServerFromImpl } from "./nodeServerImpl";
import { handleRpc, type RpcHandlerContext } from "./rpcHandlers";

export interface NodeServerOptions {
  port: number;
  nodeId: string;
  rpcContext: RpcHandlerContext;
  /** Git handler: either a direct NodeGitHandler or getBackendUrl + verifyAuth for HTTP reverse proxy. If not set, /git/* is 404. */
  gitProxy?:
    | NodeGitHandler
    | {
        getBackendUrl(wikiId: string): Promise<string | null> | null;
        verifyAuth(authHeader: string | undefined): Promise<boolean>;
      };
  /** mDNS service name */
  serviceName?: string;
  /** WebSocket: require memeloop.auth.handshake first and verify credentials */
  wsAuth?: WsAuthOptions;
  /** POST /im/webhook/<channelId> */
  imWebhookHandler?: ImWebhookHandler;
  /** P2P：Noise_XX + ChaCha 帧加密（与 CLI 默认 keypair 一致）。 */
  noise?: {
    staticKeyPair: NoiseStaticKeyPair;
    prologue?: Buffer;
  };
}

export function createNodeServer(options: NodeServerOptions): http.Server {
  const { nodeId, rpcContext, gitProxy, wsAuth, imWebhookHandler, noise } = options;
  return createNodeServerFromImpl({
    nodeId,
    rpcHandler: (method, parameters, wsContext) =>
      handleRpc(
        {
          ...rpcContext,
          notify: wsContext?.notify,
          pinConfirmState: wsContext?.pinConfirmState,
        },
        method,
        parameters,
      ),
    gitHandler: gitProxy,
    wsAuth,
    imWebhookHandler,
    noise,
  });
}

export async function startNodeServerWithMdns(options: NodeServerOptions): Promise<http.Server> {
  const server = createNodeServer(options);
  await new Promise<void>((resolve, reject) => {
    server
      .listen(options.port, () => {
        resolve();
      })
      .on("error", reject);
  });
  if (process.env.NODE_ENV === "test" || process.env.MEMELOOP_DISABLE_MDNS === "1") {
    return server;
  }
  try {
    register({
      name: options.serviceName ?? "memeloop-cli",
      port: options.port,
      nodeId: options.nodeId,
    });
  } catch {
    // mDNS optional
  }
  return server;
}
