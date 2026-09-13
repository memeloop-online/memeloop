import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { rename, rm } from 'node:fs/promises';

import {
  Etcd3,
  EtcdAuthenticationFailedError,
  EtcdInvalidAuthTokenError,
  EtcdPermissionDeniedError,
  type IKeyValue,
  type IMember,
  type IOptions as Etcd3Options,
  type IResponseStream,
  type ISnapshotResponse,
  isRecoverableError,
  type Namespace,
  Range,
  type Watcher,
} from 'etcd3';
import {
  assertControlStoreApplyPreconditions,
  canonicalControlStoreValue,
  type ControlLeaseGrant,
  type ControlLeaseIdentity,
  type ControlLeaseRequest,
  type ControlStore,
  type ControlStoreActor,
  controlStoreApplyMatches,
  type ControlStoreApplyOptions,
  type ControlStoreApplyOwnership,
  controlStoreApplyRequestPayload,
  type ControlStoreAuthorizer,
  type ControlStoreCompactionResult,
  type ControlStoreCreateOptions,
  type ControlStoreHealth,
  type ControlStoreSnapshotResult,
  type ControlStoreStatusUpdateOptions,
  decideControlStoreApplyOwnership,
  type OrchestrationDeleteOptions,
  type OrchestrationDeleteResult,
  OrchestrationError,
  type OrchestrationGetOptions,
  type OrchestrationListOptions,
  type OrchestrationResource,
  type OrchestrationResourceList,
  type OrchestrationResourceManifest,
  type OrchestrationResourceQuery,
  type OrchestrationResourceReference,
  type OrchestrationResourceStatus,
  type OrchestrationWatchEvent,
  type OrchestrationWatchOptions,
  validateControlStoreApplyOptions,
} from 'memeloop';

const CONTROL_LEASE_API_VERSION = 'control.memeloop.io/v1alpha1';
const CONTROL_LEASE_KIND = 'ControlLease';
const META_REVISION_KEY = 'meta/revision';
const META_COMPACTED_KEY = 'meta/compacted';
const RESOURCE_PREFIX = 'resources/';
const EVENT_PREFIX = 'events/';
const IDEMPOTENCY_PREFIX = 'idempotency/';
const APPLY_OWNERSHIP_PREFIX = 'apply-ownership/';
const LEASE_PREFIX = 'leases/';
const LEASE_EPOCH_PREFIX = 'lease-epochs/';
const DEFAULT_NAMESPACE = '/memeloop/control/v1/';
const MAX_TRANSACTION_RETRIES = 16;

interface MetaState {
  clusterRevision: string;
  compacted: bigint;
  compactedModRevision: string;
  revision: bigint;
  revisionModRevision: string;
}

interface StoredEvent {
  resource: OrchestrationResource;
  type: 'ADDED' | 'MODIFIED' | 'DELETED';
}

interface IdempotencyRecord<T> {
  requestDigest: string;
  response: T;
}

interface StoredLease extends ControlLeaseGrant {
  nativeLeaseId: string;
}

interface ContinueToken {
  queryDigest: string;
  resourceVersion: string;
  /** The last resource key returned/scanned by the previous page. */
  cursor: string;
}

/**
 * Keep every etcd range response and every public page bounded.  Historical
 * snapshots additionally cap the amount of replay state retained while
 * rebuilding resources from the append-only event stream.
 */
export const MAX_CONTROL_STORE_PAGE_SIZE = 50;
export const CONTROL_STORE_READ_BATCH_SIZE = 128;
export const CONTROL_STORE_MAX_SCAN_ROWS = 4_096;
export const CONTROL_STORE_MAX_HISTORY_EVENTS = 65_536;
export const CONTROL_STORE_MAX_COMPACTION_KEYS = 65_536;
export const CONTROL_STORE_COMPACTION_BATCH_SIZE = 128;

export interface EtcdControlStoreMember {
  clientUrls: string[];
  id: string;
  isLearner: boolean;
  name: string;
  peerUrls: string[];
}

export interface EtcdControlStoreOptions {
  /**
   * etcd3 connection settings. Production deployments should supply all
   * client endpoints plus TLS credentials and/or authentication.
   */
  connection?: Etcd3Options;
  /** Key namespace owned by this control plane. */
  namespace?: string;
  /**
   * Also compact cluster-wide etcd MVCC history. Leave false when this etcd
   * cluster is shared; namespaced replay history is compacted either way.
   */
  physicalCompaction?: boolean;
  authorizer: ControlStoreAuthorizer;
  now?: () => Date;
  uid?: () => string;
  /** Primarily for tests or hosts that already own an Etcd3 client. */
  client?: Etcd3;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function digest(value: unknown): string {
  return createHash('sha256').update(canonicalControlStoreValue(value)).digest('hex');
}

function encode(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url');
}

function resourceKey(reference: OrchestrationResourceReference): string {
  if (!reference.name) {
    throw new OrchestrationError({ code: 'INVALID', message: 'ControlStore resource name is required', retryable: false });
  }
  return `${RESOURCE_PREFIX}${
    encode(JSON.stringify([
      reference.apiVersion,
      reference.kind,
      reference.namespace ?? '',
      reference.name,
    ]))
  }`;
}

function referenceFor<TSpec, TStatus>(
  resource: OrchestrationResource<TSpec, TStatus> | OrchestrationResourceManifest<TSpec>,
): OrchestrationResourceReference {
  return {
    apiVersion: resource.apiVersion,
    kind: resource.kind,
    name: resource.metadata.name,
    namespace: resource.metadata.namespace,
  };
}

function eventKey(revision: bigint): string {
  return `${EVENT_PREFIX}${revision.toString().padStart(24, '0')}`;
}

function applyOwnershipKey(resource: string): string {
  return `${APPLY_OWNERSHIP_PREFIX}${encode(resource)}`;
}

function idempotencyKey(value: string): string {
  return `${IDEMPOTENCY_PREFIX}${encode(value)}`;
}

function leaseKey(value: string): string {
  return `${LEASE_PREFIX}${encode(value)}`;
}

function leaseEpochKey(value: string): string {
  return `${LEASE_EPOCH_PREFIX}${encode(value)}`;
}

// The keyspace/schema pair supplies T at each call site; validation is applied
// at public ingress and etcd values are written only by this adapter.  The
// optional decoder argument keeps the generic tied to an input position while
// retaining the concise `parseJson<T>(value)` call form.
function parseJson<T>(value: Buffer | string, _decoder?: (value: unknown) => T): T {
  return JSON.parse(typeof value === 'string' ? value : value.toString('utf8')) as T;
}

function keyValue(response: { kvs: IKeyValue[] }): IKeyValue | undefined {
  return response.kvs[0];
}

function matchesQuery(resource: OrchestrationResource, query: OrchestrationResourceQuery): boolean {
  if (resource.kind !== query.kind) return false;
  if (query.apiVersion && resource.apiVersion !== query.apiVersion) return false;
  if (query.namespace !== undefined && resource.metadata.namespace !== query.namespace) return false;
  return Object.entries(query.labels ?? {}).every(([name, value]) => resource.metadata.labels?.[name] === value);
}

function encodeContinueToken(token: ContinueToken): string {
  return Buffer.from(JSON.stringify(token), 'utf8').toString('base64url');
}

function decodeContinueToken(value: string): ContinueToken {
  try {
    const token = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as ContinueToken;
    if (
      !token.queryDigest ||
      !token.resourceVersion ||
      typeof token.cursor !== 'string' ||
      token.cursor.length === 0
    ) {
      throw new Error('invalid token');
    }
    return token;
  } catch {
    throw new OrchestrationError({ code: 'INVALID', message: 'invalid ControlStore continue token', retryable: false });
  }
}

function parseResourceVersion(value: string | undefined, fallback: bigint): bigint {
  if (value === undefined) return fallback;
  try {
    const revision = BigInt(value);
    if (revision < 0n) throw new Error('negative resourceVersion');
    return revision;
  } catch {
    throw new OrchestrationError({
      code: 'INVALID',
      message: `invalid ControlStore resourceVersion '${value}'`,
      retryable: false,
    });
  }
}

function normalizeListLimit(value: number | undefined): number {
  if (value === undefined) return MAX_CONTROL_STORE_PAGE_SIZE;
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_CONTROL_STORE_PAGE_SIZE) {
    throw new OrchestrationError({
      code: 'INVALID',
      message: `ControlStore list limit must be an integer from 1 through ${MAX_CONTROL_STORE_PAGE_SIZE}`,
      retryable: false,
    });
  }
  return value;
}

function incrementKey(value: string): Buffer {
  const bytes = Buffer.from(value, 'utf8');
  for (let index = bytes.length - 1; index >= 0; index -= 1) {
    if (bytes[index] !== 0xff) {
      const next = Buffer.from(bytes);
      next[index] += 1;
      return next.subarray(0, index + 1);
    }
  }
  return Buffer.from([0xff, 0xff]);
}

interface MaintenanceConnectionPool {
  markFailed(resource: unknown, error: Error): void;
  withConnection<T>(
    service: 'Maintenance',
    callback: (input: {
      client: {
        snapshot(
          request: Record<string, never>,
          metadata: unknown,
          options: Record<string, never>,
        ): IResponseStream<ISnapshotResponse>;
      };
      metadata: unknown;
      resource: unknown;
    }) => T,
  ): Promise<T>;
}

interface MaintenancePoolOwner {
  client: MaintenanceConnectionPool;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isMaintenancePoolOwner(value: unknown): value is MaintenancePoolOwner {
  if (!isRecord(value) || !isRecord(value.client)) return false;
  const client = value.client;
  return typeof client.markFailed === 'function' && typeof client.withConnection === 'function';
}

/** Keep the etcd3 auth-order workaround behind one typed maintenance adapter. */
function maintenanceConnectionPool(maintenance: Etcd3['maintenance']): MaintenanceConnectionPool {
  const candidate: unknown = maintenance;
  if (!isMaintenancePoolOwner(candidate)) {
    throw new Error('etcd3 maintenance client does not expose the required connection pool capability');
  }
  return candidate.client;
}

function memberView(member: IMember): EtcdControlStoreMember {
  return {
    id: member.ID,
    name: member.name,
    peerUrls: [...member.peerURLs],
    clientUrls: [...member.clientURLs],
    isLearner: member.isLearner,
  };
}

class AsyncEventQueue<T> {
  private readonly values: T[] = [];
  private readonly waiting: Array<{
    reject: (error: Error) => void;
    resolve: (result: IteratorResult<T>) => void;
  }> = [];
  private failure?: Error;
  private ended = false;

  constructor(private readonly maxValues = CONTROL_STORE_READ_BATCH_SIZE * 8) {}

  push(value: T): void {
    if (this.ended) return;
    const waiter = this.waiting.shift();
    if (waiter) waiter.resolve({ done: false, value });
    else if (this.values.length >= this.maxValues) {
      this.fail(
        new OrchestrationError({
          code: 'EXHAUSTED',
          message: 'ControlStore watch event backlog exceeded its bounded queue',
          retryable: true,
        }),
      );
    } else this.values.push(value);
  }

  fail(error: Error): void {
    if (this.ended) return;
    this.failure = error;
    this.ended = true;
    for (const waiter of this.waiting.splice(0)) waiter.reject(error);
  }

  end(): void {
    if (this.ended) return;
    this.ended = true;
    for (const waiter of this.waiting.splice(0)) waiter.resolve({ done: true, value: undefined });
  }

  async next(): Promise<IteratorResult<T>> {
    const value = this.values.shift();
    if (value !== undefined) return { done: false, value };
    if (this.failure) throw this.failure;
    if (this.ended) return { done: true, value: undefined };
    return await new Promise<IteratorResult<T>>((resolve, reject) => this.waiting.push({ resolve, reject }));
  }
}

/**
 * A real etcd v3 ControlStore.
 *
 * Every authoritative mutation is one etcd transaction containing the global
 * logical revision, resource state, replay event, and idempotency response.
 * etcd's Raft quorum therefore decides the write and loss of quorum fails
 * closed. Native etcd leases expire holder keys while a durable epoch key
 * prevents fencing epochs from ever restarting.
 */
export class EtcdControlStore implements ControlStore {
  private readonly activeWatchQueues = new Set<AsyncEventQueue<StoredEvent>>();
  private readonly authorizer: ControlStoreAuthorizer;
  private readonly client: Etcd3;
  private readonly namespace: Namespace;
  private readonly now: () => Date;
  private readonly ownsClient: boolean;
  private readonly physicalCompaction: boolean;
  private readonly uid: () => string;
  private closed = false;
  private ready?: Promise<void>;

  public constructor(options: EtcdControlStoreOptions) {
    this.authorizer = options.authorizer;
    this.client = options.client ?? new Etcd3(options.connection);
    this.ownsClient = !options.client;
    this.namespace = this.client.namespace(options.namespace ?? DEFAULT_NAMESPACE);
    this.now = options.now ?? (() => new Date());
    this.physicalCompaction = options.physicalCompaction ?? false;
    this.uid = options.uid ?? randomUUID;
  }

  private async initialize(): Promise<void> {
    await this.namespace.if(META_REVISION_KEY, 'Create', '==', 0)
      .then(this.namespace.put(META_REVISION_KEY).value('0'))
      .commit();
    await this.namespace.if(META_COMPACTED_KEY, 'Create', '==', 0)
      .then(this.namespace.put(META_COMPACTED_KEY).value('0'))
      .commit();
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new OrchestrationError({ code: 'UNAVAILABLE', message: 'ControlStore is closed', retryable: false });
    }
  }

  private async ensureReady(): Promise<void> {
    this.ready ??= this.initialize().catch((error: unknown) => {
      this.ready = undefined;
      throw error;
    });
    await this.ready;
  }

  private async operation<T>(action: () => Promise<T>): Promise<T> {
    this.assertOpen();
    try {
      await this.ensureReady();
      return await action();
    } catch (error) {
      if (error instanceof OrchestrationError) throw error;
      const source = error instanceof Error ? error : new Error(String(error));
      const forbidden = source instanceof EtcdPermissionDeniedError ||
        source instanceof EtcdAuthenticationFailedError ||
        source instanceof EtcdInvalidAuthTokenError;
      throw new OrchestrationError({
        code: forbidden ? 'FORBIDDEN' : isRecoverableError(source) ? 'UNAVAILABLE' : 'INTERNAL',
        message: `etcd ControlStore: ${source.message}`,
        retryable: !forbidden && isRecoverableError(source),
      });
    }
  }

  private async metaAt(clusterRevision?: string): Promise<MetaState> {
    const revisionResponse = await this.namespace.get(META_REVISION_KEY)
      .revision(clusterRevision ?? '0')
      .exec();
    const revisionKv = keyValue(revisionResponse);
    if (!revisionKv) throw new Error('etcd ControlStore revision metadata is missing');
    const snapshotRevision = clusterRevision ?? revisionResponse.header.revision;
    const compactedResponse = await this.namespace.get(META_COMPACTED_KEY).revision(snapshotRevision).exec();
    const compactedKv = keyValue(compactedResponse);
    if (!compactedKv) throw new Error('etcd ControlStore compaction metadata is missing');
    return {
      revision: BigInt(revisionKv.value.toString('utf8')),
      revisionModRevision: revisionKv.mod_revision,
      compacted: BigInt(compactedKv.value.toString('utf8')),
      compactedModRevision: compactedKv.mod_revision,
      clusterRevision: snapshotRevision,
    };
  }

  private async currentResource<TSpec = Record<string, unknown>, TStatus = OrchestrationResourceStatus>(
    reference: OrchestrationResourceReference,
    clusterRevision?: string,
  ): Promise<{ kv: IKeyValue; resource: OrchestrationResource<TSpec, TStatus> } | null> {
    const response = await this.namespace.get(resourceKey(reference)).revision(clusterRevision ?? '0').exec();
    const kv = keyValue(response);
    return kv ? { kv, resource: parseJson<OrchestrationResource<TSpec, TStatus>>(kv.value) } : null;
  }

  /**
   * Prepare the durable field-ownership record for one apply attempt. The
   * returned key/value is written in the same etcd transaction as the resource
   * and protected by a compare on its current mod revision.
   */
  private async prepareApplyOwnership(
    key: string,
    current: OrchestrationResource | null,
    manifest: OrchestrationResourceManifest,
    options: ControlStoreApplyOptions,
    clusterRevision: string,
  ): Promise<{ kv?: IKeyValue; value?: string }> {
    if (options.fieldManager === undefined) return {};
    const response = await this.namespace.get(applyOwnershipKey(key)).revision(clusterRevision).exec();
    const kv = keyValue(response);
    let owners: ControlStoreApplyOwnership[] = [];
    if (kv && current) {
      const parsed = parseJson<unknown>(kv.value);
      if (
        !Array.isArray(parsed) || parsed.some((item) => (
          item === null || typeof item !== 'object' ||
          typeof (item as Record<string, unknown>).fieldPath !== 'string' ||
          typeof (item as Record<string, unknown>).manager !== 'string'
        ))
      ) {
        throw new OrchestrationError({
          code: 'INTERNAL',
          message: 'etcd ControlStore apply ownership record is malformed',
          retryable: false,
        });
      }
      owners = parsed as ControlStoreApplyOwnership[];
    }
    const decided = decideControlStoreApplyOwnership(
      current,
      manifest,
      options,
      owners,
    );
    return { kv, value: JSON.stringify(decided) };
  }

  private async idempotentReplay<T>(key: string | undefined, requestDigest: string, action: string): Promise<T | undefined> {
    if (!key) return undefined;
    const value = await this.namespace.get(idempotencyKey(key)).buffer();
    if (!value) return undefined;
    const record = parseJson<IdempotencyRecord<T>>(value);
    if (record.requestDigest !== requestDigest) {
      throw new OrchestrationError({
        code: 'CONFLICT',
        message: `idempotency key was reused for another ${action} request`,
        retryable: false,
      });
    }
    return clone(record.response);
  }

  private leaseResource(grant: ControlLeaseGrant): OrchestrationResource<Record<string, unknown>, Record<string, unknown>> {
    return {
      apiVersion: CONTROL_LEASE_API_VERSION,
      kind: CONTROL_LEASE_KIND,
      metadata: {
        name: grant.name,
        uid: grant.leaseId,
        generation: 1,
        resourceVersion: grant.resourceVersion,
        creationTimestamp: grant.acquiredAt,
      },
      spec: { holder: grant.holder },
      status: { leaseId: grant.leaseId, epoch: grant.epoch, renewedAt: grant.renewedAt, expiresAt: grant.expiresAt },
    };
  }

  /**
   * etcd3 1.1.2 passes the three server-streaming arguments to grpc-js in
   * unary order (`metadata, options, request`). That silently works while
   * auth is disabled but drops the token once etcd auth is enabled. Use the
   * package's authenticated/failover connection pool with grpc-js's correct
   * `request, metadata, options` order until the upstream client fixes it.
   */
  private async openSnapshotStream(): Promise<IResponseStream<ISnapshotResponse>> {
    const pool = maintenanceConnectionPool(this.client.maintenance);
    return await pool.withConnection('Maintenance', ({ client, metadata, resource }) => {
      const stream = client.snapshot({}, metadata, {});
      stream.on('error', (error) => {
        pool.markFailed(resource, error);
      });
      return stream;
    });
  }

  /** Read at most one bounded etcd range response, after an exclusive key. */
  private async rangePage(
    prefix: string,
    clusterRevision: string | undefined,
    cursor: string | undefined,
    limit: number,
  ): Promise<IKeyValue[]> {
    const prefixRange = Range.prefix(prefix);
    const range = cursor
      ? { start: incrementKey(cursor), end: prefixRange.end }
      : prefixRange;
    const builder = this.namespace.getAll()
      .inRange(range)
      .sort('Key', 'Ascend')
      .limit(limit);
    if (clusterRevision !== undefined) builder.revision(clusterRevision);
    const response = await builder.exec();
    return response.kvs;
  }

  /**
   * Rebuild a historical snapshot in bounded replay batches.  etcd only
   * stores the append-only event index, so a historical view needs one latest
   * event per key; cap that index rather than allowing an attacker-controlled
   * history to become an unbounded JavaScript map.
   */
  private async historicalResourcesAt(meta: MetaState, resourceVersion: bigint): Promise<Map<string, StoredEvent>> {
    const latest = new Map<string, StoredEvent>();
    let cursor: string | undefined;
    let scanned = 0;
    for (;;) {
      const kvs = await this.rangePage(EVENT_PREFIX, meta.clusterRevision, cursor, CONTROL_STORE_READ_BATCH_SIZE);
      if (kvs.length === 0) break;
      for (const kv of kvs) {
        cursor = kv.key.toString('utf8');
        scanned += 1;
        if (scanned > CONTROL_STORE_MAX_HISTORY_EVENTS) {
          throw new OrchestrationError({
            code: 'EXHAUSTED',
            message: 'ControlStore historical resource replay exceeded its bounded scan',
            retryable: true,
          });
        }
        const stored = parseJson<StoredEvent>(kv.value);
        const version = BigInt(stored.resource.metadata.resourceVersion);
        if (version > resourceVersion) continue;
        latest.set(resourceKey(referenceFor(stored.resource)), stored);
        if (latest.size > CONTROL_STORE_MAX_COMPACTION_KEYS) {
          throw new OrchestrationError({
            code: 'EXHAUSTED',
            message: 'ControlStore historical resource index exceeded its bounded size',
            retryable: true,
          });
        }
      }
      if (kvs.length < CONTROL_STORE_READ_BATCH_SIZE) break;
    }
    return latest;
  }

  public async get<TSpec = Record<string, unknown>, TStatus = OrchestrationResourceStatus>(
    reference: OrchestrationResourceReference,
    options: OrchestrationGetOptions = {},
  ): Promise<OrchestrationResource<TSpec, TStatus> | null> {
    return await this.operation(async () => {
      const meta = await this.metaAt();
      const requestedRevision = parseResourceVersion(options.resourceVersion, meta.revision);
      if (requestedRevision > meta.revision) {
        throw new OrchestrationError({
          code: 'CONFLICT',
          message: 'requested resourceVersion is newer than the current resource',
          retryable: true,
        });
      }
      const current = await this.currentResource<TSpec, TStatus>(reference);
      return current ? clone(current.resource) : null;
    });
  }

  public async list<TSpec = Record<string, unknown>, TStatus = OrchestrationResourceStatus>(
    query: OrchestrationResourceQuery,
    options: OrchestrationListOptions = {},
  ): Promise<OrchestrationResourceList<TSpec, TStatus>> {
    return await this.operation(async () => {
      const queryHash = digest(query);
      const token = options.continueToken ? decodeContinueToken(options.continueToken) : undefined;
      if (token && token.queryDigest !== queryHash) {
        throw new OrchestrationError({ code: 'INVALID', message: 'continue token belongs to another query', retryable: false });
      }
      if (token && options.resourceVersion !== undefined && options.resourceVersion !== token.resourceVersion) {
        throw new OrchestrationError({ code: 'INVALID', message: 'continue token resourceVersion does not match request', retryable: false });
      }
      const meta = await this.metaAt();
      const version = parseResourceVersion(token?.resourceVersion ?? options.resourceVersion, meta.revision);
      if (version < meta.compacted) {
        throw new OrchestrationError({
          code: 'WATCH_COMPACTED',
          message: `resourceVersion ${version} was compacted`,
          retryable: true,
        });
      }
      if (version > meta.revision) {
        throw new OrchestrationError({ code: 'CONFLICT', message: 'requested resourceVersion is newer than the store', retryable: true });
      }
      const limit = normalizeListLimit(options.limit);
      let cursor = token?.cursor;
      let exhausted = false;
      let scanned = 0;
      const items: Array<OrchestrationResource<TSpec, TStatus>> = [];

      if (version === meta.revision) {
        while (items.length < limit && scanned < CONTROL_STORE_MAX_SCAN_ROWS) {
          const batchLimit = Math.min(CONTROL_STORE_READ_BATCH_SIZE, CONTROL_STORE_MAX_SCAN_ROWS - scanned);
          const kvs = await this.rangePage(RESOURCE_PREFIX, meta.clusterRevision, cursor, batchLimit);
          if (kvs.length === 0) {
            exhausted = true;
            break;
          }
          scanned += kvs.length;
          let consumed = 0;
          let pageFull = false;
          for (const kv of kvs) {
            consumed += 1;
            cursor = kv.key.toString('utf8');
            const resource = parseJson<OrchestrationResource<TSpec, TStatus>>(kv.value);
            if (!matchesQuery(resource as OrchestrationResource, query)) continue;
            items.push(resource);
            if (items.length >= limit) {
              pageFull = true;
              break;
            }
          }
          if (pageFull) {
            exhausted = consumed >= kvs.length && kvs.length < batchLimit;
            break;
          }
          if (kvs.length < batchLimit) {
            exhausted = true;
            break;
          }
        }
      } else {
        const latest = await this.historicalResourcesAt(meta, version);
        const ordered = [...latest.entries()]
          .filter(([, stored]) => stored.type !== 'DELETED' && matchesQuery(stored.resource, query))
          .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
        const historicalCursor = cursor;
        const start = historicalCursor === undefined
          ? 0
          : ordered.findIndex(([key]) => key > historicalCursor);
        const first = start < 0 ? ordered.length : start;
        const page = ordered.slice(first, first + limit);
        items.push(...page.map(([, stored]) => stored.resource as OrchestrationResource<TSpec, TStatus>));
        const last = page[page.length - 1];
        if (!last || first + page.length >= ordered.length) {
          exhausted = true;
        } else {
          cursor = last[0];
        }
      }
      const hasMore = !exhausted && cursor !== undefined;
      const continueCursor = cursor;
      return {
        items: clone(items),
        resourceVersion: version.toString(),
        ...(hasMore && continueCursor !== undefined
          ? { continueToken: encodeContinueToken({ queryDigest: queryHash, resourceVersion: version.toString(), cursor: continueCursor }) }
          : {}),
      };
    });
  }

  public watch<TSpec = Record<string, unknown>, TStatus = OrchestrationResourceStatus>(
    query: OrchestrationResourceQuery,
    options: OrchestrationWatchOptions = {},
  ): AsyncIterable<OrchestrationWatchEvent<TSpec, TStatus>> {
    return this.watchEvents(query, options);
  }

  private async *watchEvents<TSpec, TStatus>(
    query: OrchestrationResourceQuery,
    options: OrchestrationWatchOptions,
  ): AsyncIterable<OrchestrationWatchEvent<TSpec, TStatus>> {
    let watcher: Watcher | undefined;
    const queue = new AsyncEventQueue<StoredEvent>();
    let timer: NodeJS.Timeout | undefined;
    const startedAt = Date.now();
    const abort = (): void => {
      queue.end();
    };
    try {
      this.assertOpen();
      await this.ensureReady();
      this.activeWatchQueues.add(queue);
      const meta = await this.metaAt();
      let cursor = parseResourceVersion(options.resourceVersion, meta.revision);
      if (cursor > meta.revision) {
        yield {
          type: 'ERROR',
          resourceVersion: meta.revision.toString(),
          terminal: true,
          error: {
            code: 'INVALID',
            message: `invalid watch resourceVersion '${options.resourceVersion}'`,
            retryable: false,
          },
        };
        return;
      }
      if (cursor < meta.compacted) {
        yield {
          type: 'ERROR',
          resourceVersion: meta.compacted.toString(),
          terminal: true,
          error: {
            code: 'WATCH_COMPACTED',
            message: `resourceVersion ${cursor} was compacted`,
            retryable: true,
          },
        };
        return;
      }
      if (options.sendInitialEvents) {
        let resourceCursor: string | undefined;
        for (;;) {
          if (options.signal?.aborted || this.closed) return;
          if (options.timeoutMs !== undefined && Date.now() - startedAt >= options.timeoutMs) return;
          const kvs = await this.rangePage(
            RESOURCE_PREFIX,
            meta.clusterRevision,
            resourceCursor,
            CONTROL_STORE_READ_BATCH_SIZE,
          );
          if (kvs.length === 0) break;
          for (const kv of kvs) {
            if (options.signal?.aborted || this.closed) return;
            if (options.timeoutMs !== undefined && Date.now() - startedAt >= options.timeoutMs) return;
            resourceCursor = kv.key.toString('utf8');
            const resource = parseJson<OrchestrationResource>(kv.value);
            if (!matchesQuery(resource, query)) continue;
            yield {
              type: 'ADDED',
              resourceVersion: meta.revision.toString(),
              resource: clone(resource) as OrchestrationResource<TSpec, TStatus>,
            };
          }
          if (kvs.length < CONTROL_STORE_READ_BATCH_SIZE) break;
        }
        cursor = meta.revision;
        yield { type: 'BOOKMARK', resourceVersion: cursor.toString() };
      }

      watcher = await this.namespace.watch()
        .prefix(EVENT_PREFIX)
        .startRevision((BigInt(meta.clusterRevision) + 1n).toString())
        .create();
      watcher.on('put', (kv) => {
        try {
          queue.push(parseJson<StoredEvent>(kv.value));
        } catch (error) {
          queue.fail(error instanceof Error ? error : new Error(String(error)));
        }
      });
      watcher.on('error', (error) => {
        queue.fail(error);
      });
      watcher.on('end', () => {
        queue.end();
      });

      // Re-read through the newest linearizable revision after handlers are
      // attached. This closes the small interval between the snapshot and
      // Watcher's `create()` resolution; queued duplicates are removed by the
      // logical cursor below.
      let backlogCursor: string | undefined;
      for (;;) {
        if (options.signal?.aborted || this.closed) return;
        if (options.timeoutMs !== undefined && Date.now() - startedAt >= options.timeoutMs) return;
        const kvs = await this.rangePage(EVENT_PREFIX, undefined, backlogCursor, CONTROL_STORE_READ_BATCH_SIZE);
        if (kvs.length === 0) break;
        for (const kv of kvs) {
          if (options.signal?.aborted || this.closed) return;
          backlogCursor = kv.key.toString('utf8');
          const stored = parseJson<StoredEvent>(kv.value);
          const version = BigInt(stored.resource.metadata.resourceVersion);
          if (version <= cursor) continue;
          if (matchesQuery(stored.resource, query)) {
            yield {
              type: stored.type,
              resourceVersion: stored.resource.metadata.resourceVersion,
              resource: clone(stored.resource) as OrchestrationResource<TSpec, TStatus>,
            };
          }
          cursor = version;
        }
        if (kvs.length < CONTROL_STORE_READ_BATCH_SIZE) break;
      }

      if (options.timeoutMs !== undefined) {
        const remaining = Math.max(0, options.timeoutMs - (Date.now() - startedAt));
        timer = setTimeout(() => {
          queue.end();
        }, remaining);
      }
      options.signal?.addEventListener('abort', abort, { once: true });
      for (;;) {
        if (options.signal?.aborted || this.closed) return;
        if (options.timeoutMs !== undefined && Date.now() - startedAt >= options.timeoutMs) return;
        const next = await queue.next();
        if (next.done) return;
        const version = BigInt(next.value.resource.metadata.resourceVersion);
        if (version <= cursor) continue;
        cursor = version;
        if (!matchesQuery(next.value.resource, query)) continue;
        yield {
          type: next.value.type,
          resourceVersion: version.toString(),
          resource: clone(next.value.resource) as OrchestrationResource<TSpec, TStatus>,
        };
      }
    } catch (error) {
      const source = error instanceof Error ? error : new Error(String(error));
      yield {
        type: 'ERROR',
        resourceVersion: '0',
        terminal: true,
        error: {
          code: isRecoverableError(source) ? 'UNAVAILABLE' : 'INTERNAL',
          message: `etcd ControlStore watch: ${source.message}`,
          retryable: isRecoverableError(source),
        },
      };
    } finally {
      this.activeWatchQueues.delete(queue);
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener('abort', abort);
      await watcher?.cancel().catch(() => undefined);
    }
  }

  public async create<TSpec = Record<string, unknown>, TStatus = OrchestrationResourceStatus>(
    actor: ControlStoreActor,
    manifest: OrchestrationResourceManifest<TSpec>,
    options: ControlStoreCreateOptions = {},
  ): Promise<OrchestrationResource<TSpec, TStatus>> {
    return await this.operation(async () => {
      const reference = referenceFor(manifest);
      const key = resourceKey(reference);
      const requestDigest = digest({ actor, manifest });
      const replayKey = options.idempotencyKey
        ? `create:${options.idempotencyKey}`
        : undefined;
      const replay = await this.idempotentReplay<OrchestrationResource<TSpec, TStatus>>(
        replayKey,
        requestDigest,
        'create',
      );
      if (replay) return replay;

      for (let attempt = 0; attempt < MAX_TRANSACTION_RETRIES; attempt += 1) {
        const meta = await this.metaAt();
        const current = await this.currentResource(reference, meta.clusterRevision);
        if (current) {
          const racedReplay = await this.idempotentReplay<OrchestrationResource<TSpec, TStatus>>(
            replayKey,
            requestDigest,
            'create',
          );
          if (racedReplay) return racedReplay;
          throw new OrchestrationError({
            code: 'CONFLICT',
            message: `resource '${reference.name}' already exists`,
            retryable: false,
          });
        }
        this.authorizer.authorize({
          actor,
          verb: 'create',
          reference,
          proposedResource: manifest as OrchestrationResourceManifest,
        });
        const revision = options.dryRun ? meta.revision : meta.revision + 1n;
        const created: OrchestrationResource<TSpec, TStatus> = {
          apiVersion: manifest.apiVersion,
          kind: manifest.kind,
          metadata: {
            ...clone(manifest.metadata),
            name: manifest.metadata.name!,
            uid: this.uid(),
            generation: 1,
            resourceVersion: revision.toString(),
            creationTimestamp: this.now().toISOString(),
          },
          spec: clone(manifest.spec),
        };
        if (options.dryRun) return created;
        let transaction = this.namespace.if(META_REVISION_KEY, 'Mod', '==', meta.revisionModRevision)
          .and(key, 'Create', '==', 0);
        if (replayKey) transaction = transaction.and(idempotencyKey(replayKey), 'Create', '==', 0);
        const operations = [
          this.namespace.put(META_REVISION_KEY).value(revision.toString()),
          this.namespace.put(key).value(JSON.stringify(created)),
          this.namespace.put(eventKey(revision)).value(JSON.stringify(
            {
              type: 'ADDED',
              resource: created as OrchestrationResource,
            } satisfies StoredEvent,
          )),
        ];
        if (replayKey) {
          operations.push(
            this.namespace.put(idempotencyKey(replayKey)).value(JSON.stringify(
              {
                requestDigest,
                response: created,
              } satisfies IdempotencyRecord<OrchestrationResource<TSpec, TStatus>>,
            )),
          );
        }
        const result = await transaction.then(...operations).commit();
        if (result.succeeded) return clone(created);
        const racedReplay = await this.idempotentReplay<OrchestrationResource<TSpec, TStatus>>(
          replayKey,
          requestDigest,
          'create',
        );
        if (racedReplay) return racedReplay;
      }
      throw new OrchestrationError({ code: 'CONFLICT', message: 'create transaction remained contended', retryable: true });
    });
  }

  public async apply<TSpec = Record<string, unknown>, TStatus = OrchestrationResourceStatus>(
    actor: ControlStoreActor,
    manifest: OrchestrationResourceManifest<TSpec>,
    options: ControlStoreApplyOptions = {},
  ): Promise<OrchestrationResource<TSpec, TStatus>> {
    return await this.operation(async () => {
      const reference = referenceFor(manifest);
      const key = resourceKey(reference);
      const expectedResourceVersion = validateControlStoreApplyOptions(options);
      const replayKey = options.idempotencyKey
        ? `apply:${options.idempotencyKey}`
        : undefined;
      const requestDigest = digest((controlStoreApplyRequestPayload as (
        actor: ControlStoreActor,
        manifest: OrchestrationResourceManifest,
        options: ControlStoreApplyOptions,
      ) => Record<string, unknown>)(actor, manifest as OrchestrationResourceManifest, options));
      const replay = await this.idempotentReplay<
        OrchestrationResource<TSpec, TStatus>
      >(replayKey, requestDigest, 'apply');
      if (replay) return replay;

      for (let attempt = 0; attempt < MAX_TRANSACTION_RETRIES; attempt += 1) {
        const meta = await this.metaAt();
        const current = await this.currentResource<TSpec, TStatus>(
          reference,
          meta.clusterRevision,
        );
        assertControlStoreApplyPreconditions(
          current?.resource as OrchestrationResource | undefined ?? null,
          options,
          expectedResourceVersion,
        );
        const ownership = await this.prepareApplyOwnership(
          key,
          current?.resource as OrchestrationResource | undefined ?? null,
          manifest as OrchestrationResourceManifest,
          options,
          meta.clusterRevision,
        );
        if (
          current &&
          controlStoreApplyMatches(
            current.resource as OrchestrationResource,
            manifest as OrchestrationResourceManifest,
          )
        ) {
          if (options.dryRun) return clone(current.resource);
          if (!replayKey && options.fieldManager === undefined) return clone(current.resource);
          let transaction = this.namespace.if(
            key,
            'Mod',
            '==',
            current.kv.mod_revision,
          );
          if (ownership.value !== undefined) {
            transaction = transaction.and(
              applyOwnershipKey(key),
              ownership.kv ? 'Mod' : 'Create',
              '==',
              ownership.kv?.mod_revision ?? 0,
            );
          }
          const operations = [] as Array<ReturnType<typeof this.namespace.put>>;
          if (ownership.value !== undefined) {
            operations.push(this.namespace.put(applyOwnershipKey(key)).value(ownership.value));
          }
          if (replayKey) {
            transaction = transaction.and(
              idempotencyKey(replayKey),
              'Create',
              '==',
              0,
            );
            operations.push(
              this.namespace.put(idempotencyKey(replayKey)).value(JSON.stringify(
                {
                  requestDigest,
                  response: current.resource,
                } satisfies IdempotencyRecord<OrchestrationResource<TSpec, TStatus>>,
              )),
            );
          }
          const result = await transaction.then(...operations).commit();
          if (result.succeeded) return clone(current.resource);
          const racedReplay = await this.idempotentReplay<
            OrchestrationResource<TSpec, TStatus>
          >(replayKey, requestDigest, 'apply');
          if (racedReplay) return racedReplay;
          continue;
        }
        this.authorizer.authorize({
          actor,
          verb: 'apply',
          reference,
          ...(current ? { current: current.resource as OrchestrationResource } : {}),
          proposedResource: manifest as OrchestrationResourceManifest,
        });
        const revision = options.dryRun ? meta.revision : meta.revision + 1n;
        const specChanged = current
          ? canonicalControlStoreValue(current.resource.spec) !==
            canonicalControlStoreValue(manifest.spec)
          : true;
        const applied: OrchestrationResource<TSpec, TStatus> = current
          ? {
            ...current.resource,
            metadata: {
              ...current.resource.metadata,
              ...clone(manifest.metadata),
              name: current.resource.metadata.name,
              namespace: current.resource.metadata.namespace,
              uid: current.resource.metadata.uid,
              generation: current.resource.metadata.generation + (specChanged ? 1 : 0),
              resourceVersion: revision.toString(),
              creationTimestamp: current.resource.metadata.creationTimestamp,
            },
            spec: clone(manifest.spec),
          }
          : {
            apiVersion: manifest.apiVersion,
            kind: manifest.kind,
            metadata: {
              ...clone(manifest.metadata),
              name: manifest.metadata.name!,
              uid: this.uid(),
              generation: 1,
              resourceVersion: revision.toString(),
              creationTimestamp: this.now().toISOString(),
            },
            spec: clone(manifest.spec),
          };
        if (options.dryRun) return applied;
        let transaction = this.namespace
          .if(META_REVISION_KEY, 'Mod', '==', meta.revisionModRevision)
          .and(
            key,
            current ? 'Mod' : 'Create',
            '==',
            current ? current.kv.mod_revision : 0,
          );
        if (ownership.value !== undefined) {
          transaction = transaction.and(
            applyOwnershipKey(key),
            ownership.kv ? 'Mod' : 'Create',
            '==',
            ownership.kv?.mod_revision ?? 0,
          );
        }
        if (replayKey) {
          transaction = transaction.and(
            idempotencyKey(replayKey),
            'Create',
            '==',
            0,
          );
        }
        const operations = [
          this.namespace.put(META_REVISION_KEY).value(revision.toString()),
          this.namespace.put(key).value(JSON.stringify(applied)),
          this.namespace.put(eventKey(revision)).value(JSON.stringify(
            {
              type: current ? 'MODIFIED' : 'ADDED',
              resource: applied as OrchestrationResource,
            } satisfies StoredEvent,
          )),
        ];
        if (ownership.value !== undefined) {
          operations.push(this.namespace.put(applyOwnershipKey(key)).value(ownership.value));
        }
        if (replayKey) {
          operations.push(
            this.namespace.put(idempotencyKey(replayKey)).value(JSON.stringify(
              {
                requestDigest,
                response: applied,
              } satisfies IdempotencyRecord<OrchestrationResource<TSpec, TStatus>>,
            )),
          );
        }
        const result = await transaction.then(...operations).commit();
        if (result.succeeded) return clone(applied);
        const racedReplay = await this.idempotentReplay<
          OrchestrationResource<TSpec, TStatus>
        >(replayKey, requestDigest, 'apply');
        if (racedReplay) return racedReplay;
      }
      throw new OrchestrationError({
        code: 'CONFLICT',
        message: 'apply transaction remained contended',
        retryable: true,
      });
    });
  }

  public async updateStatus<TSpec = Record<string, unknown>, TStatus = OrchestrationResourceStatus>(
    actor: ControlStoreActor,
    reference: OrchestrationResourceReference,
    status: TStatus,
    options: ControlStoreStatusUpdateOptions,
  ): Promise<OrchestrationResource<TSpec, TStatus>> {
    return await this.operation(async () => {
      const key = resourceKey(reference);
      const requestDigest = digest({ actor, reference, status, resourceVersion: options.resourceVersion });
      const replayKey = options.idempotencyKey
        ? `status:${options.idempotencyKey}`
        : undefined;
      const replay = await this.idempotentReplay<OrchestrationResource<TSpec, TStatus>>(
        replayKey,
        requestDigest,
        'status update',
      );
      if (replay) return replay;
      for (let attempt = 0; attempt < MAX_TRANSACTION_RETRIES; attempt += 1) {
        const meta = await this.metaAt();
        const current = await this.currentResource<TSpec, TStatus>(reference, meta.clusterRevision);
        if (!current) {
          throw new OrchestrationError({ code: 'NOT_FOUND', message: `resource '${reference.name}' not found`, retryable: false });
        }
        if (current.resource.metadata.resourceVersion !== options.resourceVersion) {
          const racedReplay = await this.idempotentReplay<OrchestrationResource<TSpec, TStatus>>(
            replayKey,
            requestDigest,
            'status update',
          );
          if (racedReplay) return racedReplay;
          throw new OrchestrationError({
            code: 'CONFLICT',
            message: 'resourceVersion precondition failed',
            retryable: true,
            details: { expected: options.resourceVersion, current: current.resource.metadata.resourceVersion },
          });
        }
        this.authorizer.authorize({
          actor,
          verb: 'update-status',
          reference,
          current: current.resource as OrchestrationResource,
          proposedStatus: status as OrchestrationResourceStatus,
        });
        const revision = options.dryRun ? meta.revision : meta.revision + 1n;
        const updated: OrchestrationResource<TSpec, TStatus> = {
          ...current.resource,
          metadata: { ...current.resource.metadata, resourceVersion: revision.toString() },
          status: clone(status),
        };
        if (options.dryRun) return updated;
        let transaction = this.namespace.if(META_REVISION_KEY, 'Mod', '==', meta.revisionModRevision)
          .and(key, 'Mod', '==', current.kv.mod_revision);
        if (replayKey) transaction = transaction.and(idempotencyKey(replayKey), 'Create', '==', 0);
        const operations = [
          this.namespace.put(META_REVISION_KEY).value(revision.toString()),
          this.namespace.put(key).value(JSON.stringify(updated)),
          this.namespace.put(eventKey(revision)).value(JSON.stringify(
            {
              type: 'MODIFIED',
              resource: updated as OrchestrationResource,
            } satisfies StoredEvent,
          )),
        ];
        if (replayKey) {
          operations.push(
            this.namespace.put(idempotencyKey(replayKey)).value(JSON.stringify(
              {
                requestDigest,
                response: updated,
              } satisfies IdempotencyRecord<OrchestrationResource<TSpec, TStatus>>,
            )),
          );
        }
        const result = await transaction.then(...operations).commit();
        if (result.succeeded) return clone(updated);
      }
      throw new OrchestrationError({ code: 'CONFLICT', message: 'status transaction remained contended', retryable: true });
    });
  }

  public async delete(
    actor: ControlStoreActor,
    reference: OrchestrationResourceReference,
    options: OrchestrationDeleteOptions = {},
  ): Promise<OrchestrationDeleteResult> {
    return await this.operation(async () => {
      const key = resourceKey(reference);
      const requestDigest = digest({
        actor,
        reference,
        preconditions: options.preconditions,
        propagationPolicy: options.propagationPolicy,
      });
      const replayKey = options.idempotencyKey
        ? `delete:${options.idempotencyKey}`
        : undefined;
      const replay = await this.idempotentReplay<OrchestrationDeleteResult>(
        replayKey,
        requestDigest,
        'delete',
      );
      if (replay) return replay;
      for (let attempt = 0; attempt < MAX_TRANSACTION_RETRIES; attempt += 1) {
        const meta = await this.metaAt();
        const current = await this.currentResource(reference, meta.clusterRevision);
        if (!current) return { accepted: false, reference };
        if (options.preconditions?.uid && current.resource.metadata.uid !== options.preconditions.uid) {
          throw new OrchestrationError({ code: 'CONFLICT', message: 'delete UID precondition failed', retryable: false });
        }
        if (
          options.preconditions?.resourceVersion &&
          current.resource.metadata.resourceVersion !== options.preconditions.resourceVersion
        ) {
          throw new OrchestrationError({ code: 'CONFLICT', message: 'delete resourceVersion precondition failed', retryable: true });
        }
        if (
          options.preconditions?.generation !== undefined &&
          current.resource.metadata.generation !== options.preconditions.generation
        ) {
          throw new OrchestrationError({ code: 'CONFLICT', message: 'delete generation precondition failed', retryable: true });
        }
        this.authorizer.authorize({ actor, verb: 'delete', reference, current: current.resource });
        if (options.dryRun) return { accepted: true, reference };
        const revision = meta.revision + 1n;
        const pending = (current.resource.metadata.finalizers?.length ?? 0) > 0 && !current.resource.metadata.deletionTimestamp;
        const resource = {
          ...current.resource,
          metadata: {
            ...current.resource.metadata,
            ...(pending ? { deletionTimestamp: this.now().toISOString() } : {}),
            resourceVersion: revision.toString(),
          },
        };
        const accepted: OrchestrationDeleteResult = { accepted: true, reference };
        let transaction = this.namespace.if(
          META_REVISION_KEY,
          'Mod',
          '==',
          meta.revisionModRevision,
        ).and(key, 'Mod', '==', current.kv.mod_revision);
        if (replayKey) {
          transaction = transaction.and(
            idempotencyKey(replayKey),
            'Create',
            '==',
            0,
          );
        }
        const operations = [
          this.namespace.put(META_REVISION_KEY).value(revision.toString()),
          pending ? this.namespace.put(key).value(JSON.stringify(resource)) : this.namespace.delete().key(key),
          ...(pending ? [] : [this.namespace.delete().key(applyOwnershipKey(key))]),
          this.namespace.put(eventKey(revision)).value(JSON.stringify(
            {
              type: pending ? 'MODIFIED' : 'DELETED',
              resource,
            } satisfies StoredEvent,
          )),
        ];
        if (replayKey) {
          operations.push(
            this.namespace.put(idempotencyKey(replayKey)).value(JSON.stringify(
              {
                requestDigest,
                response: accepted,
              } satisfies IdempotencyRecord<OrchestrationDeleteResult>,
            )),
          );
        }
        const result = await transaction.then(...operations).commit();
        if (result.succeeded) return accepted;
        const racedReplay = await this.idempotentReplay<OrchestrationDeleteResult>(
          replayKey,
          requestDigest,
          'delete',
        );
        if (racedReplay) return racedReplay;
      }
      throw new OrchestrationError({ code: 'CONFLICT', message: 'delete transaction remained contended', retryable: true });
    });
  }

  public async acquireLease(actor: ControlStoreActor, request: ControlLeaseRequest): Promise<ControlLeaseGrant> {
    return await this.operation(async () => {
      if (!request.name || !request.holder || !Number.isSafeInteger(request.ttlMs) || request.ttlMs <= 0) {
        throw new OrchestrationError({
          code: 'INVALID',
          message: 'lease name, holder, and positive ttlMs are required',
          retryable: false,
        });
      }
      const reference = { apiVersion: CONTROL_LEASE_API_VERSION, kind: CONTROL_LEASE_KIND, name: request.name };
      this.authorizer.authorize({ actor, verb: 'acquire-lease', reference });
      for (let attempt = 0; attempt < MAX_TRANSACTION_RETRIES; attempt += 1) {
        const native = await this.namespace.leaseClient.leaseGrant({ TTL: Math.max(1, Math.ceil(request.ttlMs / 1000)) });
        let committed = false;
        try {
          const meta = await this.metaAt();
          const currentResponse = await this.namespace.get(leaseKey(request.name)).revision(meta.clusterRevision).exec();
          const currentKv = keyValue(currentResponse);
          const current = currentKv ? parseJson<StoredLease>(currentKv.value) : undefined;
          const acquiredAt = this.now();
          if (current && Date.parse(current.expiresAt) > acquiredAt.getTime()) {
            throw new OrchestrationError({
              code: 'CONFLICT',
              message: `lease '${request.name}' is held by '${current.holder}'`,
              retryable: true,
            });
          }
          const epochResponse = await this.namespace.get(leaseEpochKey(request.name)).revision(meta.clusterRevision).exec();
          const epochKv = keyValue(epochResponse);
          const epoch = BigInt(epochKv?.value.toString('utf8') ?? '0') + 1n;
          const revision = meta.revision + 1n;
          const grant: ControlLeaseGrant = {
            name: request.name,
            holder: request.holder,
            leaseId: this.uid(),
            epoch: epoch.toString(),
            acquiredAt: acquiredAt.toISOString(),
            renewedAt: acquiredAt.toISOString(),
            expiresAt: new Date(acquiredAt.getTime() + request.ttlMs).toISOString(),
            resourceVersion: revision.toString(),
          };
          const stored: StoredLease = { ...grant, nativeLeaseId: native.ID };
          const resource = this.leaseResource(grant);
          let transaction = this.namespace.if(META_REVISION_KEY, 'Mod', '==', meta.revisionModRevision);
          transaction = currentKv
            ? transaction.and(leaseKey(request.name), 'Mod', '==', currentKv.mod_revision)
            : transaction.and(leaseKey(request.name), 'Create', '==', 0);
          transaction = epochKv
            ? transaction.and(leaseEpochKey(request.name), 'Mod', '==', epochKv.mod_revision)
            : transaction.and(leaseEpochKey(request.name), 'Create', '==', 0);
          const result = await transaction.then(
            this.namespace.put(META_REVISION_KEY).value(revision.toString()),
            this.namespace.put(leaseEpochKey(request.name)).value(epoch.toString()),
            this.namespace.put(leaseKey(request.name)).value(JSON.stringify(stored)).lease(native.ID),
            this.namespace.put(resourceKey(reference)).value(JSON.stringify(resource)),
            this.namespace.put(eventKey(revision)).value(JSON.stringify(
              {
                type: epoch > 1n ? 'MODIFIED' : 'ADDED',
                resource,
              } satisfies StoredEvent,
            )),
          ).commit();
          if (!result.succeeded) continue;
          committed = true;
          if (current?.nativeLeaseId) {
            await this.namespace.leaseClient.leaseRevoke({ ID: current.nativeLeaseId }).catch(() => undefined);
          }
          return clone(grant);
        } finally {
          if (!committed) {
            await this.namespace.leaseClient.leaseRevoke({ ID: native.ID }).catch(() => undefined);
          }
        }
      }
      throw new OrchestrationError({ code: 'CONFLICT', message: 'lease acquisition remained contended', retryable: true });
    });
  }

  public async renewLease(
    actor: ControlStoreActor,
    identity: ControlLeaseIdentity,
    ttlMs: number,
  ): Promise<ControlLeaseGrant> {
    return await this.operation(async () => {
      if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) {
        throw new OrchestrationError({ code: 'INVALID', message: 'positive lease ttlMs is required', retryable: false });
      }
      const reference = { apiVersion: CONTROL_LEASE_API_VERSION, kind: CONTROL_LEASE_KIND, name: identity.name };
      this.authorizer.authorize({ actor, verb: 'renew-lease', reference });
      const native = await this.namespace.leaseClient.leaseGrant({ TTL: Math.max(1, Math.ceil(ttlMs / 1000)) });
      let committed = false;
      try {
        for (let attempt = 0; attempt < MAX_TRANSACTION_RETRIES; attempt += 1) {
          const meta = await this.metaAt();
          const currentResponse = await this.namespace.get(leaseKey(identity.name)).revision(meta.clusterRevision).exec();
          const currentKv = keyValue(currentResponse);
          const current = currentKv ? parseJson<StoredLease>(currentKv.value) : undefined;
          const renewedAt = this.now();
          if (
            !current ||
            current.holder !== identity.holder ||
            current.leaseId !== identity.leaseId ||
            current.epoch !== identity.epoch ||
            Date.parse(current.expiresAt) <= renewedAt.getTime()
          ) {
            throw new OrchestrationError({
              code: 'STALE_EPOCH',
              message: `lease '${identity.name}' identity is stale`,
              retryable: false,
            });
          }
          const revision = meta.revision + 1n;
          const grant: ControlLeaseGrant = {
            ...identity,
            acquiredAt: current.acquiredAt,
            renewedAt: renewedAt.toISOString(),
            expiresAt: new Date(renewedAt.getTime() + ttlMs).toISOString(),
            resourceVersion: revision.toString(),
          };
          const stored: StoredLease = { ...grant, nativeLeaseId: native.ID };
          const resource = this.leaseResource(grant);
          const result = await this.namespace.if(META_REVISION_KEY, 'Mod', '==', meta.revisionModRevision)
            .and(leaseKey(identity.name), 'Mod', '==', currentKv!.mod_revision)
            .then(
              this.namespace.put(META_REVISION_KEY).value(revision.toString()),
              this.namespace.put(leaseKey(identity.name)).value(JSON.stringify(stored)).lease(native.ID),
              this.namespace.put(resourceKey(reference)).value(JSON.stringify(resource)),
              this.namespace.put(eventKey(revision)).value(JSON.stringify({ type: 'MODIFIED', resource } satisfies StoredEvent)),
            )
            .commit();
          if (!result.succeeded) continue;
          committed = true;
          await this.namespace.leaseClient.leaseRevoke({ ID: current.nativeLeaseId }).catch(() => undefined);
          return clone(grant);
        }
        throw new OrchestrationError({ code: 'CONFLICT', message: 'lease renewal remained contended', retryable: true });
      } finally {
        if (!committed) {
          await this.namespace.leaseClient.leaseRevoke({ ID: native.ID }).catch(() => undefined);
        }
      }
    });
  }

  public async releaseLease(actor: ControlStoreActor, identity: ControlLeaseIdentity): Promise<void> {
    await this.operation(async () => {
      const reference = { apiVersion: CONTROL_LEASE_API_VERSION, kind: CONTROL_LEASE_KIND, name: identity.name };
      this.authorizer.authorize({ actor, verb: 'release-lease', reference });
      for (let attempt = 0; attempt < MAX_TRANSACTION_RETRIES; attempt += 1) {
        const meta = await this.metaAt();
        const response = await this.namespace.get(leaseKey(identity.name)).revision(meta.clusterRevision).exec();
        const currentKv = keyValue(response);
        const current = currentKv ? parseJson<StoredLease>(currentKv.value) : undefined;
        if (
          !current ||
          current.holder !== identity.holder ||
          current.leaseId !== identity.leaseId ||
          current.epoch !== identity.epoch
        ) {
          throw new OrchestrationError({
            code: 'STALE_EPOCH',
            message: `lease '${identity.name}' identity is stale`,
            retryable: false,
          });
        }
        const revision = meta.revision + 1n;
        const resource = this.leaseResource({ ...current, resourceVersion: revision.toString() });
        const result = await this.namespace.if(META_REVISION_KEY, 'Mod', '==', meta.revisionModRevision)
          .and(leaseKey(identity.name), 'Mod', '==', currentKv!.mod_revision)
          .then(
            this.namespace.put(META_REVISION_KEY).value(revision.toString()),
            this.namespace.delete().key(leaseKey(identity.name)),
            this.namespace.delete().key(resourceKey(reference)),
            this.namespace.put(eventKey(revision)).value(JSON.stringify({ type: 'DELETED', resource } satisfies StoredEvent)),
          )
          .commit();
        if (!result.succeeded) continue;
        await this.namespace.leaseClient.leaseRevoke({ ID: current.nativeLeaseId }).catch(() => undefined);
        return;
      }
      throw new OrchestrationError({ code: 'CONFLICT', message: 'lease release remained contended', retryable: true });
    });
  }

  public async compact(throughResourceVersion: string): Promise<ControlStoreCompactionResult> {
    return await this.operation(async () => {
      const through = parseResourceVersion(throughResourceVersion, 0n);
      for (let attempt = 0; attempt < MAX_TRANSACTION_RETRIES; attempt += 1) {
        const meta = await this.metaAt();
        if (through > meta.revision) {
          throw new OrchestrationError({
            code: 'INVALID',
            message: 'cannot compact beyond current resourceVersion',
            retryable: false,
          });
        }
        const compacted = through > meta.compacted ? through : meta.compacted;
        if (compacted === meta.compacted) {
          return { compactedThrough: compacted.toString(), resourceVersion: meta.revision.toString() };
        }
        const latestBaseline = new Map<string, string>();
        let eventCursor: string | undefined;
        let scanned = 0;
        let boundaryModRevision: string | undefined;
        for (;;) {
          const kvs = await this.rangePage(EVENT_PREFIX, meta.clusterRevision, eventCursor, CONTROL_STORE_READ_BATCH_SIZE);
          if (kvs.length === 0) break;
          for (const kv of kvs) {
            eventCursor = kv.key.toString('utf8');
            scanned += 1;
            if (scanned > CONTROL_STORE_MAX_HISTORY_EVENTS) {
              throw new OrchestrationError({
                code: 'EXHAUSTED',
                message: 'ControlStore compaction scan exceeded its bounded history',
                retryable: true,
              });
            }
            const stored = parseJson<StoredEvent>(kv.value);
            const version = BigInt(stored.resource.metadata.resourceVersion);
            if (version > compacted) continue;
            const key = resourceKey(referenceFor(stored.resource));
            latestBaseline.set(key, kv.key.toString('utf8'));
            if (version <= compacted) boundaryModRevision = kv.mod_revision;
            if (latestBaseline.size > CONTROL_STORE_MAX_COMPACTION_KEYS) {
              throw new OrchestrationError({
                code: 'EXHAUSTED',
                message: 'ControlStore compaction key index exceeded its bounded size',
                retryable: true,
              });
            }
          }
          if (kvs.length < CONTROL_STORE_READ_BATCH_SIZE) break;
        }
        const result = await this.namespace.if(META_COMPACTED_KEY, 'Mod', '==', meta.compactedModRevision)
          .then(this.namespace.put(META_COMPACTED_KEY).value(compacted.toString()))
          .commit();
        if (!result.succeeded) continue;

        // Replay once more in bounded batches and delete every event that is
        // superseded by a newer event at or below the boundary.  The second
        // pass avoids retaining an unbounded stale-key array between the
        // metadata CAS and deletion work.
        const retained = new Map<string, string>();
        eventCursor = undefined;
        scanned = 0;
        let deleteBatch: string[] = [];
        const flushDeletes = async (): Promise<void> => {
          if (deleteBatch.length === 0) return;
          const pending = deleteBatch;
          deleteBatch = [];
          await Promise.all(pending.map(async (key) => {
            await this.namespace.delete().key(key).exec();
          }));
        };
        for (;;) {
          const kvs = await this.rangePage(EVENT_PREFIX, meta.clusterRevision, eventCursor, CONTROL_STORE_READ_BATCH_SIZE);
          if (kvs.length === 0) break;
          for (const kv of kvs) {
            eventCursor = kv.key.toString('utf8');
            scanned += 1;
            if (scanned > CONTROL_STORE_MAX_HISTORY_EVENTS) {
              throw new OrchestrationError({
                code: 'EXHAUSTED',
                message: 'ControlStore compaction deletion scan exceeded its bounded history',
                retryable: true,
              });
            }
            const stored = parseJson<StoredEvent>(kv.value);
            const version = BigInt(stored.resource.metadata.resourceVersion);
            if (version > compacted) continue;
            const key = resourceKey(referenceFor(stored.resource));
            const previous = retained.get(key);
            if (previous) deleteBatch.push(previous);
            retained.set(key, kv.key.toString('utf8'));
            if (retained.size > CONTROL_STORE_MAX_COMPACTION_KEYS) {
              throw new OrchestrationError({
                code: 'EXHAUSTED',
                message: 'ControlStore compaction deletion index exceeded its bounded size',
                retryable: true,
              });
            }
            if (deleteBatch.length >= CONTROL_STORE_COMPACTION_BATCH_SIZE) await flushDeletes();
          }
          if (kvs.length < CONTROL_STORE_READ_BATCH_SIZE) break;
        }
        await flushDeletes();
        if (this.physicalCompaction && boundaryModRevision) {
          await this.namespace.kv.compact({ revision: boundaryModRevision, physical: false });
        }
        return { compactedThrough: compacted.toString(), resourceVersion: meta.revision.toString() };
      }
      throw new OrchestrationError({ code: 'CONFLICT', message: 'compaction transaction remained contended', retryable: true });
    });
  }

  public async snapshot(targetPath: string): Promise<ControlStoreSnapshotResult> {
    return await this.operation(async () => {
      const meta = await this.metaAt();
      const temporaryPath = `${targetPath}.partial-${this.uid()}`;
      const output = createWriteStream(temporaryPath, { flags: 'wx', mode: 0o600 });
      try {
        const stream = await this.openSnapshotStream();
        const resumable = stream as typeof stream & { pause?: () => void; resume?: () => void };
        await new Promise<void>((resolve, reject) => {
          stream.on('data', (response) => {
            resumable.pause?.();
            output.write(response.blob, (error) => {
              if (error) reject(error);
              else resumable.resume?.();
            });
          });
          stream.on('error', reject);
          stream.on('end', () => output.end(resolve));
          output.on('error', reject);
        });
        await rename(temporaryPath, targetPath);
        return { resourceVersion: meta.revision.toString(), createdAt: this.now().toISOString() };
      } catch (error) {
        output.destroy();
        await rm(temporaryPath, { force: true });
        throw error;
      }
    });
  }

  public async getHealth(): Promise<ControlStoreHealth> {
    return await this.operation(async () => {
      const meta = await this.metaAt();
      const status = await this.client.maintenance.status({});
      const healthy = status.leader !== '0' && status.errors.length === 0;
      return {
        healthy,
        resourceVersion: meta.revision.toString(),
        detail: `etcd member=${status.header.member_id} leader=${status.leader} term=${status.raftTerm} errors=${status.errors.join(',') || 'none'}`,
      };
    });
  }

  /** Linearizable view of the real etcd Raft membership. */
  public async listMembers(): Promise<EtcdControlStoreMember[]> {
    return await this.operation(async () => {
      const response = await this.client.cluster.memberList({ linearizable: true });
      return response.members.map(memberView);
    });
  }

  /** Add a non-voting learner. Start and catch it up before promotion. */
  public async addLearner(peerUrls: string[]): Promise<EtcdControlStoreMember> {
    return await this.operation(async () => {
      if (peerUrls.length === 0) {
        throw new OrchestrationError({ code: 'INVALID', message: 'learner peer URLs are required', retryable: false });
      }
      const response = await this.client.cluster.memberAdd({ peerURLs: peerUrls, isLearner: true });
      return memberView(response.member);
    });
  }

  public async promoteMember(memberId: string): Promise<EtcdControlStoreMember[]> {
    return await this.operation(async () => {
      const response = await this.client.cluster.memberPromote({ ID: memberId });
      return response.members.map(memberView);
    });
  }

  public async removeMember(memberId: string): Promise<EtcdControlStoreMember[]> {
    return await this.operation(async () => {
      const response = await this.client.cluster.memberRemove({ ID: memberId });
      return response.members.map(memberView);
    });
  }

  public async updateMember(memberId: string, peerUrls: string[]): Promise<EtcdControlStoreMember[]> {
    return await this.operation(async () => {
      const response = await this.client.cluster.memberUpdate({ ID: memberId, peerURLs: peerUrls });
      return response.members.map(memberView);
    });
  }

  public async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const queue of this.activeWatchQueues) queue.end();
    this.activeWatchQueues.clear();
    if (this.ownsClient) this.client.close();
  }
}
