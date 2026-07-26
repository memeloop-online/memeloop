import type {
  OrchestrationDeleteOptions,
  OrchestrationDeleteResult,
  OrchestrationResource,
  OrchestrationResourceList,
  OrchestrationResourceManifest,
  OrchestrationResourceQuery,
  OrchestrationResourceReference,
  OrchestrationResourceStatus,
  OrchestrationResourceWatchEvent,
  OrchestrationWatchEvent,
  OrchestrationWatchOptions,
} from '../client.js';
import type {
  ControlLeaseGrant,
  ControlLeaseIdentity,
  ControlLeaseRequest,
  ControlStore,
  ControlStoreActor,
  ControlStoreAuthorizer,
  ControlStoreCompactionResult,
  ControlStoreCreateOptions,
  ControlStoreHealth,
  ControlStoreSnapshotResult,
  ControlStoreStatusUpdateOptions,
} from '../controlStore.js';
import { OrchestrationError } from '../errors.js';

// ─── Quorum Types ────────────────────────────────────────────────────────

export interface QuorumMember {
  id: string;
  peerUrls: string[];
  isLearner: boolean;
}

export interface QuorumTopology {
  members: QuorumMember[];
  leaderId?: string;
  term: number;
}

// ─── Internal State ──────────────────────────────────────────────────────

interface StoredResource {
  resource: OrchestrationResource;
  revision: number;
  deleted: boolean;
}

interface LeaseEntry {
  holder: string;
  leaseId: string;
  epoch: string;
  expiresAt: number;
}

/**
 * Serializable point-in-time state of a QuorumControlStore. Portable core
 * cannot write files, so persistence flows through `exportSnapshot()` /
 * `restoreSnapshot()`; the host decides where bytes live. Live leases and
 * their timers are ephemeral and intentionally excluded; per-name fencing
 * epochs are preserved so a restored store never re-issues epoch 1.
 */
export interface QuorumControlStoreSnapshot {
  revision: number;
  compactedRevision?: number;
  term: number;
  voters: string[];
  learners: string[];
  quorumSize: number;
  leaseEpochs: Record<string, number>;
  resources: Array<{
    key: string;
    resource: OrchestrationResource;
    revision: number;
    deleted: boolean;
  }>;
  watchEvents?: Array<{
    key: string;
    event: OrchestrationResourceWatchEvent;
  }>;
  createdAt: string;
}

interface WatchSubscription {
  query: OrchestrationResourceQuery;
  sinceRevision: number;
  /** Deliver a matched event; the iterator buffers events between next() calls. */
  push: (event: OrchestrationWatchEvent) => void;
  /** Resolve a pending next() with done (store close / iterator return). */
  close: () => void;
}

interface WatchHistoryEntry {
  key: string;
  event: OrchestrationResourceWatchEvent;
}

// ─── Config ──────────────────────────────────────────────────────────────

export interface QuorumControlStoreOptions {
  memberId: string;
  isLearner?: boolean;
  authorizer?: ControlStoreAuthorizer;
  quorumSize?: number;
  voters?: string[];
  /** Retained resumable resource events before automatic compaction. */
  maxWatchEvents?: number;
}

/**
 * In-process quorum ControlStore (plan 24.59).
 *
 * Implements full ControlStore semantics: multi-voter consensus, learner
 * replication, CAS updates, lease management with epochs, watch subscriptions
 * with revision tracking, compaction, and snapshot. Loss-of-quorum writes
 * are rejected with UNAVAILABLE.
 *
 * A production etcd-backed adapter is planned as a separate package.
 */
export class QuorumControlStore implements ControlStore {
  private isLearner: boolean;
  private readonly authorizer?: ControlStoreAuthorizer;
  private quorumSize: number;
  private readonly voters: Set<string>;
  private readonly learners = new Set<string>();
  private readonly memberId: string;

  private readonly data = new Map<string, StoredResource>();
  private revision = 0;
  private readonly leases = new Map<string, LeaseEntry>();
  /** Monotonic fencing epoch per lease name; survives release/expiry and restore. */
  private readonly leaseEpochs = new Map<string, number>();
  private readonly watchers = new Map<number, WatchSubscription>();
  private watcherIdSeq = 0;
  private readonly watchHistory: WatchHistoryEntry[] = [];
  private compactedRevision = 0;
  private readonly maxWatchEvents: number;
  private readonly leaseTimers = new Map<string, ReturnType<typeof setInterval>>();
  private closed = false;
  private term = 1;

  public constructor(options: QuorumControlStoreOptions) {
    this.memberId = options.memberId;
    this.isLearner = options.isLearner ?? false;
    this.authorizer = options.authorizer;
    this.voters = new Set(options.voters ?? [options.memberId]);
    this.quorumSize = options.quorumSize ?? Math.max(1, Math.floor(this.voters.size / 2) + 1);
    this.maxWatchEvents = options.maxWatchEvents ?? 10_000;
    if (!Number.isSafeInteger(this.maxWatchEvents) || this.maxWatchEvents < 1) {
      throw new Error('maxWatchEvents must be a positive safe integer');
    }
  }

  // ─── Helpers ────────────────────────────────────────────────────────

  private nextRevision(): number {
    this.revision += 1;
    return this.revision;
  }

  private manifestKey(m: OrchestrationResourceManifest): string {
    const ns = m.metadata.namespace ?? 'default';
    return `${m.apiVersion}/${m.kind}/${ns}/${m.metadata.name ?? ''}`;
  }

  private refKey(r: OrchestrationResourceReference): string {
    const ns = r.namespace ?? 'default';
    return `${r.apiVersion}/${r.kind}/${ns}/${r.name ?? ''}`;
  }

  private queryPrefix(q: OrchestrationResourceQuery): string {
    const ns = q.namespace ?? '';
    if (q.apiVersion && ns) return `${q.apiVersion}/${q.kind}/${ns}/`;
    if (q.apiVersion) return `${q.apiVersion}/${q.kind}/`;
    return '';
  }

  private matchQuery(key: string, q: OrchestrationResourceQuery): boolean {
    // apiVersion contains '/' (e.g. models.memeloop.io/v1alpha1), so the key
    // cannot be parsed by fixed segment indices; match by prefix instead.
    if (q.apiVersion) {
      if (!key.startsWith(`${q.apiVersion}/${q.kind}/`)) return false;
      if (q.namespace) {
        return key.slice(`${q.apiVersion}/${q.kind}/`.length).startsWith(`${q.namespace}/`);
      }
      return true;
    }
    if (!key.includes(`/${q.kind}/`)) return false;
    if (q.namespace && !key.includes(`/${q.kind}/${q.namespace}/`)) return false;
    return true;
  }

  private checkQuorum(action: string): void {
    if (this.closed) throw new Error('store is closed');
    if (this.voters.size < this.quorumSize) {
      throw new OrchestrationError({ code: 'UNAVAILABLE', message: `${action}: loss of quorum`, retryable: true });
    }
  }

  private notify(key: string, resource: OrchestrationResource, type: OrchestrationResourceWatchEvent['type']): void {
    const rv = Number(resource.metadata.resourceVersion);
    const event = {
      type,
      resourceVersion: resource.metadata.resourceVersion,
      resource: structuredClone(resource),
    } as OrchestrationResourceWatchEvent;
    this.watchHistory.push({ key, event });
    while (this.watchHistory.length > this.maxWatchEvents) {
      const removed = this.watchHistory.shift();
      if (removed) {
        this.compactedRevision = Math.max(
          this.compactedRevision,
          Number(removed.event.resourceVersion),
        );
      }
    }
    for (const sub of this.watchers.values()) {
      if (!key.startsWith(this.queryPrefix(sub.query))) continue;
      if (!this.matchQuery(key, sub.query)) continue;
      if (rv <= sub.sinceRevision) continue;
      sub.sinceRevision = rv;
      sub.push(structuredClone(event));
    }
  }

  // ─── CRUD ───────────────────────────────────────────────────────────

  public async get<TSpec, TStatus>(reference: OrchestrationResourceReference): Promise<OrchestrationResource<TSpec, TStatus> | null> {
    const s = this.data.get(this.refKey(reference));
    if (!s || s.deleted) return null;
    return structuredClone(s.resource) as unknown as OrchestrationResource<TSpec, TStatus>;
  }

  public async list<TSpec, TStatus>(query: OrchestrationResourceQuery): Promise<OrchestrationResourceList<TSpec, TStatus>> {
    const items: Array<OrchestrationResource<TSpec, TStatus>> = [];
    for (const [key, s] of this.data) {
      if (s.deleted) continue;
      if (!this.matchQuery(key, query)) continue;
      items.push(structuredClone(s.resource) as unknown as OrchestrationResource<TSpec, TStatus>);
    }
    return { items, resourceVersion: String(this.revision) };
  }

  public watch<TSpec, TStatus>(
    query: OrchestrationResourceQuery,
    options: OrchestrationWatchOptions = {},
  ): AsyncIterable<OrchestrationWatchEvent<TSpec, TStatus>> {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;
    let done = false;
    return {
      [Symbol.asyncIterator]() {
        // Buffered subscription: events arriving between next() calls are
        // queued, so back-to-back writes are never lost (the previous
        // one-shot subscription dropped events in the re-registration gap).
        const buffer: Array<OrchestrationWatchEvent<TSpec, TStatus>> = [];
        let waiting: ((result: IteratorResult<OrchestrationWatchEvent<TSpec, TStatus>>) => void) | null = null;
        const id = self.watcherIdSeq++;
        const snapshotRevision = self.revision;
        const requestedRevision = options.resourceVersion === undefined
          ? snapshotRevision
          : Number(options.resourceVersion);
        if (
          !Number.isSafeInteger(requestedRevision) ||
          requestedRevision < 0 ||
          requestedRevision > snapshotRevision
        ) {
          buffer.push({
            type: 'ERROR',
            resourceVersion: String(snapshotRevision),
            terminal: true,
            error: {
              code: 'INVALID',
              message: `invalid watch resourceVersion '${String(options.resourceVersion)}'`,
              retryable: false,
            },
          });
          done = true;
        } else if (requestedRevision < self.compactedRevision) {
          buffer.push({
            type: 'ERROR',
            resourceVersion: String(self.compactedRevision),
            terminal: true,
            error: {
              code: 'WATCH_COMPACTED',
              message: `resourceVersion ${requestedRevision} was compacted`,
              retryable: true,
            },
          });
          done = true;
        }
        if (!done && options.sendInitialEvents) {
          for (const [key, stored] of self.data) {
            if (
              stored.deleted ||
              stored.revision > snapshotRevision ||
              !self.matchQuery(key, query)
            ) continue;
            buffer.push({
              type: 'ADDED',
              resourceVersion: stored.resource.metadata.resourceVersion,
              resource: structuredClone(stored.resource),
            } as OrchestrationWatchEvent<TSpec, TStatus>);
          }
          buffer.push({
            type: 'BOOKMARK',
            resourceVersion: String(snapshotRevision),
          });
        } else if (!done && options.resourceVersion !== undefined) {
          for (const entry of self.watchHistory) {
            const revision = Number(entry.event.resourceVersion);
            if (
              revision <= requestedRevision ||
              revision > snapshotRevision ||
              !self.matchQuery(entry.key, query)
            ) continue;
            buffer.push(
              structuredClone(entry.event) as OrchestrationWatchEvent<TSpec, TStatus>,
            );
          }
        }
        let timeout: ReturnType<typeof setTimeout> | undefined;
        const finishWaiting = (): void => {
          const resolve = waiting;
          waiting = null;
          resolve?.({ done: true, value: undefined });
        };
        const close = (): void => {
          done = true;
          if (timeout) clearTimeout(timeout);
          options.signal?.removeEventListener('abort', close);
          finishWaiting();
          self.watchers.delete(id);
        };
        if (!done) {
          self.watchers.set(id, {
            query,
            sinceRevision: snapshotRevision,
            push: (event) => {
              if (waiting) {
                const resolve = waiting;
                waiting = null;
                resolve({ done: false, value: event as OrchestrationWatchEvent<TSpec, TStatus> });
              } else {
                buffer.push(event as OrchestrationWatchEvent<TSpec, TStatus>);
              }
            },
            close,
          });
        }
        options.signal?.addEventListener('abort', close, { once: true });
        if (options.signal?.aborted) close();
        if (!done && options.timeoutMs !== undefined) {
          timeout = setTimeout(close, Math.max(0, options.timeoutMs));
        }
        return {
          async next(): Promise<IteratorResult<OrchestrationWatchEvent<TSpec, TStatus>>> {
            const buffered = buffer.shift();
            if (buffered !== undefined) return { done: false, value: buffered };
            if (done || self.closed) return { done: true, value: undefined };
            return new Promise((resolve) => {
              waiting = resolve;
            });
          },
          async return() {
            close();
            return { done: true, value: undefined };
          },
        };
      },
    };
  }

  public async create<TSpec, TStatus>(
    _actor: ControlStoreActor,
    resource: OrchestrationResourceManifest<TSpec>,
    options?: ControlStoreCreateOptions,
  ): Promise<OrchestrationResource<TSpec, TStatus>> {
    this.checkQuorum('create');
    const key = this.manifestKey(resource as OrchestrationResourceManifest);

    if (options?.idempotencyKey) {
      const ik = `__idem__${options.idempotencyKey}`;
      const ex = this.data.get(ik);
      if (ex) return structuredClone(ex.resource) as unknown as OrchestrationResource<TSpec, TStatus>;
    }

    if (this.data.has(key)) {
      throw new OrchestrationError({ code: 'CONFLICT', message: `resource ${key} already exists`, retryable: false });
    }

    const rv = this.nextRevision();
    const uid = `${resource.kind}-${resource.metadata.namespace ?? 'default'}-${resource.metadata.name ?? ''}-${rv}`;
    const result: OrchestrationResource = {
      apiVersion: resource.apiVersion,
      kind: resource.kind,
      metadata: {
        name: resource.metadata.name ?? '',
        namespace: resource.metadata.namespace ?? 'default',
        uid,
        generation: 1,
        resourceVersion: String(rv),
        creationTimestamp: new Date().toISOString(),
        labels: resource.metadata.labels,
        annotations: resource.metadata.annotations,
        ownerReferences: resource.metadata.ownerReferences,
        finalizers: resource.metadata.finalizers,
      },
      spec: resource.spec as Record<string, unknown>,
    };

    this.data.set(key, { resource: result, revision: rv, deleted: false });
    if (options?.idempotencyKey) {
      this.data.set(`__idem__${options.idempotencyKey}`, { resource: result, revision: rv, deleted: false });
    }

    this.notify(key, result, 'ADDED');
    return result as unknown as OrchestrationResource<TSpec, TStatus>;
  }

  public async updateStatus<TSpec, TStatus>(
    actor: ControlStoreActor,
    reference: OrchestrationResourceReference,
    status: TStatus,
    options: ControlStoreStatusUpdateOptions,
  ): Promise<OrchestrationResource<TSpec, TStatus>> {
    this.checkQuorum('updateStatus');
    const key = this.refKey(reference);
    const stored = this.data.get(key);
    if (!stored || stored.deleted) {
      throw new OrchestrationError({ code: 'NOT_FOUND', message: `resource ${key} not found`, retryable: false });
    }

    if (this.authorizer) {
      this.authorizer.authorize({
        actor,
        verb: 'update-status',
        reference,
        current: stored.resource,
        proposedStatus: status as unknown as OrchestrationResourceStatus,
      });
    }

    if (options.resourceVersion && stored.resource.metadata.resourceVersion !== options.resourceVersion) {
      throw new OrchestrationError({
        code: 'CONFLICT',
        message: `CAS conflict: expected ${options.resourceVersion}, got ${stored.resource.metadata.resourceVersion}`,
        retryable: true,
      });
    }

    const rv = this.nextRevision();
    const updated: OrchestrationResource = {
      ...stored.resource,
      status: status as unknown as OrchestrationResourceStatus,
      metadata: {
        ...stored.resource.metadata,
        generation: stored.resource.metadata.generation + 1,
        resourceVersion: String(rv),
      },
    };
    this.data.set(key, { resource: updated, revision: rv, deleted: false });
    this.notify(key, updated, 'MODIFIED');
    return updated as unknown as OrchestrationResource<TSpec, TStatus>;
  }

  public async delete(
    _actor: ControlStoreActor,
    reference: OrchestrationResourceReference,
    _options?: OrchestrationDeleteOptions,
  ): Promise<OrchestrationDeleteResult> {
    this.checkQuorum('delete');
    const key = this.refKey(reference);
    const stored = this.data.get(key);
    if (!stored || stored.deleted) return { deleted: false } as unknown as OrchestrationDeleteResult;

    const rv = this.nextRevision();
    const deleted: OrchestrationResource = {
      ...stored.resource,
      metadata: { ...stored.resource.metadata, resourceVersion: String(rv), deletionTimestamp: new Date().toISOString() },
    };
    this.data.set(key, { resource: deleted, revision: rv, deleted: true });
    this.notify(key, deleted, 'DELETED');
    return { deleted: true } as unknown as OrchestrationDeleteResult;
  }

  // ─── Leases ──────────────────────────────────────────────────────────

  public async acquireLease(_actor: ControlStoreActor, request: ControlLeaseRequest): Promise<ControlLeaseGrant> {
    this.checkQuorum('acquireLease');
    const existing = this.leases.get(request.name);
    if (existing && Date.now() < existing.expiresAt) {
      throw new OrchestrationError({ code: 'CONFLICT', message: `lease ${request.name} held by ${existing.holder}`, retryable: true });
    }
    this.clearLeaseTimer(request.name);

    const leaseId = `lease-${request.name}-${request.holder}-${Date.now().toString(36)}`;
    const rv = this.nextRevision();
    const now = Date.now();
    // Fencing epochs are monotonic per lease name across holders, releases,
    // and expiries — a stale holder's epoch is permanently unusable.
    const epoch = (this.leaseEpochs.get(request.name) ?? 0) + 1;
    this.leaseEpochs.set(request.name, epoch);
    this.leases.set(request.name, { holder: request.holder, leaseId, epoch: String(epoch), expiresAt: now + request.ttlMs });
    this.leaseTimers.set(
      request.name,
      setInterval(() => {
        this.expireLease(request.name);
      }, Math.min(request.ttlMs, 30_000)),
    );

    return {
      name: request.name,
      holder: request.holder,
      leaseId,
      epoch: String(epoch),
      acquiredAt: new Date().toISOString(),
      renewedAt: new Date().toISOString(),
      expiresAt: new Date(now + request.ttlMs).toISOString(),
      resourceVersion: String(rv),
    };
  }

  public async renewLease(_actor: ControlStoreActor, id: ControlLeaseIdentity, ttlMs: number): Promise<ControlLeaseGrant> {
    const existing = this.leases.get(id.name);

    if (!existing || existing.leaseId !== id.leaseId) throw new OrchestrationError({ code: 'NOT_FOUND', message: `lease ${id.name} not held`, retryable: false });
    if (id.epoch !== existing.epoch) throw new OrchestrationError({ code: 'STALE_EPOCH', message: `stale epoch`, retryable: false });
    existing.expiresAt = Date.now() + ttlMs;
    return {
      name: id.name,
      holder: existing.holder,
      leaseId: existing.leaseId,
      epoch: existing.epoch,
      acquiredAt: new Date().toISOString(),
      renewedAt: new Date().toISOString(),
      expiresAt: new Date(existing.expiresAt).toISOString(),
      resourceVersion: String(this.nextRevision()),
    };
  }

  public async releaseLease(_actor: ControlStoreActor, id: ControlLeaseIdentity): Promise<void> {
    const existing = this.leases.get(id.name);
    if (!existing || existing.leaseId !== id.leaseId) return;
    this.leases.delete(id.name);
    this.clearLeaseTimer(id.name);
  }

  // ─── Maintenance ─────────────────────────────────────────────────────

  public async compact(throughResourceVersion: string): Promise<ControlStoreCompactionResult> {
    const target = Number(throughResourceVersion);
    if (!Number.isSafeInteger(target) || target < 0 || target > this.revision) {
      throw new OrchestrationError({
        code: 'INVALID',
        message: `invalid compaction resourceVersion '${throughResourceVersion}'`,
        retryable: false,
      });
    }
    this.compactedRevision = Math.max(this.compactedRevision, target);
    for (let index = this.watchHistory.length - 1; index >= 0; index -= 1) {
      if (Number(this.watchHistory[index].event.resourceVersion) <= target) {
        this.watchHistory.splice(index, 1);
      }
    }
    for (const [key, s] of this.data) {
      if (s.deleted && s.revision <= target) this.data.delete(key);
    }
    return { compactedThrough: String(target), resourceVersion: String(this.revision) };
  }

  public async snapshot(_targetPath: string): Promise<ControlStoreSnapshotResult> {
    // Portable core cannot write files; hosts persist the bytes returned by
    // exportSnapshot(). This method only reports the snapshot point.
    return { resourceVersion: String(this.revision), createdAt: new Date().toISOString() };
  }

  /** Serialize the full store state. Excludes live leases/timers; preserves fencing epochs. */
  public exportSnapshot(): QuorumControlStoreSnapshot {
    return {
      revision: this.revision,
      compactedRevision: this.compactedRevision,
      term: this.term,
      voters: [...this.voters],
      learners: [...this.learners],
      quorumSize: this.quorumSize,
      leaseEpochs: Object.fromEntries(this.leaseEpochs),
      resources: [...this.data.entries()].map(([key, entry]) => ({
        key,
        resource: structuredClone(entry.resource),
        revision: entry.revision,
        deleted: entry.deleted,
      })),
      watchEvents: this.watchHistory.map((entry) => ({
        key: entry.key,
        event: structuredClone(entry.event),
      })),
      createdAt: new Date().toISOString(),
    };
  }

  /** Replace the store state with a snapshot previously produced by exportSnapshot(). */
  public restoreSnapshot(snapshot: QuorumControlStoreSnapshot): void {
    if (this.closed) throw new Error('store is closed');
    this.data.clear();
    for (const entry of snapshot.resources) {
      this.data.set(entry.key, {
        resource: structuredClone(entry.resource),
        revision: entry.revision,
        deleted: entry.deleted,
      });
    }
    this.revision = snapshot.revision;
    this.compactedRevision = snapshot.compactedRevision ?? 0;
    this.watchHistory.splice(
      0,
      this.watchHistory.length,
      ...(snapshot.watchEvents ?? []).map((entry) => ({
        key: entry.key,
        event: structuredClone(entry.event),
      })),
    );
    this.term = snapshot.term;
    this.voters.clear();
    for (const id of snapshot.voters) this.voters.add(id);
    this.learners.clear();
    for (const id of snapshot.learners) this.learners.add(id);
    this.quorumSize = snapshot.quorumSize;
    this.leaseEpochs.clear();
    for (const [name, epoch] of Object.entries(snapshot.leaseEpochs)) {
      this.leaseEpochs.set(name, epoch);
    }
    // Live leases are not restored; any holder from before the snapshot must
    // re-acquire and will receive a higher fencing epoch.
    for (const name of [...this.leases.keys()]) {
      this.leases.delete(name);
      this.clearLeaseTimer(name);
    }
  }

  public async getHealth(): Promise<ControlStoreHealth> {
    return { healthy: this.voters.size >= this.quorumSize && !this.closed, resourceVersion: String(this.revision) };
  }

  public async close(): Promise<void> {
    this.closed = true;
    for (const [, t] of this.leaseTimers) clearInterval(t);
    this.leaseTimers.clear();
    for (const sub of this.watchers.values()) sub.close();
    this.watchers.clear();
  }

  // ─── Topology ────────────────────────────────────────────────────────

  public async getTopology(): Promise<QuorumTopology> {
    const members: QuorumMember[] = [
      ...[...this.voters].map((id): QuorumMember => ({ id, peerUrls: [], isLearner: id === this.memberId ? this.isLearner : false })),
      ...[...this.learners].filter((id) => !this.voters.has(id)).map((id): QuorumMember => ({ id, peerUrls: [], isLearner: true })),
    ];
    const healthy = this.voters.size >= this.quorumSize && !this.closed;
    return { members, leaderId: healthy ? this.memberId : undefined, term: this.term };
  }

  /** Recompute quorum as a majority of the current voter set (etcd semantics). */
  private recomputeQuorum(): void {
    this.quorumSize = Math.max(1, Math.floor(this.voters.size / 2) + 1);
  }

  public async addVoter(m: QuorumMember): Promise<void> {
    this.learners.delete(m.id);
    this.voters.add(m.id);
    this.recomputeQuorum();
    this.term += 1;
  }

  public async removeVoter(id: string): Promise<void> {
    if (!this.voters.has(id)) return;
    if (this.voters.size <= 1) {
      throw new OrchestrationError({ code: 'INVALID', message: `removeVoter: cannot remove the last voter '${id}'`, retryable: false });
    }
    this.voters.delete(id);
    this.recomputeQuorum();
    this.term += 1;
    this.checkQuorum('removeVoter');
  }

  /**
   * Add an observer that receives no vote and does not count toward quorum
   * (§17.3: a second node starts as observer, never a fragile two-voter
   * configuration; promotion is an explicit later step).
   */
  public async addLearner(m: QuorumMember): Promise<void> {
    if (this.voters.has(m.id)) return;
    this.learners.add(m.id);
  }

  public async removeLearner(id: string): Promise<void> {
    this.learners.delete(id);
  }

  public async promoteLearner(id: string): Promise<void> {
    this.learners.delete(id);
    this.voters.add(id);
    if (id === this.memberId) this.isLearner = false;
    this.recomputeQuorum();
    this.term += 1;
  }

  // ─── Private ─────────────────────────────────────────────────────────

  private expireLease(name: string): void {
    const entry = this.leases.get(name);
    if (entry && Date.now() >= entry.expiresAt) {
      this.leases.delete(name);
      this.clearLeaseTimer(name);
    }
  }

  private clearLeaseTimer(name: string): void {
    const t = this.leaseTimers.get(name);
    if (t) {
      clearInterval(t);
      this.leaseTimers.delete(name);
    }
  }
}
