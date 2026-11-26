import { createHash, randomBytes } from 'node:crypto';

import {
  type ArtifactManagementDriver,
  type ArtifactRecordManifest,
  canonicalDriverValue,
  createArtifactRecordManifest,
  DRIVER_REQUEST_API_VERSION,
  type DriverRequestEnvelope,
  OrchestrationError,
} from 'memeloop';

import type { ScriptArtifactStoreReader } from './scriptArtifactStore.js';

export interface ManagedScriptArtifactStoreOptions {
  driver: ArtifactManagementDriver;
  capabilityHandleRef: string;
  sessionId: string;
  actorId: string;
  /** Maximum script bytes this adapter will materialize for a runtime read. */
  maxArtifactBytes?: number;
  now?: () => Date;
}

export const SCRIPT_ARTIFACT_POLICY_DIGEST = `sha256:${
  createHash('sha256')
    .update('memeloop/script-runtime-artifact-policy/v1', 'utf8')
    .digest('hex')
}`;

function schemaDigest(method: string, fields: string[]): string {
  return `sha256:${
    createHash('sha256')
      .update(canonicalDriverValue({
        apiVersion: `drivers.memeloop.io/${method}/v1alpha1`,
        fields,
      }))
      .digest('hex')
  }`;
}

function identity(name: string): { resourceUid: string; contentHash: string } {
  const match = /^script-([a-f0-9]{64})$/.exec(name);
  if (!match) {
    throw new OrchestrationError({
      code: 'INVALID',
      message: 'managed script artifact name is not content addressed',
      retryable: false,
    });
  }
  return {
    resourceUid: `script-artifact:${match[1]}`,
    contentHash: `sha256:${match[1]}`,
  };
}

export function createManagedScriptArtifactStore(
  options: ManagedScriptArtifactStoreOptions,
): ScriptArtifactStoreReader {
  const now = options.now ?? (() => new Date());
  const maxArtifactBytes = options.maxArtifactBytes ?? 1_048_576;
  if (!Number.isSafeInteger(maxArtifactBytes) || maxArtifactBytes <= 0) {
    throw new OrchestrationError({
      code: 'INVALID',
      message: 'managed script artifact maxArtifactBytes must be a positive safe integer',
      retryable: false,
    });
  }

  function request<T>(
    method: string,
    payload: T,
    name: string,
    suffix: string,
    fields: string[],
  ): DriverRequestEnvelope<T> {
    const { resourceUid } = identity(name);
    return {
      apiVersion: DRIVER_REQUEST_API_VERSION,
      method,
      resource: {
        apiVersion: 'artifacts.memeloop.io/v1alpha1',
        kind: 'ArtifactRecord',
        name,
        uid: resourceUid,
        generation: 1,
      },
      fencingEpoch: 1,
      requestId: `${method}:${randomBytes(16).toString('hex')}`,
      idempotencyKey: `${resourceUid}:${suffix}`,
      deadline: new Date(now().getTime() + 60_000).toISOString(),
      actor: { id: options.actorId, kind: 'controller' },
      session: { id: options.sessionId },
      capabilityHandleRef: options.capabilityHandleRef,
      trace: {
        traceId: randomBytes(16).toString('hex'),
        spanId: randomBytes(8).toString('hex'),
      },
      payloadSchemaDigest: schemaDigest(method, fields),
      payload,
    };
  }

  async function readManaged(name: string): Promise<string | undefined> {
    const { contentHash } = identity(name);
    const resolved = await options.driver.resolve(request(
      'artifact.resolve',
      { contentHash },
      name,
      'resolve',
      ['contentHash'],
    ));
    if (!resolved) return undefined;
    if (
      resolved.quarantined ||
      !resolved.promotedDestinations.includes('volume')
    ) {
      throw new OrchestrationError({
        code: 'FORBIDDEN',
        message: `script artifact '${name}' is not promoted for runtime staging`,
        retryable: false,
      });
    }
    if (resolved.sizeBytes > maxArtifactBytes) {
      throw new OrchestrationError({
        code: 'EXHAUSTED',
        message: `script artifact '${name}' exceeds the runtime read limit`,
        retryable: false,
      });
    }
    const chunks: Uint8Array[] = [];
    let total = 0;
    for await (
      const chunk of options.driver.read(request(
        'artifact.read',
        { artifactHandle: resolved.artifactHandle },
        name,
        'read',
        ['artifactHandle'],
      ))
    ) {
      if (chunk.byteLength > maxArtifactBytes - total) {
        throw new OrchestrationError({
          code: 'EXHAUSTED',
          message: `script artifact '${name}' exceeded the runtime read limit`,
          retryable: false,
        });
      }
      chunks.push(chunk);
      total += chunk.byteLength;
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    if (total !== resolved.sizeBytes) {
      throw new OrchestrationError({
        code: 'CONFLICT',
        message: `script artifact '${name}' read size differs from its managed descriptor`,
        retryable: false,
      });
    }
    const actualHash = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
    if (actualHash !== resolved.contentHash) {
      throw new OrchestrationError({
        code: 'CONFLICT',
        message: `script artifact '${name}' read bytes differ from its managed content hash`,
        retryable: false,
      });
    }
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      throw new OrchestrationError({
        code: 'INVALID',
        message: `script artifact '${name}' is not valid UTF-8`,
        retryable: false,
      });
    }
  }

  return {
    async putArtifact(manifest: ArtifactRecordManifest, normalizedContent: string) {
      const name = manifest.metadata.name;
      if (!name) {
        throw new OrchestrationError({
          code: 'INVALID',
          message: 'script artifact manifest has no name',
          retryable: false,
        });
      }
      const bytes = new TextEncoder().encode(normalizedContent);
      const { contentHash } = identity(name);
      if (
        manifest.spec.contentHash !== contentHash ||
        manifest.spec.sizeBytes !== bytes.byteLength
      ) {
        throw new OrchestrationError({
          code: 'CONFLICT',
          message: 'script artifact manifest differs from its exact bytes',
          retryable: false,
        });
      }
      const artifact = await options.driver.put(
        request(
          'artifact.put',
          {
            expectedContentHash: contentHash,
            mimeType: manifest.spec.mimeType ?? 'text/javascript',
            trust: manifest.spec.trust,
            maxBytes: bytes.byteLength,
          },
          name,
          'put',
          [
            'expectedContentHash',
            'mimeType',
            'trust',
            'producerRunUid',
            'parentContentHashes',
            'maxBytes',
          ],
        ),
        {
          async *[Symbol.asyncIterator]() {
            yield bytes;
          },
        },
      );
      const reviewInput = {
        artifactHandle: artifact.artifactHandle,
        policyDigest: SCRIPT_ARTIFACT_POLICY_DIGEST,
        destinations: ['volume' as const],
      };
      const scan = await options.driver.scan(request(
        'artifact.scan',
        reviewInput,
        name,
        'scan',
        ['artifactHandle', 'policyDigest', 'destinations'],
      ));
      if (scan.outcome !== 'passed') {
        throw new OrchestrationError({
          code: 'FORBIDDEN',
          message: `script artifact '${name}' failed isolated scanning`,
          retryable: false,
        });
      }
      const verification = await options.driver.verify(request(
        'artifact.verify',
        {
          ...reviewInput,
          properties: ['content-hash-valid'],
        },
        name,
        'verify',
        ['artifactHandle', 'policyDigest', 'destinations', 'properties'],
      ));
      if (verification.outcome !== 'passed') {
        throw new OrchestrationError({
          code: 'FORBIDDEN',
          message: `script artifact '${name}' failed isolated verification`,
          retryable: false,
        });
      }
      await options.driver.promote(request(
        'artifact.promote',
        {
          artifactHandle: artifact.artifactHandle,
          destination: 'volume' as const,
        },
        name,
        'promote',
        ['artifactHandle', 'destination'],
      ));
    },
    readArtifactContent: readManaged,
    async readArtifactManifest(name) {
      const { contentHash } = identity(name);
      const resolved = await options.driver.resolve(request(
        'artifact.resolve',
        { contentHash },
        name,
        'resolve-manifest',
        ['contentHash'],
      ));
      if (!resolved) return undefined;
      return createArtifactRecordManifest(name, {
        contentHash: resolved.contentHash,
        sizeBytes: resolved.sizeBytes,
        mimeType: resolved.mimeType,
        trust: resolved.trust,
      });
    },
  };
}
