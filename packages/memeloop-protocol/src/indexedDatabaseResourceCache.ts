import type { OrchestrationResource, OrchestrationResourceList, OrchestrationResourceQuery, OrchestrationResourceReference } from 'memeloop';

import type { PortableResourceCache } from './index.js';

interface StoredResource {
  key: string;
  kind: string;
  resource: OrchestrationResource;
}

export interface IndexedDatabaseResourceCacheOptions {
  indexedDB?: IDBFactory;
  databaseName?: string;
  storeName?: string;
}

export interface IndexedDatabaseResourceCache extends PortableResourceCache {
  close(): void;
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.addEventListener('success', () => {
      resolve(request.result);
    });
    request.addEventListener('error', () => {
      reject(request.error ?? new Error('IndexedDB request failed'));
    });
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    transaction.addEventListener('complete', () => {
      resolve();
    });
    transaction.addEventListener('abort', () => {
      reject(transaction.error ?? new Error('IndexedDB transaction aborted'));
    });
    transaction.addEventListener('error', () => {
      reject(transaction.error ?? new Error('IndexedDB transaction failed'));
    });
  });
}

function resourceKey(reference: OrchestrationResourceReference): string | null {
  if (!reference.name) return null;
  return JSON.stringify([
    reference.apiVersion ?? '',
    reference.kind,
    reference.namespace ?? '',
    reference.name,
  ]);
}

function matchesQuery(
  resource: OrchestrationResource,
  query: OrchestrationResourceQuery,
): boolean {
  if (resource.kind !== query.kind) return false;
  if (query.apiVersion && resource.apiVersion !== query.apiVersion) return false;
  if (
    query.namespace !== undefined &&
    resource.metadata.namespace !== query.namespace
  ) return false;
  return Object.entries(query.labels ?? {}).every(
    ([name, value]) => resource.metadata.labels?.[name] === value,
  );
}

function cacheResourceVersion(resources: OrchestrationResource[]): string {
  let maximum: bigint | undefined;
  for (const resource of resources) {
    try {
      const revision = BigInt(resource.metadata.resourceVersion);
      if (maximum === undefined || revision > maximum) maximum = revision;
    } catch {
      return 'cache';
    }
  }
  return maximum?.toString() ?? 'cache';
}

/**
 * Advisory browser/Tauri-WebView cache for remote resource snapshots.
 * Control-plane writes and watches always go through AgentOrchestrationClient.
 */
export function createIndexedDatabaseResourceCache(
  options: IndexedDatabaseResourceCacheOptions = {},
): IndexedDatabaseResourceCache {
  const factory = options.indexedDB ?? globalThis.indexedDB;
  if (!factory) throw new Error('IndexedDB is unavailable in this host');
  const databaseName = options.databaseName ?? 'memeloop-resource-cache';
  const storeName = options.storeName ?? 'resources';
  let databasePromise: Promise<IDBDatabase> | undefined;
  let closed = false;

  function database(): Promise<IDBDatabase> {
    if (closed) throw new Error('IndexedDB resource cache is closed');
    databasePromise ??= new Promise<IDBDatabase>((resolve, reject) => {
      const request = factory.open(databaseName, 1);
      request.addEventListener('upgradeneeded', () => {
        const database_ = request.result;
        if (!database_.objectStoreNames.contains(storeName)) {
          const store = database_.createObjectStore(storeName, { keyPath: 'key' });
          store.createIndex('kind', 'kind', { unique: false });
        }
      });
      request.addEventListener('success', () => {
        resolve(request.result);
      });
      request.addEventListener('error', () => {
        reject(request.error ?? new Error('Failed to open IndexedDB resource cache'));
      });
      request.addEventListener('blocked', () => {
        reject(new Error('IndexedDB resource cache upgrade is blocked'));
      });
    });
    return databasePromise;
  }

  return {
    async get(reference) {
      const key = resourceKey(reference);
      if (!key) return null;
      const database_ = await database();
      const transaction = database_.transaction(storeName, 'readonly');
      const done = transactionDone(transaction);
      const record = await requestResult(
        transaction.objectStore(storeName).get(key),
      ) as StoredResource | undefined;
      await done;
      return record ? structuredClone(record.resource) : null;
    },
    async list(query): Promise<OrchestrationResourceList> {
      const database_ = await database();
      const transaction = database_.transaction(storeName, 'readonly');
      const done = transactionDone(transaction);
      const records = await requestResult(
        transaction.objectStore(storeName).index('kind').getAll(query.kind),
      ) as StoredResource[];
      await done;
      const items = records
        .map((record) => record.resource)
        .filter((resource) => matchesQuery(resource, query))
        .map((resource) => structuredClone(resource));
      return {
        items,
        resourceVersion: cacheResourceVersion(items),
      };
    },
    async put(resource) {
      const key = resourceKey({
        apiVersion: resource.apiVersion,
        kind: resource.kind,
        namespace: resource.metadata.namespace,
        name: resource.metadata.name,
      });
      if (!key) throw new Error('IndexedDB cache resource name is required');
      const database_ = await database();
      const transaction = database_.transaction(storeName, 'readwrite');
      const done = transactionDone(transaction);
      transaction.objectStore(storeName).put(
        {
          key,
          kind: resource.kind,
          resource: structuredClone(resource),
        } satisfies StoredResource,
      );
      await done;
    },
    async remove(reference) {
      const key = resourceKey(reference);
      if (!key) return;
      const database_ = await database();
      const transaction = database_.transaction(storeName, 'readwrite');
      const done = transactionDone(transaction);
      transaction.objectStore(storeName).delete(key);
      await done;
    },
    async clear() {
      const database_ = await database();
      const transaction = database_.transaction(storeName, 'readwrite');
      const done = transactionDone(transaction);
      transaction.objectStore(storeName).clear();
      await done;
    },
    close() {
      closed = true;
      void databasePromise?.then((database_) => {
        database_.close();
      });
    },
  };
}
