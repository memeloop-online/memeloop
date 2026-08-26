import type { ChatMessage, ConversationEventDraft, ConversationMessageEvent, ConversationMessagePayload, ConversationTombstoneEvent } from '../conversation/index.js';
import { assertCanonicalConversationEvent } from '../conversation/index.js';
import { canonicalJsonBytes, domainSeparatedCanonicalJsonBytes } from '../encoding/canonicalJson.js';
import { sha256HexSync } from '../encoding/sha256.js';
import type { AgentRunRecord, AgentRunStateStore } from '../runState.js';

/**
 * One physical transaction spanning retry idempotency and the conversation log.
 * Production hosts whose run state and event log share a database implement
 * this capability; the runtime never treats two independent writes as atomic.
 */
export interface AtomicAgentRetryStore extends AgentRunStateStore {
  /**
   * The implementation MUST open one physical transaction, lookup the
   * peer/request row first, and:
   * - existing request: validate every immutable candidate field and return
   *   its already persisted pair with created=false, even when mode is fresh
   *   because two runtimes may have observed absence concurrently;
   * - fresh request: indexed-read sourceTurnId and compare it exactly with
   *   expectedSourceMessage before inserting run + both events;
   * - replay: require the existing request/run identity and return the already
   *   persisted event pair. It must not treat replacement content as a fresh source.
   */
  retryTurnAtomic(input: AtomicAgentRetryInput): Promise<AtomicAgentRetryResult>;
}

interface AtomicAgentRetryInputBase {
  /** Fresh candidate; implementations create-or-get by its peer/request key. */
  candidateRun: AgentRunRecord;
  /** Old user-root identity that must be checked by an indexed read. */
  sourceTurnId: string;
  /** Exact replacement payload derived from expectedSourceMessage; never supplied by UI/RPC. */
  replacementPayload: ConversationMessagePayload;
  /** Stable local causal allocator identity used for both new events. */
  originNodeId: string;
}

export type AtomicAgentRetryInput =
  & AtomicAgentRetryInputBase
  & (
    | {
      mode: 'fresh';
      /** Exact durable old root observed by Core; transaction compares every field. */
      expectedSourceMessage: ChatMessage;
    }
    | {
      mode: 'replay';
      /** Replay proves the existing request row and returns its existing pair. */
      expectedSourceMessage?: never;
    }
  );

export interface AtomicAgentRetryResult {
  run: AgentRunRecord;
  created: boolean;
  tombstone: ConversationTombstoneEvent;
  userEvent: ConversationMessageEvent;
}

export function isAtomicAgentRetryStore(value: unknown): value is AtomicAgentRetryStore {
  if (!value || typeof value !== 'object') return false;
  const store = value as Partial<AtomicAgentRetryStore>;
  return typeof store.retryTurnAtomic === 'function' &&
    typeof store.createOrGet === 'function' &&
    typeof store.getByRequest === 'function' &&
    typeof store.transition === 'function';
}

export function assertAtomicAgentRetrySourceMessage(
  expected: ChatMessage,
  actual: ChatMessage,
): void {
  const expectedBytes = canonicalJsonBytes(expected);
  const actualBytes = canonicalJsonBytes(actual);
  if (
    expectedBytes.byteLength !== actualBytes.byteLength ||
    expectedBytes.some((byte, index) => byte !== actualBytes[index])
  ) throw new Error('atomic_agent_retry_source_drift');
}

export function createAtomicAgentRetryReplacementPayload(
  source: ChatMessage,
  newTurnId: string,
): ConversationMessagePayload {
  if (
    source.role !== 'user' ||
    source.messageId !== source.turnId ||
    !newTurnId
  ) throw new Error('atomic_agent_retry_source_identity');
  return {
    messageId: newTurnId,
    turnId: newTurnId,
    role: 'user',
    content: source.content,
    ...(source.parts === undefined ? {} : { parts: source.parts }),
    ...(source.toolCalls === undefined ? {} : { toolCalls: source.toolCalls }),
    ...(source.attachments === undefined ? {} : { attachments: source.attachments }),
    ...(source.detailRef === undefined ? {} : { detailRef: source.detailRef }),
    ...(source.reasoning_content === undefined ? {} : { reasoning_content: source.reasoning_content }),
    ...(source.contentType === undefined ? {} : { contentType: source.contentType }),
    ...(source.hidden === undefined ? {} : { hidden: source.hidden }),
    ...(source.duration === undefined ? {} : { duration: source.duration }),
    ...(source.metadata === undefined ? {} : { metadata: source.metadata }),
  };
}

export type Sha256HexProvider = (
  bytes: Uint8Array,
  signal?: AbortSignal,
) => string | Promise<string>;

export async function portableSha256Hex(
  bytes: Uint8Array,
  signal?: AbortSignal,
): Promise<string> {
  signal?.throwIfAborted();
  if (globalThis.crypto?.subtle) {
    // Copy into a plain ArrayBuffer-backed view. Callers may provide a
    // SharedArrayBuffer-backed Uint8Array, which WebCrypto deliberately rejects.
    const digestInput = new Uint8Array(bytes.byteLength);
    digestInput.set(bytes);
    const digest = await globalThis.crypto.subtle.digest(
      'SHA-256',
      digestInput,
    );
    signal?.throwIfAborted();
    return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
  }
  const digest = sha256HexSync(bytes);
  signal?.throwIfAborted();
  return digest;
}

export async function digestAtomicAgentRetryPayload(input: {
  conversationId: string;
  definitionId: string;
  sourceTurnId: string;
  newTurnId: string;
  replacementPayload: ConversationMessagePayload;
}, sha256Hex: Sha256HexProvider = portableSha256Hex): Promise<string> {
  const bytes = domainSeparatedCanonicalJsonBytes('memeloop-run-payload-v1', {
    operation: 'retry-turn-v2',
    conversationId: input.conversationId,
    definitionId: input.definitionId,
    sourceTurnId: input.sourceTurnId,
    newTurnId: input.newTurnId,
    userMessage: input.replacementPayload,
  }, {
    maxDepth: 64,
    maxNodes: 50_000,
    maxStringCodeUnits: 1_048_576,
    maxStringBytes: 1_048_576,
    maxBytes: 2 * 1_048_576,
  });
  return sha256Hex(bytes);
}

export function createAtomicAgentRetryEventDrafts(
  run: AgentRunRecord,
  input: Pick<AtomicAgentRetryInput, 'sourceTurnId' | 'replacementPayload' | 'originNodeId'>,
): readonly [ConversationEventDraft, ConversationEventDraft] {
  if (
    run.retrySourceTurnId !== input.sourceTurnId ||
    run.turnId !== input.replacementPayload.turnId ||
    input.replacementPayload.messageId !== run.turnId ||
    input.replacementPayload.role !== 'user'
  ) throw new Error('atomic_agent_retry_identity');
  return [
    {
      kind: 'tombstone',
      eventId: `tombstone:retry:${run.runId}`,
      conversationId: run.conversationId,
      originNodeId: input.originNodeId,
      timestamp: run.acceptedAt,
      targetTurnId: input.sourceTurnId,
      reason: 'user-delete',
    },
    {
      kind: 'message',
      eventId: run.turnId,
      conversationId: run.conversationId,
      originNodeId: input.originNodeId,
      timestamp: run.acceptedAt + 1,
      message: input.replacementPayload,
    },
  ];
}

export function assertAtomicAgentRetryResult(
  input: AtomicAgentRetryInput,
  value: AtomicAgentRetryResult,
): void {
  const { run, tombstone, userEvent } = value;
  if (
    run.requestPeerId !== input.candidateRun.requestPeerId ||
    run.requestId !== input.candidateRun.requestId ||
    run.payloadDigest !== input.candidateRun.payloadDigest ||
    run.conversationId !== input.candidateRun.conversationId ||
    run.definitionId !== input.candidateRun.definitionId ||
    run.turnId !== input.candidateRun.turnId ||
    run.retrySourceTurnId !== input.sourceTurnId
  ) throw new Error('atomic_agent_retry_run_correlation');
  try {
    assertCanonicalConversationEvent(tombstone);
    assertCanonicalConversationEvent(userEvent);
  } catch {
    throw new Error('atomic_agent_retry_event_validation');
  }
  if (
    tombstone.kind !== 'tombstone' ||
    tombstone.eventId !== `tombstone:retry:${run.runId}` ||
    tombstone.conversationId !== run.conversationId ||
    tombstone.targetTurnId !== input.sourceTurnId ||
    tombstone.reason !== 'user-delete' ||
    userEvent.kind !== 'message' ||
    userEvent.eventId !== run.turnId ||
    userEvent.conversationId !== run.conversationId ||
    userEvent.message.messageId !== run.turnId ||
    userEvent.message.turnId !== run.turnId ||
    userEvent.message.role !== 'user'
  ) throw new Error('atomic_agent_retry_event_correlation');
  const expectedPayloadBytes = canonicalJsonBytes(input.replacementPayload);
  const actualPayloadBytes = canonicalJsonBytes(userEvent.message);
  if (
    expectedPayloadBytes.byteLength !== actualPayloadBytes.byteLength ||
    expectedPayloadBytes.some((byte, index) => byte !== actualPayloadBytes[index])
  ) throw new Error('atomic_agent_retry_replacement_drift');
}

/** Reusable host conformance for replay and request-drift fencing. */
export async function assertAtomicAgentRetryStoreConformance(
  store: AtomicAgentRetryStore,
  input: AtomicAgentRetryInput,
): Promise<AtomicAgentRetryResult> {
  const first = await store.retryTurnAtomic(input);
  assertAtomicAgentRetryResult(input, first);
  const concurrentFreshReplay = await store.retryTurnAtomic(input);
  assertAtomicAgentRetryResult(input, concurrentFreshReplay);
  if (
    concurrentFreshReplay.run.runId !== first.run.runId ||
    concurrentFreshReplay.tombstone.eventId !== first.tombstone.eventId ||
    concurrentFreshReplay.userEvent.eventId !== first.userEvent.eventId ||
    concurrentFreshReplay.created
  ) throw new Error('atomic_agent_retry_concurrent_fresh_conformance_failed');
  const { expectedSourceMessage: _expectedSourceMessage, ...replayBase } = input;
  const replayInput: AtomicAgentRetryInput = { ...replayBase, mode: 'replay' };
  const replay = await store.retryTurnAtomic(replayInput);
  assertAtomicAgentRetryResult(replayInput, replay);
  if (
    replay.run.runId !== first.run.runId ||
    replay.tombstone.eventId !== first.tombstone.eventId ||
    replay.userEvent.eventId !== first.userEvent.eventId ||
    replay.created
  ) throw new Error('atomic_agent_retry_replay_conformance_failed');
  await store.retryTurnAtomic({
    ...input,
    candidateRun: {
      ...input.candidateRun,
      runId: `${input.candidateRun.runId}:drift`,
      payloadDigest: `${input.candidateRun.payloadDigest}:drift`,
    },
  }).then(
    () => {
      throw new Error('atomic_agent_retry_drift_conformance_failed');
    },
    () => undefined,
  );
  return first;
}
