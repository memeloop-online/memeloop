import { V2_EVENT_SYNC_UNSUPPORTED_CODE, V2EventSyncUnsupportedError } from '../storage/v2EventSyncUnsupported.js';
import type { IAgentStorage, IChatSyncAdapter } from '../types.js';

export { V2_EVENT_SYNC_UNSUPPORTED_CODE, V2EventSyncUnsupportedError };

export interface SolidPodSyncAdapterOptions {
  /** Root URL of the Solid Pod (e.g. https://pod.example.com/username/) */
  podRootUrl: string;
  /** Local storage to push from and optionally merge into when pulling */
  storage: IAgentStorage;
  /** Authenticated fetch (e.g. from @inrupt/solid-client-authn-node). If not provided, start/stop no-op (Pod unavailable). */
  fetch?: typeof globalThis.fetch;
  /** Interval in ms for periodic push. Default 5 minutes. */
  pushIntervalMs?: number;
  /** Receives best-effort sync failures that would otherwise be invisible. */
  onError?: (event: SolidPodSyncErrorEvent) => void;
}

export interface SolidPodSyncErrorEvent {
  operation: 'initial-merge' | 'pull' | 'push';
  error: unknown;
}

/**
 * Reserved Solid Pod adapter surface.
 *
 * The original implementation serialized projected `ChatMessage` rows. That
 * loses tombstones, metadata patches, compaction membership, origin sequence
 * frontiers, and attachment bytes, so restoring it can resurrect deleted turns
 * and permanently diverge v2 replicas. Keep the public class fail-closed until
 * a Solid backend implements the complete ConversationEventStore + BlobStore
 * contract with opaque paging.
 */
export class SolidPodSyncAdapter implements IChatSyncAdapter {
  private readonly podRootUrl: string;

  constructor(options: SolidPodSyncAdapterOptions) {
    this.podRootUrl = options.podRootUrl;
  }

  async start(): Promise<void> {
    throw new V2EventSyncUnsupportedError(this.podRootUrl);
  }

  async stop(): Promise<void> {}

  async pushToPod(): Promise<void> {
    throw new V2EventSyncUnsupportedError(this.podRootUrl);
  }

  async pullFromPod(): Promise<never> {
    throw new V2EventSyncUnsupportedError(this.podRootUrl);
  }

  async mergePayloadIntoStorage(_payload: unknown): Promise<void> {
    throw new V2EventSyncUnsupportedError(this.podRootUrl);
  }
}
