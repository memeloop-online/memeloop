import type { MemeLoopVisibleAttachmentHydrationRequest, MemeLoopVisibleAttachmentHydrationResult, MemeLoopVisibleAttachmentLoader } from './visibleAttachmentHydration.js';
import { validateVisibleAttachmentHydrationResult } from './visibleAttachmentHydration.js';

interface Subscriber {
  result: (value: MemeLoopVisibleAttachmentHydrationResult | null) => void;
  error: (error: unknown) => void;
}

interface Entry {
  controller: AbortController;
  subscribers: Set<Subscriber>;
  settled: boolean;
  outcome?:
    | Readonly<{ kind: 'result'; value: MemeLoopVisibleAttachmentHydrationResult | null }>
    | Readonly<{ error: unknown; kind: 'error' }>;
}

const stores = new WeakMap<MemeLoopVisibleAttachmentLoader, Map<string, Entry>>();

/** Share one visible-message read across Web/Native duplicate consumers. */
export function subscribeVisibleAttachmentHydration(
  loader: MemeLoopVisibleAttachmentLoader,
  request: Omit<MemeLoopVisibleAttachmentHydrationRequest, 'signal'>,
  subscriber: Subscriber,
): () => void {
  let store = stores.get(loader);
  if (!store) {
    store = new Map();
    stores.set(loader, store);
  }
  const key = hydrationKey(request);
  let entry = store.get(key);
  if (!entry) {
    entry = { controller: new AbortController(), subscribers: new Set(), settled: false };
    store.set(key, entry);
    const current = entry;
    void Promise.resolve()
      .then(() => loader({ ...request, signal: current.controller.signal }))
      .then(value => value === null ? null : validateVisibleAttachmentHydrationResult({ ...request, signal: current.controller.signal }, value))
      .then(value => {
        current.settled = true;
        current.outcome = { kind: 'result', value };
        for (const target of current.subscribers) target.result(value);
      })
      .catch((error: unknown) => {
        current.settled = true;
        if (current.controller.signal.aborted) return;
        current.outcome = { error, kind: 'error' };
        for (const target of current.subscribers) target.error(error);
      });
  }
  entry.subscribers.add(subscriber);
  const outcome = entry.outcome;
  if (outcome) {
    queueMicrotask(() => {
      if (!entry?.subscribers.has(subscriber)) return;
      if (outcome.kind === 'result') subscriber.result(outcome.value);
      else subscriber.error(outcome.error);
    });
  }
  const retainedEntry = entry;
  const retainedStore = store;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    retainedEntry.subscribers.delete(subscriber);
    queueMicrotask(() => {
      if (retainedEntry.subscribers.size > 0 || retainedStore.get(key) !== retainedEntry) return;
      retainedStore.delete(key);
      if (!retainedEntry.settled && !retainedEntry.controller.signal.aborted) {
        retainedEntry.controller.abort(new Error('visible attachment hydration disposed'));
      }
    });
  };
}

function hydrationKey(request: Omit<MemeLoopVisibleAttachmentHydrationRequest, 'signal'>): string {
  return [
    request.revision,
    String(request.maxCount),
    String(request.maxBytes),
    request.referencesOmitted ? 'omitted' : 'resident',
    ...request.references.map(reference => `${reference.contentHash}:${reference.size}:${reference.mimeType}:${reference.filename}`),
  ].join('\u001E');
}
