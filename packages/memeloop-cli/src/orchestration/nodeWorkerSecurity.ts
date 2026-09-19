import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, type KeyObject, sign, timingSafeEqual, verify } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import {
  type ControlStore,
  type ControlStoreActor,
  decodeBase64,
  OrchestrationError,
  WORKER_PROTOCOL_VERSION,
  WORKER_SESSION_API_VERSION,
  WORKER_SESSION_KIND,
  type WorkerGatewaySession,
  type WorkerProtocolReplayProtector,
  type WorkerSessionResource,
  type WorkerSessionSpec,
  type WorkerSessionStatus,
} from 'memeloop';

const MAX_RECENT_NONCES = 64;

export interface NodeWorkerGatewayKeyPair {
  publicKey: string;
  publicKeyFingerprint: string;
  sign(message: Uint8Array): string;
}

function decodeBase64Url(value: string): Buffer {
  return Buffer.from(decodeBase64(value, {
    variant: 'url',
    padding: 'optional',
    allowEmpty: false,
  }));
}

/** Hash a high-entropy, single-use bootstrap token for ControlStore storage. */
export function hashWorkerBootstrapToken(token: string): string {
  if (Buffer.byteLength(token, 'utf8') < 32) {
    throw new OrchestrationError({
      code: 'INVALID',
      message: 'worker bootstrap tokens must contain at least 32 bytes of entropy',
      retryable: false,
    });
  }
  return `sha256:${createHash('sha256').update(token, 'utf8').digest('base64url')}`;
}

/** Constant-time comparison against a persisted bootstrap-token hash. */
export function verifyWorkerBootstrapToken(token: string, expectedHash: string): boolean {
  let actual: Buffer;
  let expected: Buffer;
  try {
    actual = decodeBase64Url(hashWorkerBootstrapToken(token).slice('sha256:'.length));
    expected = decodeBase64Url(expectedHash.replace(/^sha256:/, ''));
  } catch {
    return false;
  }
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** Domain-separated bytes signed during one-time worker enrollment. */
export function workerBootstrapProofMessage(enrollmentName: string, bootstrapToken: string): Uint8Array {
  return new TextEncoder().encode(
    `memeloop-worker-bootstrap-v1\n${enrollmentName}\n${bootstrapToken}`,
  );
}

/** Fingerprint an encoded Ed25519 SPKI public key. */
export function fingerprintWorkerPublicKey(workerPublicKey: string): string {
  const der = decodeBase64Url(workerPublicKey);
  // Parsing rejects malformed/wrongly encoded keys before fingerprinting.
  const key = createPublicKey({ key: der, format: 'der', type: 'spki' });
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('worker key must be Ed25519');
  return `sha256:${createHash('sha256').update(der).digest('base64url')}`;
}

/** Verify an Ed25519 signature encoded as base64url. */
export function verifyWorkerEd25519Signature(
  workerPublicKey: string,
  message: Uint8Array,
  signature: string,
): boolean {
  try {
    const key = createPublicKey({
      key: decodeBase64Url(workerPublicKey),
      format: 'der',
      type: 'spki',
    });
    return key.asymmetricKeyType === 'ed25519' &&
      verify(null, message, key, decodeBase64Url(signature));
  } catch {
    return false;
  }
}

/**
 * Load or create the daemon's pinned Ed25519 worker-gateway identity.
 * Corruption is fail-closed: silently rotating this key would invalidate
 * every external bootstrap descriptor and enable unexpected impersonation.
 */
export function loadOrCreateWorkerGatewayKeyPair(dataDirectory: string): NodeWorkerGatewayKeyPair {
  fs.mkdirSync(dataDirectory, { recursive: true, mode: 0o700 });
  const keyPath = path.join(dataDirectory, 'worker-gateway-ed25519.pk8');
  let privateKey: KeyObject;
  try {
    const der = fs.readFileSync(keyPath);
    privateKey = createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code !== 'ENOENT') {
      throw new Error(`worker gateway identity at '${keyPath}' is unreadable or invalid`);
    }
    const generated = generateKeyPairSync('ed25519');
    const der = generated.privateKey.export({ format: 'der', type: 'pkcs8' });
    try {
      fs.writeFileSync(keyPath, der, { mode: 0o600, flag: 'wx' });
      privateKey = generated.privateKey;
    } catch (writeError) {
      if (!(writeError instanceof Error) || !('code' in writeError) || writeError.code !== 'EEXIST') {
        throw writeError;
      }
      privateKey = createPrivateKey({
        key: fs.readFileSync(keyPath),
        format: 'der',
        type: 'pkcs8',
      });
    }
  }
  if (privateKey.asymmetricKeyType !== 'ed25519') {
    throw new Error(`worker gateway identity at '${keyPath}' is not Ed25519`);
  }
  const publicKey = Buffer.from(
    createPublicKey(privateKey).export({
      format: 'der',
      type: 'spki',
    }),
  ).toString('base64url');
  return {
    publicKey,
    publicKeyFingerprint: fingerprintWorkerPublicKey(publicKey),
    sign: (message) => sign(null, message, privateKey).toString('base64url'),
  };
}

/**
 * Durable sequence/nonce fence backed by WorkerSession.status CAS.
 * A gateway restart retains the last accepted sequence; uncertainty or a
 * concurrent duplicate fails closed.
 */
export function createControlStoreWorkerReplayProtector(
  store: ControlStore,
  actor: ControlStoreActor,
): WorkerProtocolReplayProtector {
  return {
    async consume(sessionName, sequence, nonce) {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const resource = await store.get<WorkerSessionSpec>({
          apiVersion: WORKER_SESSION_API_VERSION,
          kind: WORKER_SESSION_KIND,
          name: sessionName,
        }) as WorkerSessionResource | null;
        if (!resource) return false;
        const status = resource.status;
        const lastSequence = status?.lastSequence ?? 0;
        const recentNonces = status?.recentNonces ?? [];
        if (sequence !== lastSequence + 1 || recentNonces.includes(nonce)) return false;
        const nextStatus: WorkerSessionStatus = {
          ...status,
          lastSequence: sequence,
          recentNonces: [...recentNonces, nonce].slice(-MAX_RECENT_NONCES),
          lastProofAt: new Date().toISOString(),
        };
        try {
          await store.updateStatus(
            actor,
            {
              apiVersion: WORKER_SESSION_API_VERSION,
              kind: WORKER_SESSION_KIND,
              name: sessionName,
            },
            nextStatus,
            { resourceVersion: resource.metadata.resourceVersion },
          );
          return true;
        } catch (error) {
          if (!(error instanceof OrchestrationError) || error.code !== 'CONFLICT') throw error;
        }
      }
      return false;
    },
  };
}

/** Resolve only active, fully scoped worker sessions for the protocol gateway. */
export async function resolveControlStoreWorkerGatewaySession(
  store: ControlStore,
  sessionName: string,
): Promise<WorkerGatewaySession | undefined> {
  const resource = await store.get<WorkerSessionSpec>({
    apiVersion: WORKER_SESSION_API_VERSION,
    kind: WORKER_SESSION_KIND,
    name: sessionName,
  }) as WorkerSessionResource | null;
  if (!resource || resource.status?.phase !== 'Active' || !resource.status.expiresAt) return undefined;
  return {
    name: resource.metadata.name,
    workerKeyFingerprint: resource.spec.workerKeyFingerprint,
    workerPublicKey: resource.spec.workerPublicKey,
    audience: resource.spec.audience,
    protocol: resource.spec.allowedProtocol === WORKER_PROTOCOL_VERSION
      ? WORKER_PROTOCOL_VERSION
      : resource.spec.allowedProtocol as typeof WORKER_PROTOCOL_VERSION,
    expiresAt: resource.status.expiresAt,
    revoked: false,
    run: resource.spec.run,
    policyDigest: resource.spec.policyDigest,
    allowedMethods: resource.spec.allowedMethods,
    ...(resource.spec.allowedTargets ? { allowedTargets: resource.spec.allowedTargets } : {}),
  };
}
