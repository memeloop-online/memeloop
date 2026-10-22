#!/usr/bin/env node
import { build } from 'esbuild';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = resolve(import.meta.dirname, '..');
const packageRoot = resolve(root, 'packages/memeloop-libp2p');

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
});
const originalWebSocket = globalThis.WebSocket;
class NativeShapeWebSocket extends originalWebSocket {
  get bufferedAmount() { return undefined; }
}
globalThis.WebSocket = NativeShapeWebSocket;
const nativeClient = new browserRuntime.Libp2pDeviceNetworkService({
  identity,
  enableCircuitRelay: false,
  listen: { addresses: [], announce: [] },
});
try {
  await remote.start();
  await nativeClient.start();
  const session = await nativeClient.requestLocalPairing(remoteIdentity.peerId, {
    multiaddrs: remote.getMultiaddrs(),
    signal: AbortSignal.timeout(15_000),
  });
  const inbound = (await remote.listPairingSessions()).find(candidate => candidate.sessionId === session.sessionId);
  if (!inbound || inbound.confirmCode !== session.confirmCode) throw new Error('Native-shaped WebSocket pairing failed');
} finally {
  try {
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
