import { assertAgentUserMessageContentWithinLimits } from '../userMessageAdmission.js';
import { normalizeAgentAttachmentInput } from './attachmentInput.js';
import type { AgentAttachmentInput, WikiTiddlerAttachment } from './types.js';

/** A local runtime or remote PeerId selected for one explicit operation. */
export type RemoteAgentExecutionTarget =
  | { readonly kind: 'local' }
  | { readonly kind: 'remote'; readonly peerId: string };

/** Durable identities carried unchanged through dispatch, retry, cancellation, and sync. */
export interface RemoteAgentExecutionProvenance {
  readonly conversationId: string;
  readonly definitionId: string;
  readonly turnId: string;
  readonly requestId: string;
}

export interface RemoteAgentExecuteRequest {
  readonly target: RemoteAgentExecutionTarget;
  readonly provenance: RemoteAgentExecutionProvenance;
  readonly message: string;
  /** Lazy portable descriptor; the coordinator never reads attachment bytes. */
  readonly attachment?: AgentAttachmentInput;
  /** Bounded immutable metadata for host-native TiddlyWiki attachment resolution. */
  readonly wikiTiddlers?: readonly WikiTiddlerAttachment[];
}

export interface RemoteAgentRetryRequest {
  readonly target: RemoteAgentExecutionTarget;
  readonly provenance: RemoteAgentExecutionProvenance;
  /** Durable user-root turn being replaced. Content is resolved by the target. */
  readonly sourceTurnId: string;
}

export interface RemoteAgentDeleteRequest {
  readonly target: RemoteAgentExecutionTarget;
  readonly provenance: RemoteAgentExecutionProvenance;
}

export interface RemoteAgentCancelRequest {
  readonly target: RemoteAgentExecutionTarget;
  readonly provenance: RemoteAgentExecutionProvenance;
}

export interface RemoteAgentExecutionCallOptions {
  readonly signal: AbortSignal;
}

export interface RemoteAgentExecutionResult {
  readonly runId: string;
  readonly synchronization?: RemoteAgentSynchronizationState;
}

export interface RemoteAgentDeleteResult {
  readonly ok: true;
  readonly synchronization?: RemoteAgentSynchronizationState;
}

export type RemoteAgentSynchronizationState = 'not-required' | 'synchronized' | 'degraded';

export type RemoteAgentExecutionOperation = 'execute' | 'retry' | 'delete' | 'cancel';
export type RemoteAgentExecutionStatus =
  | 'idle'
  | 'queued'
  | 'running'
  | 'cancelling'
  | 'succeeded'
  | 'degraded'
  | 'failed'
  | 'cancelled'
  | 'disposed';

export type RemoteAgentExecutionErrorCode =
  | 'INVALID_TARGET'
  | 'INVALID_PROVENANCE'
  | 'REQUEST_ID_CONFLICT'
  | 'STALE_OPERATION'
  | 'CANCELLED'
  | 'PORT_FAILURE'
  | 'SYNC_FAILED'
  | 'CAPACITY_EXCEEDED'
  | 'DISPOSED';

/** Stable, non-secret coordinator failure. Host errors never become public messages. */
export class RemoteAgentExecutionError extends Error {
  constructor(
    public readonly code: RemoteAgentExecutionErrorCode,
    public readonly retryable: boolean,
  ) {
    super(`remote_agent_execution_${code.toLowerCase()}`);
    this.name = 'RemoteAgentExecutionError';
  }
}

export interface RemoteAgentExecutionSnapshot {
  readonly conversationId: string;
  readonly generation: number;
  readonly status: RemoteAgentExecutionStatus;
  readonly target?: RemoteAgentExecutionTarget;
  /** Concrete execution identity, including the otherwise implicit local PeerId. */
  readonly executionPeerId?: string;
  readonly operation?: RemoteAgentExecutionOperation;
  readonly provenance?: RemoteAgentExecutionProvenance;
  readonly error?: RemoteAgentExecutionError;
  readonly synchronization?: RemoteAgentSynchronizationState;
  readonly updatedAt: number;
}

type ExecutePort = (
  request: RemoteAgentExecuteRequest,
  options: RemoteAgentExecutionCallOptions,
) => Promise<RemoteAgentExecutionResult>;
type RetryPort = (
  request: RemoteAgentRetryRequest,
  options: RemoteAgentExecutionCallOptions,
) => Promise<RemoteAgentExecutionResult>;
type DeletePort = (
  request: RemoteAgentDeleteRequest,
  options: RemoteAgentExecutionCallOptions,
) => Promise<RemoteAgentDeleteResult>;
type CancelPort = (
  request: RemoteAgentCancelRequest,
  options: RemoteAgentExecutionCallOptions,
) => Promise<void>;

export interface RemoteAgentExecutionCoordinatorOptions {
  readonly localPeerId: string;
  readonly executeLocal: ExecutePort;
  readonly executeRemote: ExecutePort;
  readonly cancelLocal: CancelPort;
  readonly cancelRemote: CancelPort;
  readonly retryLocal: RetryPort;
  readonly retryRemote: RetryPort;
  readonly deleteLocal: DeletePort;
  readonly deleteRemote: DeletePort;
  /** Called only after a successful remote mutation, never for local or failed work. */
  readonly syncConversation?: (
    peerId: string,
    conversationId: string,
    options: RemoteAgentExecutionCallOptions,
  ) => Promise<void>;
  readonly now?: () => number;
  readonly createId?: () => string;
  /** Hard cap for inactive conversation snapshots/generations. Defaults to 1,024. */
  readonly maxRetainedConversations?: number;
  /** Hard cap for retry idempotency keys. Defaults to 4,096. */
  readonly maxRetryLedgerEntries?: number;
  /** Listener failures are isolated; hosts may record the bounded diagnostic here. */
  readonly onListenerError?: (error: unknown) => void;
  /** Receives failures thrown by the listener-error observer itself. */
  readonly onListenerErrorFailure?: (error: unknown) => void;
}

interface ActiveOperation {
  readonly generation: number;
  readonly controller: AbortController;
  readonly target: RemoteAgentExecutionTarget;
  readonly operation: RemoteAgentExecutionOperation;
  readonly provenance: RemoteAgentExecutionProvenance;
  cleanupCallerSignal(): void;
}

interface RetryLedgerEntry {
  readonly fingerprint: string;
  readonly conversationId: string;
  pending?: Promise<RemoteAgentExecutionResult>;
  result?: RemoteAgentExecutionResult;
}

interface OperationOutcome<Result> {
  readonly value: Result;
  readonly synchronization: RemoteAgentSynchronizationState;
  readonly syncError?: RemoteAgentExecutionError;
}

const MAX_IDENTIFIER_CHARACTERS = 512;
const DEFAULT_MAX_RETAINED_CONVERSATIONS = 1_024;
const DEFAULT_MAX_RETRY_LEDGER_ENTRIES = 4_096;

export const REMOTE_AGENT_EXECUTION_LIMITS = Object.freeze(
  {
    wikiTiddlers: 32,
    wikiWorkspaceNameCharacters: 512,
    wikiTiddlerTitleCharacters: 1_024,
  } as const,
);

/**
 * Portable operation coordinator shared by Desktop, App, and Mobile.
 *
 * It deliberately owns no device cache, UI state, messages, or run polling.
 * Host ports wait for terminal execution. Operations are serialized per
 * conversation; target changes and disposal fence stale async completions.
 */
export class RemoteAgentExecutionCoordinator {
  private readonly listeners = new Set<(snapshot: RemoteAgentExecutionSnapshot) => void>();
  private readonly snapshots = new Map<string, RemoteAgentExecutionSnapshot>();
  private readonly generations = new Map<string, number>();
  private readonly active = new Map<string, ActiveOperation>();
  private readonly queues = new Map<string, Promise<void>>();
  private readonly retryLedger = new Map<string, RetryLedgerEntry>();
  private readonly conversationLru = new Map<string, true>();
  private readonly stoppedConversations = new Set<string>();
  private readonly lifetime = new AbortController();
  private readonly now: () => number;
  private readonly createId: () => string;
  private readonly maxRetainedConversations: number;
  private readonly maxRetryLedgerEntries: number;
  private disposed = false;

  constructor(private readonly options: RemoteAgentExecutionCoordinatorOptions) {
    assertIdentifier(options.localPeerId, 'INVALID_TARGET');
    this.now = options.now ?? Date.now;
    this.createId = options.createId ?? defaultCreateId;
    this.maxRetainedConversations = normalizeCapacity(
      options.maxRetainedConversations,
      DEFAULT_MAX_RETAINED_CONVERSATIONS,
    );
    this.maxRetryLedgerEntries = normalizeCapacity(
      options.maxRetryLedgerEntries,
      DEFAULT_MAX_RETRY_LEDGER_ENTRIES,
    );
  }

  /** Generate missing durable identities before an operation is submitted. */
  prepareProvenance(input: {
    conversationId: string;
    definitionId: string;
    turnId?: string;
    requestId?: string;
  }): RemoteAgentExecutionProvenance {
    return validateProvenance({
      conversationId: input.conversationId,
      definitionId: input.definitionId,
      turnId: input.turnId ?? this.createId(),
      requestId: input.requestId ?? this.createId(),
    });
  }

  getSnapshot(conversationId: string): RemoteAgentExecutionSnapshot {
    assertIdentifier(conversationId, 'INVALID_PROVENANCE');
    return this.snapshots.get(conversationId) ?? Object.freeze({
      conversationId,
      generation: this.generations.get(conversationId) ?? 0,
      status: this.disposed ? 'disposed' : 'idle',
      updatedAt: this.now(),
    });
  }

  subscribe(listener: (snapshot: RemoteAgentExecutionSnapshot) => void): () => void {
    this.assertUsable();
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  execute(request: RemoteAgentExecuteRequest, options: { signal?: AbortSignal } = {}): Promise<RemoteAgentExecutionResult> {
    const validated = validateExecuteRequest(request);
    return this.enqueue(validated.provenance.conversationId, 'execute', validated.target, validated.provenance, options.signal, async signal => {
      const result = await this.dispatchExecute(validated, signal);
      const synchronization = await this.syncSuccessfulRemote(validated.target, validated.provenance.conversationId, signal);
      return operationOutcome(
        Object.freeze({ ...result, synchronization: synchronization.state }),
        synchronization,
      );
    });
  }

  retry(request: RemoteAgentRetryRequest, options: { signal?: AbortSignal } = {}): Promise<RemoteAgentExecutionResult> {
    const validated = validateRetryRequest(request);
    const fingerprint = retryFingerprint(validated);
    const existing = this.retryLedger.get(validated.provenance.requestId);
    if (existing && existing.fingerprint !== fingerprint) {
      return Promise.reject(new RemoteAgentExecutionError('REQUEST_ID_CONFLICT', false));
    }
    if (existing) this.touchRetryLedger(validated.provenance.requestId, existing);
    if (existing?.result) return Promise.resolve(existing.result);
    if (existing?.pending) return existing.pending;
    if (!existing) this.ensureRetryLedgerCapacity();
    const entry = existing ?? { fingerprint, conversationId: validated.provenance.conversationId };
    const pending = this.enqueue(validated.provenance.conversationId, 'retry', validated.target, validated.provenance, options.signal, async signal => {
      const result = await this.dispatchRetry(validated, signal);
      const synchronization = await this.syncSuccessfulRemote(validated.target, validated.provenance.conversationId, signal);
      return operationOutcome(
        Object.freeze({ ...result, synchronization: synchronization.state }),
        synchronization,
      );
    });
    entry.pending = pending;
    this.retryLedger.set(validated.provenance.requestId, entry);
    void pending.then(result => {
      entry.result = Object.freeze({ ...result });
      entry.pending = undefined;
    }, () => {
      entry.pending = undefined;
    });
    return pending;
  }

  delete(request: RemoteAgentDeleteRequest, options: { signal?: AbortSignal } = {}): Promise<RemoteAgentDeleteResult> {
    const validated = validateDeleteRequest(request);
    return this.enqueue(validated.provenance.conversationId, 'delete', validated.target, validated.provenance, options.signal, async signal => {
      const result = await this.dispatchDelete(validated, signal);
      const synchronization = await this.syncSuccessfulRemote(validated.target, validated.provenance.conversationId, signal);
      return operationOutcome(
        Object.freeze({ ...result, synchronization: synchronization.state }),
        synchronization,
      );
    });
  }

  /** Cancel active work immediately; the fenced operation can no longer publish. */
  async cancel(request: RemoteAgentCancelRequest, options: { signal?: AbortSignal } = {}): Promise<void> {
    const validated = validateCancelRequest(request);
    this.assertUsable();
    const conversationId = validated.provenance.conversationId;
    const generation = this.bumpGeneration(conversationId);
    this.abortActive(conversationId, new RemoteAgentExecutionError('CANCELLED', false));
    const linked = linkSignals(this.lifetime.signal, options.signal);
    this.publish(conversationId, {
      generation,
      status: 'cancelling',
      target: validated.target,
      operation: 'cancel',
      provenance: validated.provenance,
    });
    try {
      await this.dispatchCancel(validated, linked.signal);
      linked.signal.throwIfAborted();
      if (this.currentGeneration(conversationId) !== generation) {
        throw new RemoteAgentExecutionError('STALE_OPERATION', false);
      }
      const synchronization = await this.syncSuccessfulRemote(
        validated.target,
        validated.provenance.conversationId,
        linked.signal,
      );
      this.publish(conversationId, {
        generation,
        status: synchronization.state === 'degraded' ? 'degraded' : 'cancelled',
        target: validated.target,
        operation: 'cancel',
        provenance: validated.provenance,
        synchronization: synchronization.state,
        ...(synchronization.error === undefined ? {} : { error: synchronization.error }),
      });
    } catch (error) {
      const normalized = normalizeOperationError(error, linked.signal);
      if (this.currentGeneration(conversationId) === generation) {
        this.publish(conversationId, {
          generation,
          status: normalized.code === 'CANCELLED' ? 'cancelled' : 'failed',
          target: validated.target,
          operation: 'cancel',
          provenance: validated.provenance,
          error: normalized,
        });
      }
      throw normalized;
    } finally {
      linked.cleanup();
    }
  }

  /** Fence in-flight work before a host commits a different target selection. */
  switchTarget(conversationId: string, target: RemoteAgentExecutionTarget): void {
    this.assertUsable();
    assertIdentifier(conversationId, 'INVALID_PROVENANCE');
    const validatedTarget = validateTarget(target);
    const generation = this.bumpGeneration(conversationId);
    this.abortActive(conversationId, new RemoteAgentExecutionError('STALE_OPERATION', false));
    this.publish(conversationId, { generation, status: 'idle', target: validatedTarget });
  }

  /**
   * Fence one host session and release its retained snapshot/idempotency keys.
   * Hosts should call this when a conversation is permanently closed.
   */
  stopConversation(conversationId: string): void {
    this.assertUsable();
    assertIdentifier(conversationId, 'INVALID_PROVENANCE');
    this.bumpGeneration(conversationId);
    this.stoppedConversations.add(conversationId);
    this.abortActive(conversationId, new RemoteAgentExecutionError('CANCELLED', false));
    this.snapshots.delete(conversationId);
    this.conversationLru.delete(conversationId);
    for (const [requestId, entry] of this.retryLedger) {
      if (entry.conversationId === conversationId) this.retryLedger.delete(requestId);
    }
    if (!this.queues.has(conversationId)) this.generations.delete(conversationId);
  }

  /** Abort work, detach subscribers, and clear all identity ledgers. */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.lifetime.abort(new RemoteAgentExecutionError('DISPOSED', false));
    const conversations = new Set([
      ...this.active.keys(),
      ...this.queues.keys(),
      ...this.generations.keys(),
      ...this.snapshots.keys(),
    ]);
    for (const conversationId of conversations) {
      this.bumpGeneration(conversationId);
      this.abortActive(conversationId, new RemoteAgentExecutionError('DISPOSED', false));
      this.publish(conversationId, {
        generation: this.currentGeneration(conversationId),
        status: 'disposed',
      });
    }
    // Host ports are required to observe AbortSignal, but disposal must remain
    // bounded even when a faulty adapter ignores it. Generation fencing keeps
    // every late completion from publishing.
    await Promise.resolve();
    this.active.clear();
    this.queues.clear();
    this.retryLedger.clear();
    this.conversationLru.clear();
    this.stoppedConversations.clear();
    this.snapshots.clear();
    this.generations.clear();
    this.listeners.clear();
  }

  private enqueue<Result>(
    conversationId: string,
    operation: RemoteAgentExecutionOperation,
    target: RemoteAgentExecutionTarget,
    provenance: RemoteAgentExecutionProvenance,
    callerSignal: AbortSignal | undefined,
    invoke: (signal: AbortSignal) => Promise<OperationOutcome<Result>>,
  ): Promise<Result> {
    this.assertUsable();
    this.stoppedConversations.delete(conversationId);
    const generation = this.currentGeneration(conversationId);
    this.publish(conversationId, { generation, status: 'queued', target, operation, provenance });
    const previous = this.queues.get(conversationId) ?? Promise.resolve();
    let release!: () => void;
    const tail = new Promise<void>(resolve => {
      release = resolve;
    });
    this.queues.set(conversationId, tail);
    const result = previous.catch(() => undefined).then(async () => {
      if (this.disposed) throw new RemoteAgentExecutionError('DISPOSED', false);
      if (generation !== this.currentGeneration(conversationId)) {
        throw new RemoteAgentExecutionError('STALE_OPERATION', false);
      }
      const controller = new AbortController();
      const linked = linkIntoController(controller, this.lifetime.signal, callerSignal);
      const active: ActiveOperation = {
        generation,
        controller,
        target,
        operation,
        provenance,
        cleanupCallerSignal: () => {
          linked.cleanup();
        },
      };
      this.active.set(conversationId, active);
      this.publish(conversationId, { generation, status: 'running', target, operation, provenance });
      try {
        controller.signal.throwIfAborted();
        const outcome = await invoke(controller.signal);
        controller.signal.throwIfAborted();
        if (this.active.get(conversationId) !== active || generation !== this.currentGeneration(conversationId)) {
          throw new RemoteAgentExecutionError('STALE_OPERATION', false);
        }
        this.publish(conversationId, {
          generation,
          status: outcome.synchronization === 'degraded' ? 'degraded' : 'succeeded',
          target,
          operation,
          provenance,
          synchronization: outcome.synchronization,
          ...(outcome.syncError === undefined ? {} : { error: outcome.syncError }),
        });
        return outcome.value;
      } catch (error) {
        const normalized = normalizeOperationError(error, controller.signal);
        if (this.active.get(conversationId) === active && generation === this.currentGeneration(conversationId)) {
          this.publish(conversationId, {
            generation,
            status: normalized.code === 'CANCELLED' ? 'cancelled' : 'failed',
            target,
            operation,
            provenance,
            error: normalized,
          });
        }
        throw normalized;
      } finally {
        active.cleanupCallerSignal();
        if (this.active.get(conversationId) === active) this.active.delete(conversationId);
      }
    }).finally(() => {
      release();
      if (this.queues.get(conversationId) === tail) this.queues.delete(conversationId);
      if (this.stoppedConversations.has(conversationId) && !this.queues.has(conversationId)) {
        this.generations.delete(conversationId);
      }
    });
    return result;
  }

  private dispatchExecute(request: RemoteAgentExecuteRequest, signal: AbortSignal) {
    return this.portForTarget(request.target, this.options.executeLocal, this.options.executeRemote)(request, { signal });
  }

  private dispatchRetry(request: RemoteAgentRetryRequest, signal: AbortSignal) {
    return this.portForTarget(request.target, this.options.retryLocal, this.options.retryRemote)(request, { signal });
  }

  private dispatchDelete(request: RemoteAgentDeleteRequest, signal: AbortSignal) {
    return this.portForTarget(request.target, this.options.deleteLocal, this.options.deleteRemote)(request, { signal });
  }

  private dispatchCancel(request: RemoteAgentCancelRequest, signal: AbortSignal) {
    return this.portForTarget(request.target, this.options.cancelLocal, this.options.cancelRemote)(request, { signal });
  }

  private portForTarget<Port>(target: RemoteAgentExecutionTarget, local: Port, remote: Port): Port {
    return target.kind === 'local' ? local : remote;
  }

  private async syncSuccessfulRemote(
    target: RemoteAgentExecutionTarget,
    conversationId: string,
    signal: AbortSignal,
  ): Promise<{ state: RemoteAgentSynchronizationState; error?: RemoteAgentExecutionError }> {
    if (target.kind !== 'remote' || !this.options.syncConversation) {
      return { state: 'not-required' };
    }
    try {
      await this.options.syncConversation(target.peerId, conversationId, { signal });
      return { state: 'synchronized' };
    } catch (error) {
      signal.throwIfAborted();
      void error;
      return {
        state: 'degraded',
        error: new RemoteAgentExecutionError('SYNC_FAILED', true),
      };
    }
  }

  private currentGeneration(conversationId: string): number {
    return this.generations.get(conversationId) ?? 0;
  }

  private bumpGeneration(conversationId: string): number {
    this.ensureConversationCapacity(conversationId);
    const generation = this.currentGeneration(conversationId) + 1;
    this.generations.set(conversationId, generation);
    return generation;
  }

  private abortActive(conversationId: string, reason: RemoteAgentExecutionError): void {
    const active = this.active.get(conversationId);
    if (!active) return;
    this.active.delete(conversationId);
    if (!active.controller.signal.aborted) active.controller.abort(reason);
    active.cleanupCallerSignal();
  }

  private publish(
    conversationId: string,
    update: Omit<RemoteAgentExecutionSnapshot, 'conversationId' | 'updatedAt'>,
  ): void {
    this.ensureConversationCapacity(conversationId);
    const snapshot = Object.freeze({
      conversationId,
      ...update,
      ...(update.target === undefined
        ? {}
        : { executionPeerId: update.target.kind === 'local' ? this.options.localPeerId : update.target.peerId }),
      updatedAt: this.now(),
    });
    this.snapshots.set(conversationId, snapshot);
    this.touchConversation(conversationId);
    for (const listener of [...this.listeners]) {
      try {
        listener(snapshot);
      } catch (error) {
        try {
          this.options.onListenerError?.(error);
        } catch (observerError) {
          this.options.onListenerErrorFailure?.(observerError);
        }
      }
    }
  }

  private ensureConversationCapacity(conversationId: string): void {
    if (this.snapshots.has(conversationId) || this.generations.has(conversationId)) return;
    while (this.conversationLru.size >= this.maxRetainedConversations) {
      const candidate = [...this.conversationLru.keys()].find(id => !this.active.has(id) && !this.queues.has(id));
      if (!candidate) throw new RemoteAgentExecutionError('CAPACITY_EXCEEDED', false);
      this.conversationLru.delete(candidate);
      this.snapshots.delete(candidate);
      this.generations.delete(candidate);
      for (const [requestId, entry] of this.retryLedger) {
        if (entry.conversationId === candidate && !entry.pending) this.retryLedger.delete(requestId);
      }
    }
    this.conversationLru.set(conversationId, true);
  }

  private touchConversation(conversationId: string): void {
    this.conversationLru.delete(conversationId);
    this.conversationLru.set(conversationId, true);
  }

  private ensureRetryLedgerCapacity(): void {
    while (this.retryLedger.size >= this.maxRetryLedgerEntries) {
      const completed = [...this.retryLedger].find(([, entry]) => entry.pending === undefined);
      if (!completed) throw new RemoteAgentExecutionError('CAPACITY_EXCEEDED', false);
      this.retryLedger.delete(completed[0]);
    }
  }

  private touchRetryLedger(requestId: string, entry: RetryLedgerEntry): void {
    this.retryLedger.delete(requestId);
    this.retryLedger.set(requestId, entry);
  }

  private assertUsable(): void {
    if (this.disposed) throw new RemoteAgentExecutionError('DISPOSED', false);
  }
}

function validateExecuteRequest(request: RemoteAgentExecuteRequest): RemoteAgentExecuteRequest {
  const descriptors = readExactDataRecord(
    request,
    ['target', 'provenance', 'message'],
    ['attachment', 'wikiTiddlers'],
    'INVALID_PROVENANCE',
  );
  const target = validateTarget(readDataValue(descriptors, 'target', 'INVALID_TARGET') as RemoteAgentExecutionTarget);
  const provenance = validateProvenance(
    readDataValue(descriptors, 'provenance', 'INVALID_PROVENANCE') as RemoteAgentExecutionProvenance,
  );
  const message = readDataValue(descriptors, 'message', 'INVALID_PROVENANCE');
  const attachmentValue = readOptionalDataValue(descriptors, 'attachment', 'INVALID_PROVENANCE');
  const wikiTiddlersValue = readOptionalDataValue(descriptors, 'wikiTiddlers', 'INVALID_PROVENANCE');
  try {
    assertAgentUserMessageContentWithinLimits(message);
  } catch {
    throw new RemoteAgentExecutionError('INVALID_PROVENANCE', false);
  }
  let attachment: AgentAttachmentInput | undefined;
  try {
    attachment = attachmentValue === undefined
      ? undefined
      : normalizeAgentAttachmentInput(attachmentValue as AgentAttachmentInput);
  } catch {
    throw new RemoteAgentExecutionError('INVALID_PROVENANCE', false);
  }
  const wikiTiddlers = wikiTiddlersValue === undefined
    ? undefined
    : normalizeWikiTiddlers(wikiTiddlersValue);
  return Object.freeze({
    target,
    provenance,
    message,
    ...(attachment === undefined ? {} : { attachment }),
    ...(wikiTiddlers === undefined ? {} : { wikiTiddlers }),
  });
}

function validateRetryRequest(request: RemoteAgentRetryRequest): RemoteAgentRetryRequest {
  const descriptors = readExactDataRecord(
    request,
    ['target', 'provenance', 'sourceTurnId'],
    [],
    'INVALID_PROVENANCE',
  );
  const target = validateTarget(
    readDataValue(descriptors, 'target', 'INVALID_TARGET') as RemoteAgentExecutionTarget,
  );
  const provenance = validateProvenance(
    readDataValue(descriptors, 'provenance', 'INVALID_PROVENANCE') as RemoteAgentExecutionProvenance,
  );
  const sourceTurnId = readDataValue(descriptors, 'sourceTurnId', 'INVALID_PROVENANCE');
  assertIdentifier(sourceTurnId, 'INVALID_PROVENANCE');
  if (sourceTurnId === provenance.turnId) {
    throw new RemoteAgentExecutionError('INVALID_PROVENANCE', false);
  }
  return Object.freeze({ target, provenance, sourceTurnId });
}

function validateDeleteRequest(request: RemoteAgentDeleteRequest): RemoteAgentDeleteRequest {
  const descriptors = readExactDataRecord(
    request,
    ['target', 'provenance'],
    [],
    'INVALID_PROVENANCE',
  );
  return Object.freeze({
    target: validateTarget(
      readDataValue(descriptors, 'target', 'INVALID_TARGET') as RemoteAgentExecutionTarget,
    ),
    provenance: validateProvenance(
      readDataValue(descriptors, 'provenance', 'INVALID_PROVENANCE') as RemoteAgentExecutionProvenance,
    ),
  });
}

function validateCancelRequest(request: RemoteAgentCancelRequest): RemoteAgentCancelRequest {
  const descriptors = readExactDataRecord(
    request,
    ['target', 'provenance'],
    [],
    'INVALID_PROVENANCE',
  );
  return Object.freeze({
    target: validateTarget(
      readDataValue(descriptors, 'target', 'INVALID_TARGET') as RemoteAgentExecutionTarget,
    ),
    provenance: validateProvenance(
      readDataValue(descriptors, 'provenance', 'INVALID_PROVENANCE') as RemoteAgentExecutionProvenance,
    ),
  });
}

function validateTarget(target: RemoteAgentExecutionTarget): RemoteAgentExecutionTarget {
  const descriptors = readExactDataRecord(
    target,
    ['kind'],
    ['peerId'],
    'INVALID_TARGET',
  );
  const kind = readDataValue(descriptors, 'kind', 'INVALID_TARGET');
  const hasPeerId = descriptors.has('peerId');
  if (kind === 'local' && !hasPeerId) return Object.freeze({ kind: 'local' });
  if (kind === 'remote' && hasPeerId) {
    const peerId = readDataValue(descriptors, 'peerId', 'INVALID_TARGET');
    assertIdentifier(peerId, 'INVALID_TARGET');
    return Object.freeze({ kind: 'remote', peerId });
  }
  throw new RemoteAgentExecutionError('INVALID_TARGET', false);
}

function validateProvenance(provenance: RemoteAgentExecutionProvenance): RemoteAgentExecutionProvenance {
  const descriptors = readExactDataRecord(
    provenance,
    ['conversationId', 'definitionId', 'turnId', 'requestId'],
    [],
    'INVALID_PROVENANCE',
  );
  const conversationId = readDataValue(descriptors, 'conversationId', 'INVALID_PROVENANCE');
  const definitionId = readDataValue(descriptors, 'definitionId', 'INVALID_PROVENANCE');
  const turnId = readDataValue(descriptors, 'turnId', 'INVALID_PROVENANCE');
  const requestId = readDataValue(descriptors, 'requestId', 'INVALID_PROVENANCE');
  assertIdentifier(conversationId, 'INVALID_PROVENANCE');
  assertIdentifier(definitionId, 'INVALID_PROVENANCE');
  assertIdentifier(turnId, 'INVALID_PROVENANCE');
  assertIdentifier(requestId, 'INVALID_PROVENANCE');
  return Object.freeze({ conversationId, definitionId, turnId, requestId });
}

function assertIdentifier(value: unknown, code: 'INVALID_TARGET' | 'INVALID_PROVENANCE'): asserts value is string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > MAX_IDENTIFIER_CHARACTERS ||
    value.trim() !== value ||
    hasControlCharacters(value)
  ) throw new RemoteAgentExecutionError(code, false);
}

type DataDescriptorRecord = ReadonlyMap<PropertyKey, PropertyDescriptor>;

function collectDataDescriptors(value: object): DataDescriptorRecord {
  const descriptors = new Map<PropertyKey, PropertyDescriptor>();
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined) throw new TypeError('property descriptor disappeared during validation');
    descriptors.set(key, descriptor);
  }
  return descriptors;
}

function readExactDataRecord(
  value: unknown,
  required: readonly string[],
  optional: readonly string[],
  code: 'INVALID_TARGET' | 'INVALID_PROVENANCE',
): DataDescriptorRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new RemoteAgentExecutionError(code, false);
  }
  try {
    const prototype = Reflect.getPrototypeOf(value);
    if (!isPlainObjectPrototype(prototype)) throw new RemoteAgentExecutionError(code, false);
    const descriptors = collectDataDescriptors(value);
    const allowed = new Set([...required, ...optional]);
    const keys = [...descriptors.keys()];
    if (
      keys.some(key => typeof key !== 'string' || !allowed.has(key)) ||
      required.some(key => !descriptors.has(key))
    ) throw new RemoteAgentExecutionError(code, false);
    for (const descriptor of descriptors.values()) {
      if (!descriptor?.enumerable || !('value' in descriptor)) {
        throw new RemoteAgentExecutionError(code, false);
      }
    }
    return descriptors;
  } catch (error) {
    if (error instanceof RemoteAgentExecutionError) throw error;
    throw new RemoteAgentExecutionError(code, false);
  }
}

function readDataValue(
  descriptors: DataDescriptorRecord,
  key: string,
  code: 'INVALID_TARGET' | 'INVALID_PROVENANCE',
): unknown {
  const descriptor = descriptors.get(key);
  if (!descriptor || !('value' in descriptor)) throw new RemoteAgentExecutionError(code, false);
  return descriptor.value;
}

function readOptionalDataValue(
  descriptors: DataDescriptorRecord,
  key: string,
  code: 'INVALID_TARGET' | 'INVALID_PROVENANCE',
): unknown {
  return descriptors.has(key)
    ? readDataValue(descriptors, key, code)
    : undefined;
}

function normalizeWikiTiddlers(value: unknown): readonly WikiTiddlerAttachment[] {
  if (!Array.isArray(value)) {
    throw new RemoteAgentExecutionError('INVALID_PROVENANCE', false);
  }
  try {
    if (!isPlainArrayPrototype(Reflect.getPrototypeOf(value))) {
      throw new RemoteAgentExecutionError('INVALID_PROVENANCE', false);
    }
    const descriptors = collectDataDescriptors(value);
    const lengthDescriptor = descriptors.get('length');
    const length: unknown = lengthDescriptor && 'value' in lengthDescriptor
      ? lengthDescriptor.value
      : undefined;
    if (
      typeof length !== 'number' ||
      !Number.isSafeInteger(length) ||
      length < 0 ||
      length > REMOTE_AGENT_EXECUTION_LIMITS.wikiTiddlers
    ) throw new RemoteAgentExecutionError('INVALID_PROVENANCE', false);
    const expectedKeys = new Set(['length', ...Array.from({ length }, (_, index) => String(index))]);
    const descriptorKeys = [...descriptors.keys()];
    if (
      descriptorKeys.some(key => typeof key !== 'string' || !expectedKeys.has(key)) ||
      expectedKeys.size !== descriptorKeys.length
    ) throw new RemoteAgentExecutionError('INVALID_PROVENANCE', false);
    const result: WikiTiddlerAttachment[] = [];
    for (let index = 0; index < length; index += 1) {
      const itemDescriptor = descriptors.get(String(index));
      if (!itemDescriptor?.enumerable || !('value' in itemDescriptor)) {
        throw new RemoteAgentExecutionError('INVALID_PROVENANCE', false);
      }
      const item = readExactDataRecord(
        itemDescriptor.value,
        ['workspaceName', 'tiddlerTitle'],
        [],
        'INVALID_PROVENANCE',
      );
      const workspaceName = readDataValue(item, 'workspaceName', 'INVALID_PROVENANCE');
      const tiddlerTitle = readDataValue(item, 'tiddlerTitle', 'INVALID_PROVENANCE');
      assertBoundedText(
        workspaceName,
        REMOTE_AGENT_EXECUTION_LIMITS.wikiWorkspaceNameCharacters,
      );
      assertBoundedText(
        tiddlerTitle,
        REMOTE_AGENT_EXECUTION_LIMITS.wikiTiddlerTitleCharacters,
      );
      result.push(Object.freeze({ workspaceName, tiddlerTitle }));
    }
    return Object.freeze(result);
  } catch (error) {
    if (error instanceof RemoteAgentExecutionError) throw error;
    throw new RemoteAgentExecutionError('INVALID_PROVENANCE', false);
  }
}

function isPlainArrayPrototype(prototype: object | null): boolean {
  if (prototype === Array.prototype) return true;
  if (prototype === null) return false;
  try {
    const constructor = Object.getOwnPropertyDescriptor(prototype, 'constructor');
    const constructorValue: unknown = constructor && 'value' in constructor
      ? constructor.value
      : undefined;
    return typeof constructorValue === 'function' &&
      constructorValue.name === 'Array' &&
      isPlainObjectPrototype(Reflect.getPrototypeOf(prototype));
  } catch {
    return false;
  }
}

function assertBoundedText(value: unknown, maximumCharacters: number): asserts value is string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > maximumCharacters ||
    value.trim() !== value ||
    hasControlCharacters(value)
  ) throw new RemoteAgentExecutionError('INVALID_PROVENANCE', false);
}

function isPlainObjectPrototype(prototype: object | null): boolean {
  if (prototype === null || prototype === Object.prototype) return true;
  try {
    if (Reflect.getPrototypeOf(prototype) !== null) return false;
    const constructor = Object.getOwnPropertyDescriptor(prototype, 'constructor');
    const constructorValue: unknown = constructor && 'value' in constructor
      ? constructor.value
      : undefined;
    return typeof constructorValue === 'function' && constructorValue.name === 'Object';
  } catch {
    return false;
  }
}

function hasControlCharacters(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1F || code === 0x7F) return true;
  }
  return false;
}

function retryFingerprint(request: RemoteAgentRetryRequest): string {
  return JSON.stringify([
    request.target.kind,
    request.target.kind === 'remote' ? request.target.peerId : '',
    request.provenance.conversationId,
    request.provenance.definitionId,
    request.provenance.turnId,
    request.provenance.requestId,
    request.sourceTurnId,
  ]);
}

function operationOutcome<Result>(
  value: Result,
  synchronization: { state: RemoteAgentSynchronizationState; error?: RemoteAgentExecutionError },
): OperationOutcome<Result> {
  return {
    value,
    synchronization: synchronization.state,
    ...(synchronization.error === undefined ? {} : { syncError: synchronization.error }),
  };
}

function normalizeCapacity(value: number | undefined, fallback: number): number {
  const capacity = value ?? fallback;
  if (!Number.isSafeInteger(capacity) || capacity < 1 || capacity > 1_000_000) {
    throw new RemoteAgentExecutionError('CAPACITY_EXCEEDED', false);
  }
  return capacity;
}

function normalizeOperationError(error: unknown, signal: AbortSignal): RemoteAgentExecutionError {
  if (error instanceof RemoteAgentExecutionError) return error;
  if (signal.aborted) {
    return signal.reason instanceof RemoteAgentExecutionError
      ? signal.reason
      : new RemoteAgentExecutionError('CANCELLED', false);
  }
  return new RemoteAgentExecutionError('PORT_FAILURE', true);
}

function linkSignals(primary: AbortSignal, secondary: AbortSignal | undefined): {
  readonly signal: AbortSignal;
  cleanup(): void;
} {
  const controller = new AbortController();
  const linked = linkIntoController(controller, primary, secondary);
  return {
    signal: controller.signal,
    cleanup: () => {
      linked.cleanup();
    },
  };
}

function linkIntoController(
  controller: AbortController,
  primary: AbortSignal,
  secondary: AbortSignal | undefined,
): { cleanup(): void } {
  const signals = secondary ? [primary, secondary] : [primary];
  const entries = signals.map(signal => ({
    signal,
    listener: () => {
      if (!controller.signal.aborted) controller.abort(signal.reason);
    },
  }));
  for (const entry of entries) {
    if (entry.signal.aborted) entry.listener();
    else entry.signal.addEventListener('abort', entry.listener, { once: true });
  }
  return {
    cleanup: () => {
      for (const entry of entries) entry.signal.removeEventListener('abort', entry.listener);
    },
  };
}

function defaultCreateId(): string {
  const randomUUID = globalThis.crypto?.randomUUID?.bind(globalThis.crypto);
  if (!randomUUID) throw new RemoteAgentExecutionError('INVALID_PROVENANCE', false);
  return randomUUID();
}
