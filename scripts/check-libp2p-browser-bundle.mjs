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

console.log(
  '@memeloop/libp2p/browser runs and both browser surfaces bundle with zero warnings or Node built-ins.',
);
