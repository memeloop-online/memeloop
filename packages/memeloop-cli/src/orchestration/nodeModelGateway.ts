import { createHash, createHmac, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import {
  type ControlStore,
  type ControlStoreActor,
  createInMemoryModelAccessHandleBroker,
  createManagedModelGatewayAdapter,
  createModelCallRecordManifest,
  createModelGateway,
  type DriverRequestEnvelope,
  type IssueModelAccessHandleRequest,
  type ManagedModelDescriptor,
  type ModelAccessHandle,
  type ModelAccessHandleBroker,
  type ModelCallRecordResource,
  type ModelGateway,
  type ModelGatewayCallRecord,
  type ModelGatewayExecutor,
  type ModelHandleSigner,
  OrchestrationError,
} from 'memeloop';

/**
 * CLI production wiring for the ModelGateway (plan §12, step 24.65).
 *
 * - The broker signing key is generated once and persisted at
 *   `dataDir/model-broker.key` (0600); it never leaves the daemon host.
 * - The recorder persists ModelCallRecord resources into the ControlStore.
 * - Workers never see provider keys: they receive short-lived handles issued
 *   by the broker and call the gateway (24.35); the gateway enforces
 *   Run/model/audience/budget/expiry at the trusted side (§12.4).
 */

/** HMAC-SHA256 signer for the model handle broker (Node host port, 24.34). */
export function createHmacModelHandleSigner(secret: Uint8Array): ModelHandleSigner {
  return {
    sign: async (payload) => new Uint8Array(createHmac('sha256', secret).update(payload).digest()),
    verify: async (payload, signature) => {
      const expected = createHmac('sha256', secret).update(payload).digest();
      return signature.length === expected.length && expected.every((byte, index) => byte === signature[index]);
    },
  };
}

function nodeErrorCode(error: unknown): string | undefined {
  if (error === null || typeof error !== 'object' || !('code' in error)) return undefined;
  const code = error.code;
  return typeof code === 'string' ? code : undefined;
}

function validateModelBrokerKey(keyPath: string, key: Buffer): Uint8Array {
  if (key.byteLength !== 32) {
    throw new Error(`model broker signing key at '${keyPath}' must be exactly 32 bytes`);
  }
  return new Uint8Array(key);
}

/** Load or create the daemon's model-broker signing key (0600, host-local). */
export function loadOrCreateModelBrokerKey(dataDirectory: string): Uint8Array {
  fs.mkdirSync(dataDirectory, { recursive: true, mode: 0o700 });
  const keyPath = path.join(dataDirectory, 'model-broker.key');
  let existing: Buffer | undefined;
  try {
    existing = fs.readFileSync(keyPath);
  } catch (error: unknown) {
    if (nodeErrorCode(error) !== 'ENOENT') {
      throw new Error(`model broker signing key at '${keyPath}' is unreadable`, { cause: error });
    }
  }
  if (existing !== undefined) return validateModelBrokerKey(keyPath, existing);

  const generated = randomBytes(32);
  try {
    fs.writeFileSync(keyPath, generated, { mode: 0o600, flag: 'wx' });
    return new Uint8Array(generated);
  } catch (error: unknown) {
    if (nodeErrorCode(error) !== 'EEXIST') throw error;
    // Another process won the first-write race. Never use our unpersisted key;
    // read and validate the winner's key instead. Any read/validation failure
    // is fatal so a broker identity is never silently rotated.
    let raced: Buffer;
    try {
      raced = fs.readFileSync(keyPath);
    } catch (error: unknown) {
      throw new Error(`model broker signing key at '${keyPath}' is unreadable`, { cause: error });
    }
    return validateModelBrokerKey(keyPath, raced);
  }
}

/** Stable process-warning code for an audit observer that failed to observe. */
export const MODEL_AUDIT_OBSERVER_WARNING_CODE = 'MEMELOOP_MODEL_AUDIT_OBSERVER_FAILED';

/**
 * Emit the final, non-recursive audit-observer failure signal. Keep the
 * payload bounded and restricted to an error name/message so a misbehaving
 * observer cannot accidentally dump credentials or request bodies.
 */
function emitModelAuditObserverWarning(error: unknown): void {
  const name = error instanceof Error && error.name.length > 0
    ? error.name
    : typeof error;
  const message = error instanceof Error
    ? error.message
    : typeof error === 'string'
    ? error
    : 'observer failed';
  process.emitWarning(
    `Model call audit observer failed (${name}): ${message}`.slice(0, 1024),
    { code: MODEL_AUDIT_OBSERVER_WARNING_CODE },
  );
}

async function reportModelAuditObserverFailure(
  error: unknown,
  onObserverError?: (error: unknown) => Promise<void> | void,
): Promise<void> {
  if (onObserverError === undefined) {
    emitModelAuditObserverWarning(error);
    return;
  }
  try {
    await onObserverError(error);
  } catch (observerError) {
    // The observer sink is deliberately isolated from the recorder and is
    // never called recursively if it fails. Fall back to the process warning
    // channel so this path remains observable without breaking model calls.
    emitModelAuditObserverWarning(observerError);
  }
}

/** Sanitize a callId into a ControlStore-safe resource name. */
function recordNameForCall(callId: string): string {
  const sanitized = callId.replaceAll(/[^a-z0-9-]/g, '-').replaceAll(/-+/g, '-').replaceAll(/^-|-$/g, '').toLowerCase();
  return `call-${sanitized || 'unknown'}`.slice(0, 253);
}

/**
 * Persist gateway call records as ModelCallRecord resources (24.32). Records
 * are idempotent by callId: a duplicate create (retry) is tolerated.
 */
export function createControlStoreModelCallRecorder(
  store: ControlStore,
  actor: ControlStoreActor,
  onRecorded?: (
    record: ModelGatewayCallRecord,
    resource: ModelCallRecordResource,
  ) => Promise<void> | void,
  onError?: (error: unknown) => Promise<void> | void,
  onObserverError?: (error: unknown) => Promise<void> | void,
): { recordCall(record: ModelGatewayCallRecord): Promise<void> } {
  return {
    async recordCall(record) {
      const name = recordNameForCall(record.callId);
      const manifest = createModelCallRecordManifest(name, record.spec);
      try {
        const created = await store.create(actor, manifest);
        const persisted = await store.updateStatus(
          actor,
          {
            apiVersion: manifest.apiVersion,
            kind: manifest.kind,
            name: created.metadata.name ?? name,
            namespace: created.metadata.namespace,
          },
          record.status,
          { resourceVersion: created.metadata.resourceVersion },
        ) as ModelCallRecordResource;
        await onRecorded?.(record, persisted);
      } catch (error) {
        // A duplicate record name is the expected idempotent retry path. Other
        // persistence failures must remain non-fatal to the provider call, but
        // they must be observable so operators can detect an audit gap.
        if (error instanceof OrchestrationError && error.code === 'CONFLICT') return;
        if (onError === undefined) {
          await reportModelAuditObserverFailure(error, onObserverError);
          return;
        }
        try {
          await onError(error);
        } catch (observerError) {
          await reportModelAuditObserverFailure(observerError, onObserverError);
        }
      }
    },
  };
}

export interface NodeModelGatewayOptions {
  dataDir: string;
  nodeId: string;
  actor: ControlStoreActor;
  controlStore: ControlStore;
  /** Executor performing the provider call with daemon-held credentials. */
  executor: ModelGatewayExecutor;
  costPerToken?: number;
  currency?: string;
  maxRequestsPerSecond?: number;
  /**
   * Canonical immutable model descriptors exposed through the managed driver.
   * Provider aliases without an artifact/snapshot digest must not be inserted.
   */
  managedModels?: ManagedModelDescriptor[];
  managedMaxConcurrentCalls?: number;
  managedMaxOutputTokens?: number;
  onError?: (error: unknown) => void;
  /** Sink for failures raised by the audit error observer itself. */
  onObserverError?: (error: unknown) => Promise<void> | void;
  /** Metadata-only durable audit sink invoked after ModelCallRecord persistence. */
  onRecorded?: (
    record: ModelGatewayCallRecord,
    resource: ModelCallRecordResource,
  ) => Promise<void> | void;
}

export interface NodeModelGateway {
  gateway: ModelGateway;
  broker: ModelAccessHandleBroker;
  /**
   * Process-local §10.4 management surface. Present only when the host
   * supplied canonical model descriptors; calls still require signed handles.
   */
  managedDriver?: ReturnType<typeof createManagedModelGatewayAdapter>;
  /** Convenience: issue a handle bound to this node's gateway audience. */
  issueHandle(request: Omit<IssueModelAccessHandleRequest, 'modelClassRef'> & { modelClassRef: IssueModelAccessHandleRequest['modelClassRef'] }): Promise<ModelAccessHandle>;
}

/**
 * Create the daemon's model gateway: HMAC-signed handle broker + budget-
 * enforcing gateway + ControlStore audit recorder (§12).
 */
export function createNodeModelGateway(options: NodeModelGatewayOptions): NodeModelGateway {
  const audience = `gateway://${options.nodeId}`;
  const broker = createInMemoryModelAccessHandleBroker({
    signer: createHmacModelHandleSigner(loadOrCreateModelBrokerKey(options.dataDir)),
    audience,
  });
  const gateway = createModelGateway({
    broker,
    executor: options.executor,
    recorder: createControlStoreModelCallRecorder(
      options.controlStore,
      options.actor,
      options.onRecorded,
      options.onError,
      options.onObserverError,
    ),
    caller: `node/${options.nodeId}`,
    audience,
    ...(options.costPerToken !== undefined ? { costPerToken: options.costPerToken } : {}),
    ...(options.currency !== undefined ? { currency: options.currency } : {}),
    ...(options.maxRequestsPerSecond !== undefined ? { maxRequestsPerSecond: options.maxRequestsPerSecond } : {}),
    ...(options.onError !== undefined ? { onError: options.onError } : {}),
  });
  const managedDriver = options.managedModels?.length
    ? createManagedModelGatewayAdapter(gateway, {
      models: options.managedModels,
      capabilities: {
        name: `node-model-gateway/${options.nodeId}`,
        streaming: true,
        cancellation: true,
        usageEstimation: true,
        maxConcurrentCalls: options.managedMaxConcurrentCalls ?? 1,
        maxOutputTokens: options.managedMaxOutputTokens ?? 4096,
        persistence: 'process',
        threatAssumptions: [
          'the Node daemon, handle signing key, provider executor, and capability resolver are trusted',
          'call lifecycle and idempotency state are lost on daemon restart',
        ],
      },
      resolveAccess: async (
        request: DriverRequestEnvelope,
        model: ManagedModelDescriptor,
      ) => {
        if (!request.capabilityHandleRef || !request.run) return undefined;
        try {
          const claims = await broker.verifyModelAccessHandle(
            request.capabilityHandleRef,
            {
              audience,
              ...(request.session?.keyFingerprint !== undefined
                ? { workerKey: request.session.keyFingerprint }
                : {}),
            },
          );
          if (
            claims.runRef?.uid !== request.run.uid ||
            claims.attempt !== request.run.attempt ||
            claims.modelClassRef.apiVersion !== 'models.memeloop.io/v1alpha1' ||
            claims.modelClassRef.kind !== 'ModelClass' ||
            claims.modelClassRef.name !== model.modelClass ||
            claims.modelDigest !== model.digest ||
            (claims.workerKey !== undefined &&
              claims.workerKey !== request.session?.keyFingerprint)
          ) {
            return undefined;
          }
          return {
            token: request.capabilityHandleRef,
            ...(request.session?.keyFingerprint !== undefined
              ? { workerKey: request.session.keyFingerprint }
              : {}),
            authorityFingerprint: `sha256:${createHash('sha256').update(claims.handleId).digest('hex')}`,
          };
        } catch {
          return undefined;
        }
      },
    })
    : undefined;
  return {
    gateway,
    broker,
    ...(managedDriver ? { managedDriver } : {}),
    issueHandle: (request) => broker.issueModelAccessHandle(request),
  };
}
