import { createHmac, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import {
  type ControlStore,
  type ControlStoreActor,
  createInMemoryModelAccessHandleBroker,
  createModelCallRecordManifest,
  createModelGateway,
  type IssueModelAccessHandleRequest,
  type ModelAccessHandle,
  type ModelAccessHandleBroker,
  type ModelGateway,
  type ModelGatewayCallRecord,
  type ModelGatewayExecutor,
  type ModelHandleSigner,
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

/** Load or create the daemon's model-broker signing key (0600, host-local). */
export function loadOrCreateModelBrokerKey(dataDirectory: string): Uint8Array {
  const keyPath = path.join(dataDirectory, 'model-broker.key');
  try {
    const existing = fs.readFileSync(keyPath);
    if (existing.length >= 32) return new Uint8Array(existing);
  } catch {
    // Missing or unreadable — generate a fresh key below.
  }
  const generated = new Uint8Array(randomBytes(32));
  fs.writeFileSync(keyPath, Buffer.from(generated), { mode: 0o600 });
  return generated;
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
): { recordCall(record: ModelGatewayCallRecord): Promise<void> } {
  return {
    async recordCall(record) {
      const name = recordNameForCall(record.callId);
      const manifest = createModelCallRecordManifest(name, record.spec);
      try {
        const created = await store.create(actor, manifest);
        await store.updateStatus(
          actor,
          {
            apiVersion: manifest.apiVersion,
            kind: manifest.kind,
            name: created.metadata.name ?? name,
            namespace: created.metadata.namespace,
          },
          record.status,
          { resourceVersion: created.metadata.resourceVersion },
        );
      } catch {
        // Duplicate record name (idempotent retry) or transient store error —
        // audit must not break model calls (gateway reports via onError).
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
  onError?: (error: unknown) => void;
}

export interface NodeModelGateway {
  gateway: ModelGateway;
  broker: ModelAccessHandleBroker;
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
    recorder: createControlStoreModelCallRecorder(options.controlStore, options.actor),
    caller: `node/${options.nodeId}`,
    audience,
    ...(options.costPerToken !== undefined ? { costPerToken: options.costPerToken } : {}),
    ...(options.currency !== undefined ? { currency: options.currency } : {}),
    ...(options.maxRequestsPerSecond !== undefined ? { maxRequestsPerSecond: options.maxRequestsPerSecond } : {}),
    ...(options.onError !== undefined ? { onError: options.onError } : {}),
  });
  return {
    gateway,
    broker,
    issueHandle: (request) => broker.issueModelAccessHandle(request),
  };
}
