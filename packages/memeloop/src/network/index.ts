/**
 * WebSocket + JSON-RPC 2.0 transport: ConnectionManager, MessageRouter, auth.
 */

// Re-export protocol types (auth, node, rpc)
export * from './protocol.js';
export * from './terminalNotifications.js';
export * from './uri.js';

export { MessageRouter } from './messageRouter.js';
export type { MessageRouterOptions, NotificationHandler } from './messageRouter.js';

export { buildAuthHandshakeMessage, parseAuthHandshakeMessage } from './authHandshake.js';
export type { ParsedHandshake } from './authHandshake.js';

export { createPairingToken, generatePin, verifyPairingToken } from './pinPairing.js';

export { MEMELOOP_SERVICE_TYPE } from './lanDiscovery.js';
export type { LanDiscoveryBrowseOptions, LanDiscoveryRegisterOptions, MemeloopServiceInfo } from './lanDiscovery.js';

export { ConnectivityManager, detectPublicIP, resolveConnectAddress } from './connectivity.js';
export type { ConnectivityState, FrpTunnelOptions, FrpTunnelStop } from './connectivity.js';

export { gitProxyTargetBlockReason } from './gitProxyUrlPolicy.js';

export { InMemoryKnownNodesRepository, KnownNodesService, parseKnownNodesFile, serializeKnownNodesFile } from './knownNodesStore.js';
export type { KnownNodesFile, KnownNodesRepository } from './knownNodesStore.js';
export { computePinConfirmCode, verifyPinConfirmCode } from './pinConfirmCode.js';
