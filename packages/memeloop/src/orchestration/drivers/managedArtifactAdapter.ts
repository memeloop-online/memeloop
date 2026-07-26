import type { ArtifactDestinationPolicy } from '../artifacts/artifactTrust.js';
import { OrchestrationError } from '../errors.js';

import {
  type ArtifactInspector,
  type ArtifactManagementCapabilities,
  type ArtifactManagementDriver,
  type ArtifactManagementStateSnapshot,
  createFakeArtifactManagementDriver,
  type FakeArtifactManagementState,
  snapshotArtifactManagementState,
} from './artifactManagement.js';
import type { DriverRequestEnvelope } from './driverRequest.js';

export interface ManagedArtifactDriverAdapterOptions {
  state: FakeArtifactManagementState;
  inspector: ArtifactInspector;
  authorizeRequest(request: DriverRequestEnvelope): boolean | Promise<boolean>;
  persistState(snapshot: ArtifactManagementStateSnapshot): Promise<void>;
  name: string;
  maxArtifactBytes?: number;
  inspectionIsolation: Exclude<
    ArtifactManagementCapabilities['inspectionIsolation'],
    'none'
  >;
  persistence: Exclude<ArtifactManagementCapabilities['persistence'], 'process'>;
  reviewer?: string;
  threatAssumptions: string[];
  now?: () => Date;
  destinationPolicies?: Partial<
    Record<
      import('../resources.js').ArtifactDestination,
      ArtifactDestinationPolicy
    >
  >;
}

function invalid(message: string): never {
  throw new OrchestrationError({ code: 'INVALID', message, retryable: false });
}

function exactFields(
  payload: unknown,
  allowed: readonly string[],
  location: string,
): void {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    invalid(`managed artifact ${location} must be an object`);
  }
  const unknown = Object.keys(payload).filter((field) => !allowed.includes(field));
  if (unknown.length > 0) {
    invalid(
      `managed artifact ${location} contains unsupported fields: ${unknown.join(', ')}`,
    );
  }
}

const ARTIFACT_DESTINATIONS = new Set([
  'prompt',
  'volume',
  'backup',
  'knowledge',
]);

function validateReviewPayload(payload: {
  policyDigest: string;
  destinations: unknown;
}): void {
  if (!/^sha256:[a-f0-9]{64}$/.test(payload.policyDigest)) {
    invalid('managed artifact policyDigest must be a canonical SHA-256 digest');
  }
  if (
    !Array.isArray(payload.destinations) ||
    payload.destinations.length < 1 ||
    payload.destinations.length > ARTIFACT_DESTINATIONS.size ||
    new Set(payload.destinations).size !== payload.destinations.length ||
    payload.destinations.some((destination) =>
      typeof destination !== 'string' ||
      !ARTIFACT_DESTINATIONS.has(destination)
    )
  ) invalid('managed artifact destinations are invalid');
}

/**
 * Production boundary over the fully tested artifact state engine.
 *
 * Calls are serialized so an asynchronous isolated inspector cannot race
 * mutations. Every accepted request (including one that fails after fencing)
 * is flushed through the host's atomic persistence port before the lock is
 * released.
 */
export function createManagedArtifactDriverAdapter(
  options: ManagedArtifactDriverAdapterOptions,
): ArtifactManagementDriver {
  if (
    !options.name ||
    !options.threatAssumptions.length
  ) {
    invalid(
      'managed artifact adapter requires durable storage, isolated inspection, and threat assumptions',
    );
  }
  const engine = createFakeArtifactManagementDriver({
    state: options.state,
    inspector: options.inspector,
    reviewer: options.reviewer,
    now: options.now,
    maxArtifactBytes: options.maxArtifactBytes,
    capabilities: {
      name: options.name,
      inspectionIsolation: options.inspectionIsolation,
      persistence: options.persistence,
      threatAssumptions: options.threatAssumptions,
    },
    destinationPolicies: options.destinationPolicies,
  });

  let tail: Promise<void> = Promise.resolve();

  async function exclusive<T>(action: () => Promise<T>): Promise<T> {
    let release!: () => void;
    const previous = tail;
    tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    let result: T | undefined;
    let operationError: unknown;
    try {
      result = await action();
    } catch (error) {
      operationError = error;
    }
    try {
      await options.persistState(snapshotArtifactManagementState(options.state));
    } catch (error) {
      release();
      throw new OrchestrationError({
        code: 'UNKNOWN_EFFECT',
        message: `artifact host state could not be durably committed: ${error instanceof Error ? error.message : String(error)}`,
        retryable: false,
      });
    }
    release();
    if (operationError !== undefined) {
      if (operationError instanceof Error) throw operationError;
      throw new OrchestrationError({
        code: 'INTERNAL',
        message: 'artifact operation failed with a non-error value',
        retryable: false,
      });
    }
    return result as T;
  }

  async function authorize<T>(
    request: DriverRequestEnvelope<T>,
    fields: readonly string[],
  ): Promise<void> {
    exactFields(request.payload, fields, `${request.method} payload`);
    if (!await options.authorizeRequest(request)) {
      throw new OrchestrationError({
        code: 'FORBIDDEN',
        message: 'managed artifact capability was rejected',
        retryable: false,
      });
    }
  }

  return {
    getCapabilities: () => engine.getCapabilities(),
    async put(request, content) {
      await authorize(request, [
        'expectedContentHash',
        'mimeType',
        'trust',
        'producerRunUid',
        'parentContentHashes',
        'maxBytes',
      ]);
      if (
        request.payload.expectedContentHash !== undefined &&
        !/^sha256:[a-f0-9]{64}$/.test(request.payload.expectedContentHash)
      ) invalid('managed artifact expectedContentHash is invalid');
      if (
        typeof request.payload.mimeType !== 'string' ||
        request.payload.mimeType.length > 256 ||
        !/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i.test(
          request.payload.mimeType,
        )
      ) invalid('managed artifact mimeType is invalid');
      if (
        request.payload.producerRunUid !== undefined &&
        (
          typeof request.payload.producerRunUid !== 'string' ||
          !request.payload.producerRunUid ||
          request.payload.producerRunUid.length > 256
        )
      ) invalid('managed artifact producerRunUid is invalid');
      const parents = request.payload.parentContentHashes ?? [];
      if (
        !Array.isArray(parents) ||
        parents.length > 64 ||
        new Set(parents).size !== parents.length ||
        parents.some((parent) =>
          typeof parent !== 'string' ||
          !/^sha256:[a-f0-9]{64}$/.test(parent)
        )
      ) invalid('managed artifact parentContentHashes are invalid');
      return exclusive(() => engine.put(request, content));
    },
    async resolve(request) {
      await authorize(request, ['contentHash']);
      return exclusive(() => engine.resolve(request));
    },
    async *read(request) {
      await authorize(request, ['artifactHandle']);
      const chunks = await exclusive(async () => {
        const values: Uint8Array[] = [];
        for await (const chunk of engine.read(request)) values.push(chunk);
        return values;
      });
      for (const chunk of chunks) yield chunk;
    },
    async scan(request) {
      await authorize(request, [
        'artifactHandle',
        'policyDigest',
        'destinations',
      ]);
      validateReviewPayload(request.payload);
      return exclusive(() => engine.scan(request));
    },
    async sanitize(request) {
      await authorize(request, [
        'artifactHandle',
        'outputResource',
        'policyDigest',
        'destinations',
      ]);
      exactFields(
        request.payload.outputResource,
        ['uid', 'name', 'generation'],
        'sanitize outputResource',
      );
      validateReviewPayload(request.payload);
      return exclusive(() => engine.sanitize(request));
    },
    async verify(request) {
      await authorize(request, [
        'artifactHandle',
        'policyDigest',
        'destinations',
        'properties',
      ]);
      validateReviewPayload(request.payload);
      if (
        !Array.isArray(request.payload.properties) ||
        request.payload.properties.length < 1 ||
        request.payload.properties.length > 16 ||
        new Set(request.payload.properties).size !==
          request.payload.properties.length ||
        request.payload.properties.some((property) =>
          typeof property !== 'string' ||
          !property ||
          property.length > 128
        )
      ) invalid('managed artifact verification properties are invalid');
      return exclusive(() => engine.verify(request));
    },
    async promote(request) {
      await authorize(request, ['artifactHandle', 'destination']);
      return exclusive(() => engine.promote(request));
    },
    async quarantine(request) {
      await authorize(request, ['artifactHandle', 'reason']);
      if (
        typeof request.payload.reason !== 'string' ||
        !request.payload.reason ||
        request.payload.reason.length > 1024
      ) invalid('managed artifact quarantine reason is invalid');
      return exclusive(() => engine.quarantine(request));
    },
    async mount(request) {
      await authorize(request, ['artifactHandle', 'destination']);
      return exclusive(() => engine.mount(request));
    },
    async unmount(request) {
      await authorize(request, ['mountHandle']);
      return exclusive(() => engine.unmount(request));
    },
    async delete(request) {
      await authorize(request, ['artifactHandle']);
      return exclusive(() => engine.delete(request));
    },
  };
}
