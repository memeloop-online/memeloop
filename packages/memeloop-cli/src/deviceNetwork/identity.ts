import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createDeviceIdentity, type LocalDeviceIdentity, signDeviceBinding as coreSignDeviceBinding } from 'memeloop';

export interface CliDeviceIdentity extends LocalDeviceIdentity {
  privateKeyRawSeedBase64Url: string;
}

export function getDefaultDeviceIdentityPath(): string {
  return path.join(os.homedir(), '.memeloop', 'device-identity.json');
}

function isValidStoredIdentity(value: unknown): value is CliDeviceIdentity {
  const record = value as Record<string, unknown> | undefined;
  if (!record) return false;
  return (
    typeof record.peerId === 'string' &&
    typeof record.publicKeyMultibase === 'string' &&
    typeof record.privateKeyRawSeedBase64Url === 'string' &&
    typeof record.deviceName === 'string' &&
    typeof record.platform === 'string'
  );
}

export async function loadOrCreateDeviceIdentity(
  identityPath = getDefaultDeviceIdentityPath(),
  deviceName = os.hostname(),
): Promise<CliDeviceIdentity> {
  if (fs.existsSync(identityPath)) {
    const stored = JSON.parse(fs.readFileSync(identityPath, 'utf-8')) as unknown;
    if (isValidStoredIdentity(stored)) {
      return stored;
    }
  }
  const identity = await createDeviceIdentity('cli', deviceName);
  const cliIdentity: CliDeviceIdentity = {
    ...identity,
    privateKeyRawSeedBase64Url: identity.privateKeyRawSeedBase64Url,
  };
  fs.mkdirSync(path.dirname(identityPath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(identityPath, `${JSON.stringify(cliIdentity, null, 2)}\n`, { mode: 0o600 });
  return cliIdentity;
}

export async function signDeviceBinding(input: {
  identity: CliDeviceIdentity;
  accountId: string;
  nonce: string;
}): Promise<string> {
  return coreSignDeviceBinding({
    identity: input.identity,
    accountId: input.accountId,
    nonce: input.nonce,
  });
}
