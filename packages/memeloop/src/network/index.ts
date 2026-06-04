/**
 * WebSocket + JSON-RPC 2.0 transport: ConnectionManager, MessageRouter, auth.
 */

export { ConnectionManager } from './connectionManager.js';
export type { ConnectionManagerOptions, ConnectionState } from './connectionManager.js';

export { MessageRouter } from './messageRouter.js';
export type { MessageRouterOptions, NotificationHandler } from './messageRouter.js';

export { buildAuthHandshakeMessage, parseAuthHandshakeMessage } from './authHandshake.js';
export type { ParsedHandshake } from './authHandshake.js';

export { createPairingToken, generatePin, verifyPairingToken } from './pinPairing.js';

export { browse, MEMELOOP_SERVICE_TYPE, register } from './lanDiscovery.js';
export type { LanDiscoveryBrowseOptions, LanDiscoveryRegisterOptions, MemeloopServiceInfo } from './lanDiscovery.js';

export { ConnectivityManager, detectPublicIP, resolveConnectAddress } from './connectivity.js';
export type { ConnectivityState, FrpTunnelOptions, FrpTunnelStop } from './connectivity.js';

export { createGitProxyHandler, createNodeServer } from './nodeServer.js';

export { decryptNoiseFrame, encryptNoiseFrame, NoiseJsonRpcCodec } from './noiseTransport.js';

export {
  completeNoiseXxHandshake,
  createNoiseXxInitiator,
  createNoiseXxResponder,
  generateX25519KeyPairForNoise,
  getNoiseXxPeerCryptoMaterial,
  MEMELOOP_NOISE_PROLOGUE_V1,
} from './noiseXxHandshake.js';
export type { NoiseStaticKeyPair, NoiseXxHandshakePeer, NoiseXxHandshakeResult } from './noiseXxHandshake.js';

export { getDefaultKnownNodesPath, loadKnownNodes, removeKnownNode, saveKnownNodes, trustMatchesStored, upsertKnownNode } from './knownNodesStore.js';
export type { CreateNodeServerOptions, ImWebhookHandler, NodeGitHandler, NodeRpcContext, NodeRpcHandler, WsAuthOptions } from './nodeServer.js';
export { computePinConfirmCode, verifyPinConfirmCode } from './pinConfirmCode.js';
