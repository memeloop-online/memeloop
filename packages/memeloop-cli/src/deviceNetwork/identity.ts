import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { DevicePlatform, LocalDeviceIdentity } from 'memeloop';

export interface CliDeviceIdentity extends LocalDeviceIdentity {
  privateKeyPkcs8Base64Url: string;
}

export function getDefaultDeviceIdentityPath(): string {
  return path.join(os.homedir(), '.memeloop', 'device-identity.json');
}

function peerIdFromPublicKey(publicKeyDer: Buffer): string {
  return `peer:${createHash('sha256').update(publicKeyDer).digest('base64url')}`;
}

function createDeviceIdentity(deviceName: string, platform: DevicePlatform): CliDeviceIdentity {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const publicKeyDer = publicKey.export({ format: 'der', type: 'spki' }) as Buffer;
  const privateKeyDer = privateKey.export({ format: 'der', type: 'pkcs8' }) as Buffer;
  const peerId = peerIdFromPublicKey(publicKeyDer);
  return {
    peerId,
    publicKeyMultibase: `spki:${publicKeyDer.toString('base64url')}`,
    privateKeyRef: 'local-pkcs8',
    privateKeyPkcs8Base64Url: privateKeyDer.toString('base64url'),
    createdAt: Date.now(),
    deviceName,
    platform,
  };
}

export function loadOrCreateDeviceIdentity(identityPath = getDefaultDeviceIdentityPath(), deviceName = os.hostname()): CliDeviceIdentity {
  if (fs.existsSync(identityPath)) {
    return JSON.parse(fs.readFileSync(identityPath, 'utf-8')) as CliDeviceIdentity;
  }
  const identity = createDeviceIdentity(deviceName, 'cli');
  fs.mkdirSync(path.dirname(identityPath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(identityPath, `${JSON.stringify(identity, null, 2)}\n`, { mode: 0o600 });
  return identity;
}

export function signDeviceBinding(input: {
  identity: CliDeviceIdentity;
  accountId: string;
  nonce: string;
}): string {
  const privateKey = createPrivateKey({
    key: Buffer.from(input.identity.privateKeyPkcs8Base64Url, 'base64url'),
    format: 'der',
    type: 'pkcs8',
  });
  const publicKeyDer = createPublicKey(privateKey).export({ format: 'der', type: 'spki' }) as Buffer;
  if (`spki:${publicKeyDer.toString('base64url')}` !== input.identity.publicKeyMultibase) {
    throw new Error('device_identity_public_key_mismatch');
  }
  const message = Buffer.from(
    `memeloop-device-binding-v1\naccountId=${input.accountId}\npeerId=${input.identity.peerId}\npublicKey=${input.identity.publicKeyMultibase}\nnonce=${input.nonce}`,
  );
  return sign(null, message, privateKey).toString('base64url');
}
