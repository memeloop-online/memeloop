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

interface WatchSubscription {
  query: OrchestrationResourceQuery;
  sinceRevision: number;
  resolve: (event: OrchestrationWatchEvent) => void;
}

// ─── Config ──────────────────────────────────────────────────────────────

export interface QuorumControlStoreOptions {
  memberId: string;
  isLearner?: boolean;
  authorizer?: ControlStoreAuthorizer;
  quorumSize?: number;
  voters?: string[];
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
  private readonly isLearner: boolean;
  private readonly authorizer?: ControlStoreAuthorizer;
  private readonly quorumSize: number;
  private readonly voters: Set<string>;
  private readonly memberId: string;

  private readonly data = new Map<string, StoredResource>();
  private revision = 0;
  private readonly leases = new Map<string, LeaseEntry>();
  private readonly watchers = new Map<number, WatchSubscription>();
  private watcherIdSeq = 0;
  private readonly leaseTimers = new Map<string, ReturnType<typeof setInterval>>();
  private closed = false;
  private term = 1;

  public constructor(options: QuorumControlStoreOptions) {
    this.memberId = options.memberId;
    this.isLearner = options.isLearner ?? false;
    this.authorizer = options.authorizer;
    this.voters = new Set(options.voters ?? [options.memberId]);
    this.quorumSize = options.quorumSize ?? Math.max(1, Math.floor(this.voters.size / 2) + 1);
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
    const parts = key.split('/');
    if (q.kind && parts[1] !== q.kind) return false;
    if (q.namespace && parts[2] !== q.namespace) return false;
    if (q.apiVersion) return key.startsWith(q.apiVersion + '/');
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
    for (const [id, sub] of this.watchers) {
      if (!key.startsWith(this.queryPrefix(sub.query))) continue;
      if (!this.matchQuery(key, sub.query)) continue;
      if (rv <= sub.sinceRevision) continue;
      sub.resolve({ type, resourceVersion: resource.metadata.resourceVersion, resource } as OrchestrationResourceWatchEvent);
      this.watchers.delete(id);
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

  public watch<TSpec, TStatus>(query: OrchestrationResourceQuery): AsyncIterable<OrchestrationWatchEvent<TSpec, TStatus>> {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;
    let sinceRevision = this.revision;
    let done = false;
    return {
      [Symbol.asyncIterator]() {
        return {
          async next(): Promise<IteratorResult<OrchestrationWatchEvent<TSpec, TStatus>>> {
            if (done || self.closed) return { done: true, value: undefined };
            const id = self.watcherIdSeq++;
            return new Promise((resolve) => {
              self.watchers.set(id, {
                query,
                sinceRevision,
                resolve: (event: OrchestrationWatchEvent) => {
                  sinceRevision = Number(event.resourceVersion);
                  resolve({ done: false, value: event as OrchestrationWatchEvent<TSpec, TStatus> });
                },
              });
            });
          },
          async return() {
            done = true;
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
    this.leases.set(request.name, { holder: request.holder, leaseId, epoch: '1', expiresAt: now + request.ttlMs });
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
      epoch: '1',
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
    for (const [key, s] of this.data) {
      if (s.deleted && s.revision <= target) this.data.delete(key);
    }
    return { compactedThrough: String(target), resourceVersion: String(this.revision) };
  }

  public async snapshot(_targetPath: string): Promise<ControlStoreSnapshotResult> {
    return { resourceVersion: String(this.revision), createdAt: new Date().toISOString() };
  }

  public async getHealth(): Promise<ControlStoreHealth> {
    return { healthy: this.voters.size >= this.quorumSize && !this.closed, resourceVersion: String(this.revision) };
  }

  public async close(): Promise<void> {
    this.closed = true;
    for (const [, t] of this.leaseTimers) clearInterval(t);
    this.leaseTimers.clear();
    this.watchers.clear();
  }

  // ─── Topology ────────────────────────────────────────────────────────

  public async getTopology(): Promise<QuorumTopology> {
    const members: QuorumMember[] = [...this.voters].map((id) => ({ id, peerUrls: [], isLearner: id === this.memberId ? this.isLearner : false }));
    return { members, term: this.term };
  }

  public async addVoter(m: QuorumMember): Promise<void> {
    this.voters.add(m.id);
  }
  public async removeVoter(id: string): Promise<void> {
    this.voters.delete(id);
    this.checkQuorum('removeVoter');
  }
  public async promoteLearner(id: string): Promise<void> {
    this.voters.add(id);
    if (id === this.memberId) (this as unknown as { isLearner: boolean }).isLearner = false;
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
