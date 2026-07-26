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
  type Watcher,
} from 'etcd3';
import {
  canonicalControlStoreValue,
  type ControlLeaseGrant,
  type ControlLeaseIdentity,
  type ControlLeaseRequest,
  type ControlStore,
  type ControlStoreActor,
  controlStoreApplyMatches,
  type ControlStoreApplyOptions,
  type ControlStoreAuthorizer,
  type ControlStoreCompactionResult,
  type ControlStoreCreateOptions,
  type ControlStoreHealth,
  type ControlStoreSnapshotResult,
  type ControlStoreStatusUpdateOptions,
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
} from 'memeloop';

const CONTROL_LEASE_API_VERSION = 'control.memeloop.io/v1alpha1';
const CONTROL_LEASE_KIND = 'ControlLease';
const META_REVISION_KEY = 'meta/revision';
const META_COMPACTED_KEY = 'meta/compacted';
const RESOURCE_PREFIX = 'resources/';
const EVENT_PREFIX = 'events/';
const IDEMPOTENCY_PREFIX = 'idempotency/';
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
  offset: number;
  queryDigest: string;
  resourceVersion: string;
}

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
// at public ingress and etcd values are written only by this adapter.
// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters
function parseJson<T>(value: Buffer | string): T {
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
    if (!token.queryDigest || !token.resourceVersion || !Number.isSafeInteger(token.offset) || token.offset < 0) {
      throw new Error('invalid token');
    }
    return token;
  } catch {
    throw new OrchestrationError({ code: 'INVALID', message: 'invalid ControlStore continue token', retryable: false });
  }
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

  push(value: T): void {
    if (this.ended) return;
    const waiter = this.waiting.shift();
    if (waiter) waiter.resolve({ done: false, value });
    else this.values.push(value);
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
    type PrivatePool = {
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
    };
    const pool = (this.client.maintenance as unknown as { client: PrivatePool }).client;
    return await pool.withConnection('Maintenance', ({ client, metadata, resource }) => {
      const stream = client.snapshot({}, metadata, {});
      stream.on('error', (error) => {
        pool.markFailed(resource, error);
      });
      return stream;
    });
  }

  private async resourcesAt(meta: MetaState, resourceVersion: bigint): Promise<OrchestrationResource[]> {
    if (resourceVersion === meta.revision) {
      const response = await this.namespace.getAll().prefix(RESOURCE_PREFIX).revision(meta.clusterRevision).exec();
      return response.kvs.map((kv) => parseJson<OrchestrationResource>(kv.value));
    }
    const response = await this.namespace.getAll()
      .prefix(EVENT_PREFIX)
      .revision(meta.clusterRevision)
      .sort('Key', 'Ascend')
      .exec();
    const latest = new Map<string, StoredEvent>();
    for (const kv of response.kvs) {
      const stored = parseJson<StoredEvent>(kv.value);
      const version = BigInt(stored.resource.metadata.resourceVersion);
      if (version > resourceVersion) continue;
      latest.set(resourceKey(referenceFor(stored.resource)), stored);
    }
    return [...latest.values()]
      .filter((stored) => stored.type !== 'DELETED')
      .map((stored) => stored.resource);
  }

  public async get<TSpec = Record<string, unknown>, TStatus = OrchestrationResourceStatus>(
    reference: OrchestrationResourceReference,
    options: OrchestrationGetOptions = {},
  ): Promise<OrchestrationResource<TSpec, TStatus> | null> {
    return await this.operation(async () => {
      const current = await this.currentResource<TSpec, TStatus>(reference);
      if (current && options.resourceVersion && BigInt(current.resource.metadata.resourceVersion) < BigInt(options.resourceVersion)) {
        throw new OrchestrationError({
          code: 'CONFLICT',
          message: 'requested resourceVersion is newer than the current resource',
          retryable: true,
        });
      }
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
      const meta = await this.metaAt();
      const version = BigInt(token?.resourceVersion ?? options.resourceVersion ?? meta.revision);
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
      const all = (await this.resourcesAt(meta, version))
        .filter((resource) => matchesQuery(resource, query))
        .sort((left, right) => resourceKey(referenceFor(left)).localeCompare(resourceKey(referenceFor(right))));
      const offset = token?.offset ?? 0;
      const limit = Math.max(1, options.limit ?? (all.length || 1));
      const items = all.slice(offset, offset + limit) as Array<OrchestrationResource<TSpec, TStatus>>;
      const nextOffset = offset + items.length;
      return {
        items: clone(items),
        resourceVersion: version.toString(),
        ...(nextOffset < all.length
          ? { continueToken: encodeContinueToken({ queryDigest: queryHash, resourceVersion: version.toString(), offset: nextOffset }) }
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
    const abort = (): void => {
      queue.end();
    };
    try {
      this.assertOpen();
      await this.ensureReady();
      this.activeWatchQueues.add(queue);
      const meta = await this.metaAt();
      let cursor = BigInt(options.resourceVersion ?? meta.revision);
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
        for (const resource of (await this.resourcesAt(meta, meta.revision)).filter((item) => matchesQuery(item, query))) {
          yield {
            type: 'ADDED',
            resourceVersion: meta.revision.toString(),
            resource: clone(resource) as OrchestrationResource<TSpec, TStatus>,
          };
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
      const backlog = await this.namespace.getAll().prefix(EVENT_PREFIX).sort('Key', 'Ascend').exec();
      for (const kv of backlog.kvs) {
        const stored = parseJson<StoredEvent>(kv.value);
        if (BigInt(stored.resource.metadata.resourceVersion) <= cursor) continue;
        if (matchesQuery(stored.resource, query)) {
          yield {
            type: stored.type,
            resourceVersion: stored.resource.metadata.resourceVersion,
            resource: clone(stored.resource) as OrchestrationResource<TSpec, TStatus>,
          };
        }
        cursor = BigInt(stored.resource.metadata.resourceVersion);
      }

      if (options.timeoutMs !== undefined) {
        timer = setTimeout(() => {
          queue.end();
        }, options.timeoutMs);
      }
      options.signal?.addEventListener('abort', abort, { once: true });
      for (;;) {
        if (options.signal?.aborted || this.closed) return;
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
        this.authorizer.authorize({ actor, verb: 'create', reference });
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
      const replayKey = options.idempotencyKey
        ? `apply:${options.idempotencyKey}`
        : undefined;
      const requestDigest = digest({
        actor,
        manifest,
      });
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
        if (
          current &&
          controlStoreApplyMatches(
            current.resource as OrchestrationResource,
            manifest as OrchestrationResourceManifest,
          )
        ) {
          if (!replayKey || options.dryRun) return clone(current.resource);
          const result = await this.namespace.if(
            key,
            'Mod',
            '==',
            current.kv.mod_revision,
          ).and(
            idempotencyKey(replayKey),
            'Create',
            '==',
            0,
          ).then(
            this.namespace.put(idempotencyKey(replayKey)).value(JSON.stringify(
              {
                requestDigest,
                response: current.resource,
              } satisfies IdempotencyRecord<OrchestrationResource<TSpec, TStatus>>,
            )),
          ).commit();
          if (result.succeeded) return clone(current.resource);
          const racedReplay = await this.idempotentReplay<
            OrchestrationResource<TSpec, TStatus>
          >(replayKey, requestDigest, 'apply');
          if (racedReplay) return racedReplay;
          continue;
        }
        if (
          current &&
          (!options.resourceVersion ||
            current.resource.metadata.resourceVersion !== options.resourceVersion)
        ) {
          throw new OrchestrationError({
            code: 'CONFLICT',
            message: 'apply resourceVersion precondition failed',
            retryable: true,
          });
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
      const through = BigInt(throughResourceVersion);
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
        const events = await this.namespace.getAll()
          .prefix(EVENT_PREFIX)
          .revision(meta.clusterRevision)
          .sort('Key', 'Ascend')
          .exec();
        const latestBaseline = new Map<string, bigint>();
        const versions: bigint[] = [];
        let boundaryModRevision: string | undefined;
        for (const kv of events.kvs) {
          const stored = parseJson<StoredEvent>(kv.value);
          const version = BigInt(stored.resource.metadata.resourceVersion);
          if (version > compacted) continue;
          versions.push(version);
          latestBaseline.set(resourceKey(referenceFor(stored.resource)), version);
          if (version === compacted) boundaryModRevision = kv.mod_revision;
        }
        const result = await this.namespace.if(META_COMPACTED_KEY, 'Mod', '==', meta.compactedModRevision)
          .then(this.namespace.put(META_COMPACTED_KEY).value(compacted.toString()))
          .commit();
        if (!result.succeeded) continue;
        const retained = new Set(latestBaseline.values());
        for (const version of versions) {
          if (!retained.has(version)) await this.namespace.delete().key(eventKey(version));
        }
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
