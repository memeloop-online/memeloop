#!/usr/bin/env node
import { build } from 'esbuild';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const root = resolve(import.meta.dirname, '..');
const packageRoot = resolve(root, 'packages/memeloop-libp2p');
const packageRequire = createRequire(resolve(packageRoot, 'package.json'));
const { multiaddr } = await import(pathToFileURL(packageRequire.resolve('@multiformats/multiaddr')).href);

const libp2pBundle = await build({
  absWorkingDir: packageRoot,
  entryPoints: ['dist/browser.bundle.js'],
  bundle: true,
  format: 'esm',
  logLevel: 'warning',
  platform: 'browser',
  write: false,
});
if (libp2pBundle.warnings.length > 0) {
  throw new Error('@memeloop/libp2p/browser emitted bundler warnings');
}

const mobileBundle = await build({
  absWorkingDir: packageRoot,
  entryPoints: ['../memeloop/src/mobile.ts'],
  bundle: true,
  format: 'esm',
  logLevel: 'warning',
  platform: 'browser',
  write: false,
});
if (mobileBundle.warnings.length > 0) {
  throw new Error('memeloop/mobile emitted bundler warnings');
}

// Hermes provides random bytes but no WebCrypto subtle API.
const originalCrypto = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
const nativeCrypto = { getRandomValues: globalThis.crypto.getRandomValues.bind(globalThis.crypto) };
Object.defineProperty(globalThis, 'crypto', { configurable: true, value: nativeCrypto });
const browserRuntime = await import(
  pathToFileURL(resolve(packageRoot, 'dist/browser.bundle.js')).href
);
if (typeof browserRuntime.Libp2pDeviceNetworkService !== 'function') {
  throw new Error('@memeloop/libp2p/browser runtime service export is missing');
}
if (typeof browserRuntime.createDeviceIdentity !== 'function') {
  throw new Error('@memeloop/libp2p/browser runtime identity export is missing');
}
const identity = await browserRuntime.createDeviceIdentity('desktop', 'browser-runtime-smoke');
if (!identity.peerId || !identity.publicKeyMultibase) {
  throw new Error('@memeloop/libp2p/browser identity runtime smoke failed');
}

// React Native has neither browser tabs nor BroadcastChannel. Exercise the
// published browser entry's actual peer-store mutex, not a mocked lock.
const originalChannel = Object.getOwnPropertyDescriptor(globalThis, 'BroadcastChannel');
const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
delete globalThis.BroadcastChannel;
delete globalThis.document;
const service = new browserRuntime.Libp2pDeviceNetworkService({
  identity,
  enableCircuitRelay: false,
  listen: { addresses: [], announce: [] },
});
try {
  await service.start();
  const node = Reflect.get(service, 'libp2p');
  await node.peerStore.merge(node.peerId, { metadata: { nativeLockProbe: new Uint8Array([42]) } });
  const peer = await node.peerStore.get(node.peerId);
  if (peer.metadata.get('nativeLockProbe')?.[0] !== 42) throw new Error('Native single-process peer-store lock failed');
} finally {
  await service.stop();
  if (originalChannel) Object.defineProperty(globalThis, 'BroadcastChannel', originalChannel);
  if (originalDocument) Object.defineProperty(globalThis, 'document', originalDocument);
}

// React Native's WebSocket has no bufferedAmount. Exercise the actual bundled
// transport and encrypted pairing against a real Node peer.
const nodeRuntime = await import(pathToFileURL(resolve(packageRoot, 'dist/index.js')).href);
const remoteIdentity = await nodeRuntime.createDeviceIdentity('desktop', 'native-websocket-peer');
const remote = new nodeRuntime.Libp2pDeviceNetworkService({
  identity: remoteIdentity,
  enableMdns: false,
  enableCircuitRelay: false,
  listen: { addresses: ['/ip4/127.0.0.1/tcp/0/ws'], announce: [] },
  rpcHandler: async ({ remotePeerId, method }) => ({ remotePeerId, method }),
});
const originalWebSocket = globalThis.WebSocket;
let nativeSocketCount = 0;
class NativeShapeWebSocket extends originalWebSocket {
  constructor(...args) {
    super(...args);
    nativeSocketCount += 1;
  }
  get bufferedAmount() { return undefined; }
}
globalThis.WebSocket = NativeShapeWebSocket;
const nativeClient = new browserRuntime.Libp2pDeviceNetworkService({
  identity,
  enableCircuitRelay: false,
  listen: { addresses: [], announce: [] },
});
let restoredClient;
try {
  await remote.start();
  await nativeClient.start();
  const session = await nativeClient.requestLocalPairing(remoteIdentity.peerId, {
    multiaddrs: [`/ip4/127.0.0.1/tcp/1/ws/p2p/${remoteIdentity.peerId}`, ...remote.getMultiaddrs()],
    signal: AbortSignal.timeout(15_000),
  });
  const inbound = (await remote.listPairingSessions()).find(candidate => candidate.sessionId === session.sessionId);
  if (!inbound || inbound.confirmCode !== session.confirmCode) throw new Error('Native-shaped WebSocket pairing failed');
  await remote.acceptPairing(session.sessionId);
  await nativeClient.acceptPairing(session.sessionId);
  const clientNode = Reflect.get(nativeClient, 'libp2p');
  const connections = clientNode.getConnections();
  const connection = connections.find(candidate => candidate.remotePeer.toString() === remoteIdentity.peerId);
  if (!connection) throw new Error('Pairing did not retain the authenticated connection');
  const pairedSocketCount = nativeSocketCount;
  // Bootstrap/identify report raw addresses. Even if all newly advertised
  // routes are unreachable, an existing authenticated connection must win.
  clientNode.dispatchEvent(new CustomEvent('peer:discovery', {
    detail: {
      id: connection.remotePeer,
      multiaddrs: [
        multiaddr('/ip4/192.0.2.1/tcp/9/ws'),
        multiaddr('/ip4/127.0.0.1/tcp/1/ws'),
      ],
    },
  }));
  const reply = await nativeClient.sendRpc(remoteIdentity.peerId, 'memeloop.agent.getDefinitions', {}, {
    signal: AbortSignal.timeout(15_000),
  });
  if (reply.remotePeerId !== identity.peerId || reply.method !== 'memeloop.agent.getDefinitions') {
    throw new Error('Reconnected RPC did not reach the authenticated peer');
  }
  if (!clientNode.getConnections().includes(connection)) throw new Error('RPC did not reuse the paired connection');
  if (nativeSocketCount !== pairedSocketCount) throw new Error('RPC redialed unreachable discovery addresses');
  const successfulAddress = connection.remoteAddr.toString();
  if (session.remoteMultiaddrs[0] !== successfulAddress) throw new Error('Pairing did not retain its successful route first');

  // Identify can replace the address book with advertised routes that are not
  // reachable from this client. Host restart must still use the proven route.
  Reflect.get(remote, 'options').listen.addresses = [successfulAddress.replace(/\/p2p\/[^/]+$/u, '')];
  await clientNode.hangUp(connection.remotePeer);
  await remote.stop();
  await remote.start();
  await clientNode.peerStore.patch(connection.remotePeer, { multiaddrs: [multiaddr('/ip4/192.0.2.1/tcp/9')] });
  const beforeReconnect = nativeSocketCount;
  await nativeClient.sendRpc(remoteIdentity.peerId, 'memeloop.agent.getDefinitions', {}, { signal: AbortSignal.timeout(5_000) });
  if (nativeSocketCount !== beforeReconnect + 1) throw new Error('Reconnect tried an unproven route before the successful pairing route');

  // A new phone process restores exactly the addresses hosts persist from the
  // pairing session, with unreachable advertised routes still present.
  await nativeClient.stop();
  restoredClient = new browserRuntime.Libp2pDeviceNetworkService({
    identity,
    enableCircuitRelay: false,
    listen: { addresses: [], announce: [] },
    bootstrapMultiaddrs: [
      ...session.remoteMultiaddrs.map(address => address.endsWith(`/p2p/${remoteIdentity.peerId}`) ? address : `${address}/p2p/${remoteIdentity.peerId}`),
      `/ip4/192.0.2.1/tcp/9/ws/p2p/${remoteIdentity.peerId}`,
    ],
    trustedDevices: [{
      peerId: remoteIdentity.peerId, publicKeyMultibase: remoteIdentity.publicKeyMultibase,
      deviceName: 'native-websocket-peer', platform: 'desktop', trustMode: 'local-pairing', createdAt: Date.now(),
    }],
  });
  await restoredClient.start();
  const beforeRestored = nativeSocketCount;
  await restoredClient.sendRpc(remoteIdentity.peerId, 'memeloop.agent.getDefinitions', {}, { signal: AbortSignal.timeout(5_000) });
  if (nativeSocketCount !== beforeRestored + 1) throw new Error('Restored pairing route did not retain priority');
} finally {
  try {
    await restoredClient?.stop();
    await nativeClient.stop();
  } finally {
    try {
      await remote.stop();
    } finally {
      globalThis.WebSocket = originalWebSocket;
      Object.defineProperty(globalThis, 'crypto', originalCrypto);
    }
  }
}

console.log(
  '@memeloop/libp2p/browser runs and both browser surfaces bundle with zero warnings or Node built-ins.',
);
