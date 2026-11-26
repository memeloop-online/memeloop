import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { LocalDeviceIdentity } from 'memeloop';

import { createDeviceIdentity, signDeviceBinding as coreSignDeviceBinding } from '@memeloop/libp2p';

const DEVICE_IDENTITY_KEYRING_SERVICE = 'memeloop-cli/device-identity';
const KEYRING_REFERENCE_PREFIX = 'keyring:';
const warnedPlaintextPaths = new Set<string>();

export interface CliDeviceIdentity extends LocalDeviceIdentity {
  privateKeyRawSeedBase64Url: string;
}

interface StoredCliDeviceIdentity extends Omit<CliDeviceIdentity, 'privateKeyRawSeedBase64Url'> {
  privateKeyRawSeedBase64Url?: string;
}

export interface DeviceIdentitySecretStore {
  get(account: string): Promise<string | undefined>;
  set(account: string, value: string): Promise<void>;
}

export interface LoadOrCreateDeviceIdentityOptions {
  /** Override the OS keyring adapter. `null` explicitly disables keyring use. */
  secretStore?: DeviceIdentitySecretStore | null;
  warn?: (message: string) => void;
}

interface AsyncKeyringEntry {
  getPassword(): Promise<string | undefined>;
  setPassword(password: string): Promise<void>;
}

interface KeyringModule {
  AsyncEntry: new(service: string, account: string) => AsyncKeyringEntry;
}

export function getDefaultDeviceIdentityPath(): string {
  return path.join(os.homedir(), '.memeloop', 'device-identity.json');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isValidStoredIdentity(value: unknown): value is StoredCliDeviceIdentity {
  if (!isRecord(value)) return false;
  const record = value;
  const hasSeed = typeof record.privateKeyRawSeedBase64Url === 'string' &&
    record.privateKeyRawSeedBase64Url.length > 0;
  const hasKeyringReference = typeof record.privateKeyRef === 'string' &&
    record.privateKeyRef.startsWith(KEYRING_REFERENCE_PREFIX) &&
    record.privateKeyRef.length > KEYRING_REFERENCE_PREFIX.length;
  return (
    typeof record.peerId === 'string' &&
    typeof record.publicKeyMultibase === 'string' &&
    typeof record.privateKeyRef === 'string' &&
    typeof record.deviceName === 'string' &&
    typeof record.platform === 'string' &&
    (hasSeed || hasKeyringReference)
  );
}

function keyringAccount(identityPath: string): string {
  const fingerprint = createHash('sha256').update(path.resolve(identityPath)).digest('hex');
  return `device-${fingerprint.slice(0, 32)}`;
}

function keyringReference(account: string): string {
  return `${KEYRING_REFERENCE_PREFIX}${account}`;
}

function accountFromKeyringReference(reference: string): string | undefined {
  if (!reference.startsWith(KEYRING_REFERENCE_PREFIX)) return undefined;
  const account = reference.slice(KEYRING_REFERENCE_PREFIX.length);
  return account || undefined;
}

function isKeyringModule(value: unknown): value is KeyringModule {
  return isRecord(value) && typeof value.AsyncEntry === 'function';
}

async function loadSystemSecretStore(): Promise<DeviceIdentitySecretStore | undefined> {
  try {
    const imported: unknown = await import('@napi-rs/keyring');
    if (!isKeyringModule(imported)) return undefined;
    const keyring = imported;
    return {
      get: async (account) =>
        await new keyring.AsyncEntry(
          DEVICE_IDENTITY_KEYRING_SERVICE,
          account,
        ).getPassword(),
      set: async (account, value) => {
        await new keyring.AsyncEntry(
          DEVICE_IDENTITY_KEYRING_SERVICE,
          account,
        ).setPassword(value);
      },
    };
  } catch {
    return undefined;
  }
}

function writeStoredIdentity(identityPath: string, identity: StoredCliDeviceIdentity): void {
  fs.mkdirSync(path.dirname(identityPath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(identityPath, `${JSON.stringify(identity, null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(identityPath, 0o600);
}

function warnPlaintextFallback(
  identityPath: string,
  warn: (message: string) => void,
): void {
  const resolvedPath = path.resolve(identityPath);
  if (warnedPlaintextPaths.has(resolvedPath)) return;
  warnedPlaintextPaths.add(resolvedPath);
  warn(
    '[memeloop-cli] OS keyring unavailable; the device identity seed is stored in a 0600 file. ' +
      'Use a private OS account and restrict access to the MemeLoop data directory.',
  );
}

function publicIdentity(
  identity: CliDeviceIdentity,
  account: string,
): StoredCliDeviceIdentity {
  const { privateKeyRawSeedBase64Url: _seed, ...stored } = identity;
  return { ...stored, privateKeyRef: keyringReference(account) };
}

async function storeInKeyring(
  identityPath: string,
  identity: CliDeviceIdentity,
  secretStore: DeviceIdentitySecretStore | undefined,
): Promise<CliDeviceIdentity | undefined> {
  if (!secretStore) return undefined;
  const account = keyringAccount(identityPath);
  try {
    await secretStore.set(account, identity.privateKeyRawSeedBase64Url);
    const stored = publicIdentity(identity, account);
    writeStoredIdentity(identityPath, stored);
    return { ...stored, privateKeyRawSeedBase64Url: identity.privateKeyRawSeedBase64Url };
  } catch {
    return undefined;
  }
}

export async function loadOrCreateDeviceIdentity(
  identityPath = getDefaultDeviceIdentityPath(),
  deviceName = os.hostname(),
  options: LoadOrCreateDeviceIdentityOptions = {},
): Promise<CliDeviceIdentity> {
  const warn = options.warn ?? console.warn;
  const secretStore = options.secretStore === undefined
    ? await loadSystemSecretStore()
    : options.secretStore ?? undefined;
  if (fs.existsSync(identityPath)) {
    const stored = JSON.parse(fs.readFileSync(identityPath, 'utf-8')) as unknown;
    if (!isValidStoredIdentity(stored)) {
      throw new Error('invalid MemeLoop device identity file');
    }
    fs.chmodSync(identityPath, 0o600);
    if (typeof stored.privateKeyRawSeedBase64Url === 'string' && stored.privateKeyRawSeedBase64Url.length > 0) {
      const plaintextIdentity: CliDeviceIdentity = {
        ...stored,
        privateKeyRawSeedBase64Url: stored.privateKeyRawSeedBase64Url,
      };
      const migrated = await storeInKeyring(identityPath, plaintextIdentity, secretStore);
      if (migrated) return migrated;
      warnPlaintextFallback(identityPath, warn);
      return plaintextIdentity;
    }
    const account = accountFromKeyringReference(stored.privateKeyRef);
    let seed: string | undefined;
    try {
      seed = account ? await secretStore?.get(account) : undefined;
    } catch {
      warn('[memeloop-cli] OS keyring read failed; the device identity keyring entry is unavailable');
    }
    if (!seed) {
      throw new Error(
        'MemeLoop device identity keyring entry is unavailable; unlock or restore the OS keyring',
      );
    }
    return { ...stored, privateKeyRawSeedBase64Url: seed };
  }

  const identity = await createDeviceIdentity('cli', deviceName);
  const cliIdentity: CliDeviceIdentity = {
    ...identity,
    privateKeyRawSeedBase64Url: identity.privateKeyRawSeedBase64Url,
  };
  const keyringIdentity = await storeInKeyring(identityPath, cliIdentity, secretStore);
  if (keyringIdentity) return keyringIdentity;
  writeStoredIdentity(identityPath, cliIdentity);
  warnPlaintextFallback(identityPath, warn);
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
