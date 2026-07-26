import { createHash, randomUUID } from 'node:crypto';

import Database from 'better-sqlite3';
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

interface ResourceRow {
  key: string;
  resourceJson: string;
}

interface EventRow extends ResourceRow {
  revision: bigint;
  type: 'ADDED' | 'MODIFIED' | 'DELETED';
}

interface LeaseRow {
  name: string;
  holder: string;
  leaseId: string;
  epoch: bigint;
  acquiredAt: string;
  renewedAt: string;
  expiresAt: string;
  resourceVersion: bigint;
}

interface ContinueToken {
  queryDigest: string;
  resourceVersion: string;
  offset: number;
}

export interface SQLiteControlStoreOptions {
  filename: string;
  authorizer: ControlStoreAuthorizer;
  /**
   * Absolute path to the host-provided better-sqlite3 N-API addon.
   * Electron embedders should set this to the binary copied into Resources.
   */
  nativeBinding?: string;
  now?: () => Date;
  uid?: () => string;
  pollIntervalMs?: number;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function resourceKey(reference: OrchestrationResourceReference): string {
  if (!reference.name) {
    throw new OrchestrationError({ code: 'INVALID', message: 'ControlStore resource name is required', retryable: false });
  }
  return JSON.stringify([reference.apiVersion, reference.kind, reference.namespace ?? '', reference.name]);
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

function digest(value: unknown): string {
  return createHash('sha256').update(canonicalControlStoreValue(value)).digest('hex');
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
    if (!token.queryDigest || !token.resourceVersion || !Number.isSafeInteger(token.offset) || token.offset < 0) throw new Error('invalid token');
    return token;
  } catch {
    throw new OrchestrationError({ code: 'INVALID', message: 'invalid ControlStore continue token', retryable: false });
  }
}

function parseResource<TSpec, TStatus>(json: string): OrchestrationResource<TSpec, TStatus> {
  return JSON.parse(json) as OrchestrationResource<TSpec, TStatus>;
}

export class SQLiteControlStore implements ControlStore {
  private readonly database: Database.Database;
  private readonly authorizer: ControlStoreAuthorizer;
  private readonly now: () => Date;
  private readonly uid: () => string;
  private readonly pollIntervalMs: number;
  private closed = false;

  constructor(options: SQLiteControlStoreOptions) {
    this.authorizer = options.authorizer;
    this.now = options.now ?? (() => new Date());
    this.uid = options.uid ?? randomUUID;
    this.pollIntervalMs = options.pollIntervalMs ?? 25;
    this.database = new Database(options.filename, {
      nativeBinding: options.nativeBinding,
    });
    this.database.defaultSafeIntegers(true);
    this.database.pragma('journal_mode = WAL');
    // An acknowledged ControlStore transaction is an orchestration decision;
    // FULL prevents the faster NORMAL mode from admitting acknowledged-write
    // loss during an OS/power failure (the final acceptance separately probes
    // process-crash recovery).
    this.database.pragma('synchronous = FULL');
    this.database.pragma('foreign_keys = ON');
    this.database.pragma('busy_timeout = 5000');
    this.migrate();
  }

  private migrate(): void {
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS control_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      INSERT OR IGNORE INTO control_meta (key, value) VALUES ('revision', '0');
      INSERT OR IGNORE INTO control_meta (key, value) VALUES ('compacted_revision', '0');

      CREATE TABLE IF NOT EXISTS control_resources (
        key TEXT PRIMARY KEY,
        apiVersion TEXT NOT NULL,
        kind TEXT NOT NULL,
        namespace TEXT NOT NULL,
        name TEXT NOT NULL,
        resourceVersion INTEGER NOT NULL,
        resourceJson TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS control_resources_query
        ON control_resources (kind, apiVersion, namespace, key);

      CREATE TABLE IF NOT EXISTS control_events (
        revision INTEGER PRIMARY KEY,
        type TEXT NOT NULL,
        key TEXT NOT NULL,
        resourceJson TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS control_events_key_revision
        ON control_events (key, revision DESC);

      CREATE TABLE IF NOT EXISTS control_idempotency (
        idempotencyKey TEXT PRIMARY KEY,
        requestDigest TEXT NOT NULL,
        responseJson TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS control_leases (
        name TEXT PRIMARY KEY,
        holder TEXT NOT NULL,
        leaseId TEXT NOT NULL,
        epoch INTEGER NOT NULL,
        acquiredAt TEXT NOT NULL,
        renewedAt TEXT NOT NULL,
        expiresAt TEXT NOT NULL,
        resourceVersion INTEGER NOT NULL
      );
    `);
  }

  private assertOpen(): void {
    if (this.closed) throw new OrchestrationError({ code: 'UNAVAILABLE', message: 'ControlStore is closed', retryable: false });
  }

  private metaRevision(name: 'revision' | 'compacted_revision'): bigint {
    const row = this.database.prepare('SELECT value FROM control_meta WHERE key = ?').get(name) as { value: string };
    return BigInt(row.value);
  }

  private nextRevision(): bigint {
    const next = this.metaRevision('revision') + 1n;
    this.database.prepare("UPDATE control_meta SET value = ? WHERE key = 'revision'").run(next.toString());
    return next;
  }

  private writeResource(resource: OrchestrationResource, revision: bigint, type: EventRow['type']): void {
    const key = resourceKey(referenceFor(resource));
    const json = JSON.stringify(resource);
    if (type === 'DELETED') {
      this.database.prepare('DELETE FROM control_resources WHERE key = ?').run(key);
    } else {
      this.database.prepare(`
        INSERT INTO control_resources (key, apiVersion, kind, namespace, name, resourceVersion, resourceJson)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET resourceVersion = excluded.resourceVersion, resourceJson = excluded.resourceJson
      `).run(key, resource.apiVersion, resource.kind, resource.metadata.namespace ?? '', resource.metadata.name, revision, json);
    }
    this.database.prepare('INSERT INTO control_events (revision, type, key, resourceJson) VALUES (?, ?, ?, ?)')
      .run(revision, type, key, json);
  }

  private currentResource<TSpec = Record<string, unknown>, TStatus = OrchestrationResourceStatus>(
    reference: OrchestrationResourceReference,
  ): OrchestrationResource<TSpec, TStatus> | null {
    const row = this.database.prepare('SELECT resourceJson FROM control_resources WHERE key = ?').get(resourceKey(reference)) as
      | { resourceJson: string }
      | undefined;
    return row ? parseResource<TSpec, TStatus>(row.resourceJson) : null;
  }

  async get<TSpec = Record<string, unknown>, TStatus = OrchestrationResourceStatus>(
    reference: OrchestrationResourceReference,
    options: OrchestrationGetOptions = {},
  ): Promise<OrchestrationResource<TSpec, TStatus> | null> {
    this.assertOpen();
    const resource = this.currentResource<TSpec, TStatus>(reference);
    if (resource && options.resourceVersion && BigInt(resource.metadata.resourceVersion) < BigInt(options.resourceVersion)) {
      throw new OrchestrationError({ code: 'CONFLICT', message: 'requested resourceVersion is newer than the current resource', retryable: true });
    }
    return resource ? clone(resource) : null;
  }

  private resourcesAt(resourceVersion: bigint): OrchestrationResource[] {
    if (resourceVersion === this.metaRevision('revision')) {
      const rows = this.database.prepare('SELECT resourceJson FROM control_resources ORDER BY key').all() as Array<{ resourceJson: string }>;
      return rows.map((row) => parseResource(row.resourceJson));
    }
    const rows = this.database.prepare(`
      SELECT type, resourceJson FROM (
        SELECT type, resourceJson, ROW_NUMBER() OVER (PARTITION BY key ORDER BY revision DESC) AS rank
        FROM control_events WHERE revision <= ?
      ) WHERE rank = 1 AND type != 'DELETED'
    `).all(resourceVersion) as Array<{ type: EventRow['type']; resourceJson: string }>;
    return rows.map((row) => parseResource(row.resourceJson));
  }

  async list<TSpec = Record<string, unknown>, TStatus = OrchestrationResourceStatus>(
    query: OrchestrationResourceQuery,
    options: OrchestrationListOptions = {},
  ): Promise<OrchestrationResourceList<TSpec, TStatus>> {
    this.assertOpen();
    const queryDigest = digest(query);
    const token = options.continueToken ? decodeContinueToken(options.continueToken) : undefined;
    if (token && token.queryDigest !== queryDigest) {
      throw new OrchestrationError({ code: 'INVALID', message: 'continue token belongs to another query', retryable: false });
    }
    const resourceVersion = BigInt(token?.resourceVersion ?? options.resourceVersion ?? this.metaRevision('revision'));
    if (resourceVersion < this.metaRevision('compacted_revision')) {
      throw new OrchestrationError({ code: 'WATCH_COMPACTED', message: `resourceVersion ${resourceVersion} was compacted`, retryable: true });
    }
    const offset = token?.offset ?? 0;
    const all = this.resourcesAt(resourceVersion).filter((resource) => matchesQuery(resource, query));
    const limit = Math.max(1, options.limit ?? (all.length || 1));
    const items = all.slice(offset, offset + limit) as Array<OrchestrationResource<TSpec, TStatus>>;
    const nextOffset = offset + items.length;
    return {
      items: clone(items),
      resourceVersion: resourceVersion.toString(),
      ...(nextOffset < all.length
        ? { continueToken: encodeContinueToken({ queryDigest, resourceVersion: resourceVersion.toString(), offset: nextOffset }) }
        : {}),
    };
  }

  watch<TSpec = Record<string, unknown>, TStatus = OrchestrationResourceStatus>(
    query: OrchestrationResourceQuery,
    options: OrchestrationWatchOptions = {},
  ): AsyncIterable<OrchestrationWatchEvent<TSpec, TStatus>> {
    return this.watchEvents(query, options);
  }

  private async *watchEvents<TSpec, TStatus>(
    query: OrchestrationResourceQuery,
    options: OrchestrationWatchOptions,
  ): AsyncIterable<OrchestrationWatchEvent<TSpec, TStatus>> {
    this.assertOpen();
    const startedAt = Date.now();
    let cursor = BigInt(options.resourceVersion ?? this.metaRevision('revision'));
    const compacted = this.metaRevision('compacted_revision');
    if (cursor < compacted) {
      yield {
        type: 'ERROR',
        resourceVersion: compacted.toString(),
        terminal: true,
        error: { code: 'WATCH_COMPACTED', message: `resourceVersion ${cursor} was compacted`, retryable: true },
      };
      return;
    }
    if (options.sendInitialEvents) {
      const snapshot = this.metaRevision('revision');
      for (const resource of this.resourcesAt(snapshot).filter((item) => matchesQuery(item, query))) {
        yield { type: 'ADDED', resourceVersion: snapshot.toString(), resource: clone(resource) as OrchestrationResource<TSpec, TStatus> };
      }
      cursor = snapshot;
      yield { type: 'BOOKMARK', resourceVersion: cursor.toString() };
    }
    for (;;) {
      if (options.signal?.aborted || this.closed) return;
      if (options.timeoutMs !== undefined && Date.now() - startedAt >= options.timeoutMs) return;
      const rows = this.database.prepare(`
        SELECT revision, type, key, resourceJson FROM control_events
        WHERE revision > ? ORDER BY revision ASC LIMIT 256
      `).all(cursor) as EventRow[];
      if (rows.length > 0) {
        for (const row of rows) {
          cursor = row.revision;
          const resource = parseResource<TSpec, TStatus>(row.resourceJson);
          if (!matchesQuery(resource as OrchestrationResource, query)) continue;
          yield { type: row.type, resourceVersion: row.revision.toString(), resource: clone(resource) };
        }
        continue;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, this.pollIntervalMs));
    }
  }

  async create<TSpec = Record<string, unknown>, TStatus = OrchestrationResourceStatus>(
    actor: ControlStoreActor,
    manifest: OrchestrationResourceManifest<TSpec>,
    options: ControlStoreCreateOptions = {},
  ): Promise<OrchestrationResource<TSpec, TStatus>> {
    this.assertOpen();
    const reference = referenceFor(manifest);
    resourceKey(reference);
    const requestDigest = digest({ actor, manifest });
    const replayKey = options.idempotencyKey
      ? `create:${options.idempotencyKey}`
      : undefined;
    const transaction = this.database.transaction(() => {
      if (replayKey) {
        const replay = this.database.prepare('SELECT requestDigest, responseJson FROM control_idempotency WHERE idempotencyKey = ?')
          .get(replayKey) as { requestDigest: string; responseJson: string } | undefined;
        if (replay) {
          if (replay.requestDigest !== requestDigest) {
            throw new OrchestrationError({ code: 'CONFLICT', message: 'idempotency key was reused for another create request', retryable: false });
          }
          return parseResource<TSpec, TStatus>(replay.responseJson);
        }
      }
      if (this.currentResource(reference)) {
        throw new OrchestrationError({ code: 'CONFLICT', message: `resource '${reference.name}' already exists`, retryable: false });
      }
      this.authorizer.authorize({ actor, verb: 'create', reference });
      const revision = options.dryRun ? this.metaRevision('revision') : this.nextRevision();
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
      if (!options.dryRun) {
        this.writeResource(created as OrchestrationResource, revision, 'ADDED');
        if (replayKey) {
          this.database.prepare('INSERT INTO control_idempotency (idempotencyKey, requestDigest, responseJson) VALUES (?, ?, ?)')
            .run(replayKey, requestDigest, JSON.stringify(created));
        }
      }
      return created;
    });
    return clone(transaction());
  }

  async apply<TSpec = Record<string, unknown>, TStatus = OrchestrationResourceStatus>(
    actor: ControlStoreActor,
    manifest: OrchestrationResourceManifest<TSpec>,
    options: ControlStoreApplyOptions = {},
  ): Promise<OrchestrationResource<TSpec, TStatus>> {
    this.assertOpen();
    const reference = referenceFor(manifest);
    resourceKey(reference);
    const requestDigest = digest({ actor, manifest });
    const replayKey = options.idempotencyKey
      ? `apply:${options.idempotencyKey}`
      : undefined;
    const transaction = this.database.transaction(() => {
      if (replayKey) {
        const replay = this.database.prepare(
          'SELECT requestDigest, responseJson FROM control_idempotency WHERE idempotencyKey = ?',
        ).get(replayKey) as
          | { requestDigest: string; responseJson: string }
          | undefined;
        if (replay) {
          if (replay.requestDigest !== requestDigest) {
            throw new OrchestrationError({
              code: 'CONFLICT',
              message: 'idempotency key was reused for another apply request',
              retryable: false,
            });
          }
          return parseResource<TSpec, TStatus>(replay.responseJson);
        }
      }
      const current = this.currentResource<TSpec, TStatus>(reference);
      if (!current) {
        this.authorizer.authorize({
          actor,
          verb: 'apply',
          reference,
          proposedResource: manifest as OrchestrationResourceManifest,
        });
        const revision = options.dryRun
          ? this.metaRevision('revision')
          : this.nextRevision();
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
        if (!options.dryRun) {
          this.writeResource(created as OrchestrationResource, revision, 'ADDED');
          if (replayKey) {
            this.database.prepare(
              'INSERT INTO control_idempotency (idempotencyKey, requestDigest, responseJson) VALUES (?, ?, ?)',
            ).run(replayKey, requestDigest, JSON.stringify(created));
          }
        }
        return created;
      }
      if (
        controlStoreApplyMatches(
          current as OrchestrationResource,
          manifest as OrchestrationResourceManifest,
        )
      ) {
        if (replayKey && !options.dryRun) {
          this.database.prepare(
            'INSERT INTO control_idempotency (idempotencyKey, requestDigest, responseJson) VALUES (?, ?, ?)',
          ).run(replayKey, requestDigest, JSON.stringify(current));
        }
        return current;
      }
      if (
        !options.resourceVersion ||
        current.metadata.resourceVersion !== options.resourceVersion
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
        current: current as OrchestrationResource,
        proposedResource: manifest as OrchestrationResourceManifest,
      });
      const revision = options.dryRun ? this.metaRevision('revision') : this.nextRevision();
      const specChanged = canonicalControlStoreValue(current.spec) !==
        canonicalControlStoreValue(manifest.spec);
      const updated: OrchestrationResource<TSpec, TStatus> = {
        ...current,
        metadata: {
          ...current.metadata,
          ...clone(manifest.metadata),
          name: current.metadata.name,
          namespace: current.metadata.namespace,
          uid: current.metadata.uid,
          generation: current.metadata.generation + (specChanged ? 1 : 0),
          resourceVersion: revision.toString(),
          creationTimestamp: current.metadata.creationTimestamp,
        },
        spec: clone(manifest.spec),
      };
      if (!options.dryRun) {
        this.writeResource(updated as OrchestrationResource, revision, 'MODIFIED');
        if (replayKey) {
          this.database.prepare(
            'INSERT INTO control_idempotency (idempotencyKey, requestDigest, responseJson) VALUES (?, ?, ?)',
          ).run(replayKey, requestDigest, JSON.stringify(updated));
        }
      }
      return updated;
    });
    return clone(transaction());
  }

  async updateStatus<TSpec = Record<string, unknown>, TStatus = OrchestrationResourceStatus>(
    actor: ControlStoreActor,
    reference: OrchestrationResourceReference,
    status: TStatus,
    options: ControlStoreStatusUpdateOptions,
  ): Promise<OrchestrationResource<TSpec, TStatus>> {
    this.assertOpen();
    const requestDigest = digest({ actor, reference, status, resourceVersion: options.resourceVersion });
    const replayKey = options.idempotencyKey
      ? `status:${options.idempotencyKey}`
      : undefined;
    const transaction = this.database.transaction(() => {
      if (replayKey) {
        const replay = this.database.prepare('SELECT requestDigest, responseJson FROM control_idempotency WHERE idempotencyKey = ?')
          .get(replayKey) as { requestDigest: string; responseJson: string } | undefined;
        if (replay) {
          if (replay.requestDigest !== requestDigest) {
            throw new OrchestrationError({ code: 'CONFLICT', message: 'idempotency key was reused for another status update', retryable: false });
          }
          return parseResource<TSpec, TStatus>(replay.responseJson);
        }
      }
      const current = this.currentResource<TSpec, TStatus>(reference);
      if (!current) throw new OrchestrationError({ code: 'NOT_FOUND', message: `resource '${reference.name}' not found`, retryable: false });
      if (current.metadata.resourceVersion !== options.resourceVersion) {
        throw new OrchestrationError({
          code: 'CONFLICT',
          message: 'resourceVersion precondition failed',
          retryable: true,
          details: { expected: options.resourceVersion, current: current.metadata.resourceVersion },
        });
      }
      this.authorizer.authorize({
        actor,
        verb: 'update-status',
        reference,
        current: current as OrchestrationResource,
        proposedStatus: status as OrchestrationResourceStatus,
      });
      const revision = options.dryRun ? this.metaRevision('revision') : this.nextRevision();
      const updated: OrchestrationResource<TSpec, TStatus> = {
        ...current,
        metadata: { ...current.metadata, resourceVersion: revision.toString() },
        status: clone(status),
      };
      if (!options.dryRun) {
        this.writeResource(updated as OrchestrationResource, revision, 'MODIFIED');
        if (replayKey) {
          this.database.prepare('INSERT INTO control_idempotency (idempotencyKey, requestDigest, responseJson) VALUES (?, ?, ?)')
            .run(replayKey, requestDigest, JSON.stringify(updated));
        }
      }
      return updated;
    });
    return clone(transaction());
  }

  async delete(
    actor: ControlStoreActor,
    reference: OrchestrationResourceReference,
    options: OrchestrationDeleteOptions = {},
  ): Promise<OrchestrationDeleteResult> {
    this.assertOpen();
    const requestDigest = digest({
      actor,
      reference,
      preconditions: options.preconditions,
      propagationPolicy: options.propagationPolicy,
    });
    const replayKey = options.idempotencyKey
      ? `delete:${options.idempotencyKey}`
      : undefined;
    return this.database.transaction(() => {
      if (replayKey) {
        const replay = this.database.prepare(
          'SELECT requestDigest, responseJson FROM control_idempotency WHERE idempotencyKey = ?',
        ).get(replayKey) as
          | { requestDigest: string; responseJson: string }
          | undefined;
        if (replay) {
          if (replay.requestDigest !== requestDigest) {
            throw new OrchestrationError({
              code: 'CONFLICT',
              message: 'idempotency key was reused for another delete request',
              retryable: false,
            });
          }
          return JSON.parse(replay.responseJson) as OrchestrationDeleteResult;
        }
      }
      const current = this.currentResource(reference);
      if (!current) return { accepted: false, reference };
      if (options.preconditions?.uid && current.metadata.uid !== options.preconditions.uid) {
        throw new OrchestrationError({ code: 'CONFLICT', message: 'delete UID precondition failed', retryable: false });
      }
      if (options.preconditions?.resourceVersion && current.metadata.resourceVersion !== options.preconditions.resourceVersion) {
        throw new OrchestrationError({ code: 'CONFLICT', message: 'delete resourceVersion precondition failed', retryable: true });
      }
      if (options.preconditions?.generation !== undefined && current.metadata.generation !== options.preconditions.generation) {
        throw new OrchestrationError({ code: 'CONFLICT', message: 'delete generation precondition failed', retryable: true });
      }
      this.authorizer.authorize({ actor, verb: 'delete', reference, current });
      if (options.dryRun) return { accepted: true, reference };
      const revision = this.nextRevision();
      if ((current.metadata.finalizers?.length ?? 0) > 0 && !current.metadata.deletionTimestamp) {
        const pending = {
          ...current,
          metadata: { ...current.metadata, deletionTimestamp: this.now().toISOString(), resourceVersion: revision.toString() },
        };
        this.writeResource(pending, revision, 'MODIFIED');
      } else {
        const deleted = { ...current, metadata: { ...current.metadata, resourceVersion: revision.toString() } };
        this.writeResource(deleted, revision, 'DELETED');
      }
      const result: OrchestrationDeleteResult = { accepted: true, reference };
      if (replayKey) {
        this.database.prepare(
          'INSERT INTO control_idempotency (idempotencyKey, requestDigest, responseJson) VALUES (?, ?, ?)',
        ).run(replayKey, requestDigest, JSON.stringify(result));
      }
      return result;
    })();
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

  async acquireLease(actor: ControlStoreActor, request: ControlLeaseRequest): Promise<ControlLeaseGrant> {
    this.assertOpen();
    if (!request.name || !request.holder || !Number.isSafeInteger(request.ttlMs) || request.ttlMs <= 0) {
      throw new OrchestrationError({ code: 'INVALID', message: 'lease name, holder, and positive ttlMs are required', retryable: false });
    }
    return this.database.transaction(() => {
      const reference = { apiVersion: CONTROL_LEASE_API_VERSION, kind: CONTROL_LEASE_KIND, name: request.name };
      const current = this.database.prepare('SELECT * FROM control_leases WHERE name = ?').get(request.name) as LeaseRow | undefined;
      this.authorizer.authorize({ actor, verb: 'acquire-lease', reference });
      const acquiredAt = this.now();
      if (current && Date.parse(current.expiresAt) > acquiredAt.getTime()) {
        throw new OrchestrationError({ code: 'CONFLICT', message: `lease '${request.name}' is held by '${current.holder}'`, retryable: true });
      }
      const revision = this.nextRevision();
      const grant: ControlLeaseGrant = {
        name: request.name,
        holder: request.holder,
        leaseId: this.uid(),
        epoch: ((current?.epoch ?? 0n) + 1n).toString(),
        acquiredAt: acquiredAt.toISOString(),
        renewedAt: acquiredAt.toISOString(),
        expiresAt: new Date(acquiredAt.getTime() + request.ttlMs).toISOString(),
        resourceVersion: revision.toString(),
      };
      this.database.prepare(`
        INSERT INTO control_leases (name, holder, leaseId, epoch, acquiredAt, renewedAt, expiresAt, resourceVersion)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(name) DO UPDATE SET holder = excluded.holder, leaseId = excluded.leaseId, epoch = excluded.epoch,
          acquiredAt = excluded.acquiredAt, renewedAt = excluded.renewedAt, expiresAt = excluded.expiresAt,
          resourceVersion = excluded.resourceVersion
      `).run(grant.name, grant.holder, grant.leaseId, BigInt(grant.epoch), grant.acquiredAt, grant.renewedAt, grant.expiresAt, revision);
      this.writeResource(this.leaseResource(grant), revision, current ? 'MODIFIED' : 'ADDED');
      return grant;
    })();
  }

  async renewLease(actor: ControlStoreActor, identity: ControlLeaseIdentity, ttlMs: number): Promise<ControlLeaseGrant> {
    this.assertOpen();
    if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) {
      throw new OrchestrationError({ code: 'INVALID', message: 'positive lease ttlMs is required', retryable: false });
    }
    return this.database.transaction(() => {
      const current = this.database.prepare('SELECT * FROM control_leases WHERE name = ?').get(identity.name) as LeaseRow | undefined;
      const reference = { apiVersion: CONTROL_LEASE_API_VERSION, kind: CONTROL_LEASE_KIND, name: identity.name };
      this.authorizer.authorize({ actor, verb: 'renew-lease', reference });
      const renewedAt = this.now();
      if (
        !current ||
        current.holder !== identity.holder ||
        current.leaseId !== identity.leaseId ||
        current.epoch.toString() !== identity.epoch ||
        Date.parse(current.expiresAt) <= renewedAt.getTime()
      ) {
        throw new OrchestrationError({ code: 'STALE_EPOCH', message: `lease '${identity.name}' identity is stale`, retryable: false });
      }
      const revision = this.nextRevision();
      const grant: ControlLeaseGrant = {
        ...identity,
        acquiredAt: current.acquiredAt,
        renewedAt: renewedAt.toISOString(),
        expiresAt: new Date(renewedAt.getTime() + ttlMs).toISOString(),
        resourceVersion: revision.toString(),
      };
      this.database.prepare('UPDATE control_leases SET renewedAt = ?, expiresAt = ?, resourceVersion = ? WHERE name = ?')
        .run(grant.renewedAt, grant.expiresAt, revision, grant.name);
      this.writeResource(this.leaseResource(grant), revision, 'MODIFIED');
      return grant;
    })();
  }

  async releaseLease(actor: ControlStoreActor, identity: ControlLeaseIdentity): Promise<void> {
    this.assertOpen();
    this.database.transaction(() => {
      const current = this.database.prepare('SELECT * FROM control_leases WHERE name = ?').get(identity.name) as LeaseRow | undefined;
      const reference = { apiVersion: CONTROL_LEASE_API_VERSION, kind: CONTROL_LEASE_KIND, name: identity.name };
      this.authorizer.authorize({ actor, verb: 'release-lease', reference });
      if (
        !current ||
        current.holder !== identity.holder ||
        current.leaseId !== identity.leaseId ||
        current.epoch.toString() !== identity.epoch
      ) {
        throw new OrchestrationError({ code: 'STALE_EPOCH', message: `lease '${identity.name}' identity is stale`, retryable: false });
      }
      const revision = this.nextRevision();
      this.database.prepare('DELETE FROM control_leases WHERE name = ?').run(identity.name);
      const grant: ControlLeaseGrant = {
        ...identity,
        acquiredAt: current.acquiredAt,
        renewedAt: current.renewedAt,
        expiresAt: current.expiresAt,
        resourceVersion: revision.toString(),
      };
      this.writeResource(this.leaseResource(grant), revision, 'DELETED');
    })();
  }

  async compact(throughResourceVersion: string): Promise<ControlStoreCompactionResult> {
    this.assertOpen();
    return this.database.transaction(() => {
      const through = BigInt(throughResourceVersion);
      const current = this.metaRevision('revision');
      if (through > current) {
        throw new OrchestrationError({ code: 'INVALID', message: 'cannot compact beyond current resourceVersion', retryable: false });
      }
      const previous = this.metaRevision('compacted_revision');
      const compacted = through > previous ? through : previous;
      this.database.prepare("UPDATE control_meta SET value = ? WHERE key = 'compacted_revision'").run(compacted.toString());
      this.database.prepare(`
        DELETE FROM control_events
        WHERE revision <= ? AND revision NOT IN (SELECT MAX(revision) FROM control_events GROUP BY key)
      `).run(compacted);
      return { compactedThrough: compacted.toString(), resourceVersion: current.toString() };
    })();
  }

  async snapshot(targetPath: string): Promise<ControlStoreSnapshotResult> {
    this.assertOpen();
    const resourceVersion = this.metaRevision('revision').toString();
    await this.database.backup(targetPath);
    return { resourceVersion, createdAt: this.now().toISOString() };
  }

  async getHealth(): Promise<ControlStoreHealth> {
    this.assertOpen();
    const quickCheck = this.database.pragma('quick_check', { simple: true });
    return {
      healthy: quickCheck === 'ok',
      resourceVersion: this.metaRevision('revision').toString(),
      detail: `sqlite quick_check: ${String(quickCheck)}`,
    };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.database.close();
  }
}
