export const V2_EVENT_SYNC_UNSUPPORTED_CODE = 'unsupported_for_v2_event_sync';

/** Fail-closed signal for backends that cannot preserve the v2 event log. */
export class V2EventSyncUnsupportedError extends Error {
  readonly code = V2_EVENT_SYNC_UNSUPPORTED_CODE;

  constructor(backend: string) {
    super(V2_EVENT_SYNC_UNSUPPORTED_CODE, { cause: { backend } });
    this.name = 'V2EventSyncUnsupportedError';
  }
}
