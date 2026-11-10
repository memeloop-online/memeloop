export const V2_EVENT_SYNC_UNSUPPORTED_CODE = 'unsupported_for_v2_event_sync';

/** Capability error identifying the backend's required v2 event-log support. */
export class V2EventSyncUnsupportedError extends Error {
  readonly code = V2_EVENT_SYNC_UNSUPPORTED_CODE;

  constructor(backend: string) {
    super(V2_EVENT_SYNC_UNSUPPORTED_CODE, { cause: { backend } });
    this.name = 'V2EventSyncUnsupportedError';
  }
}
