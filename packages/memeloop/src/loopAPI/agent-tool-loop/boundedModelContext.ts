import {
  assertCanonicalChatMessageProjection,
  assertCanonicalConversationEvent,
  type ChatMessage,
  type ContextCompactionBoundaryV2,
  type ContextCompactionCoverage,
  type ContextCompactionProgress,
  type ConversationCompactionEvent,
  type ConversationCompactionSummaryEvent,
  createContextCompactionBoundaryFromCoverage,
} from '../../conversation/index.js';
import { canonicalJsonBytes } from '../../encoding/canonicalJson.js';
import { AGENT_RUN_ERROR_MESSAGE_KEYS, AgentRunFailure, createAgentRunError } from '../../runState.js';
import { compareMessageCursor, messageCursor, readConversationFullContentMessagePage } from '../../storage/conversationPaging.js';
import type { CompactionCandidatePage, ConversationEventStore, RetainedCompactionControlPage } from '../../storage/ports.js';

export const BOUNDED_MODEL_CONTEXT_LIMITS = Object.freeze(
  {
    retainedControlPage: 32,
    retainedControlBytes: 256 * 1024,
    candidateMessages: 50,
    candidateBytes: 256 * 1024,
    recentMessagePage: 50,
    maximumRecentSnapshotResets: 8,
    maximumContextMessages: 256,
    maximumContextBytes: 4 * 1024 * 1024,
    maximumSummaryBytes: 64 * 1024,
    maximumConsolidationRounds: 1024,
    maximumCandidateEvents: 1_000_000,
    foregroundProviderCalls: 4,
    foregroundWorkPages: 8,
    backgroundProviderCalls: 8,
    backgroundWorkPages: 16,
    maximumProviderCallsPerSlice: 16,
    maximumWorkPagesPerSlice: 32,
  } as const,
);

export interface ContextCompactionWorkBudget {
  /** Hard provider calls for this one foreground/background slice. */
  readonly maxProviderCalls: number;
  /** Hard storage pages for this one foreground/background slice. */
  readonly maxWorkPages: number;
}

export class BoundedModelContextError extends AgentRunFailure {
  readonly code:
    | 'CONTEXT_COMPACTION_PENDING'
    | 'CONTEXT_COMPACTION_FAILED'
    | 'CONTEXT_COMPACTION_STALLED'
    | 'CONTEXT_BUDGET_EXCEEDED';
  readonly progress?: Readonly<ContextCompactionProgress>;

  constructor(
    code: BoundedModelContextError['code'],
    progress?: ContextCompactionProgress,
  ) {
    const publicCheckpointRevision = safePublicCheckpointRevision(
      progress?.checkpointRevision,
    );
    const publicCode = code === 'CONTEXT_COMPACTION_PENDING'
      ? 'CONTEXT_COMPACTION_PENDING'
      : code === 'CONTEXT_BUDGET_EXCEEDED'
      ? 'CONTEXT_BUDGET_EXCEEDED'
      : 'CONTEXT_COMPACTION_FAILED';
    super(createAgentRunError({
      code: publicCode,
      messageKey: AGENT_RUN_ERROR_MESSAGE_KEYS[publicCode],
      retryable: publicCode === 'CONTEXT_COMPACTION_FAILED' ||
        publicCode === 'CONTEXT_COMPACTION_PENDING',
      ...(progress === undefined
        ? {}
        : {
          localizedParams: {
            ...(publicCheckpointRevision === undefined
              ? {}
              : { checkpointRevision: publicCheckpointRevision }),
            processedMessages: progress.processedMessages,
            ...(progress.remainingEstimate === undefined
              ? {}
              : { remainingEstimate: progress.remainingEstimate }),
          },
        }),
    }));
    this.name = 'BoundedModelContextError';
    this.code = code;
    this.progress = progress === undefined ? undefined : Object.freeze({ ...progress });
  }
}

export interface LoadBoundedModelContextOptions {
  storage: ConversationEventStore;
  conversationId: string;
  localNodeId: string;
  signal: AbortSignal;
  /** Frozen exact-route summarizer supplied by the model request builder. */
  summarize: (messages: readonly ChatMessage[], signal: AbortSignal) => Promise<string>;
  recentTurnsToKeep?: number;
  maxContextMessages?: number;
  maxContextBytes?: number;
  /** Foreground defaults to four provider calls; background slices are still hard-bounded. */
  workMode?: 'foreground' | 'background';
  workBudget?: Partial<ContextCompactionWorkBudget>;
  /** Schedule one later slice; it must not execute compaction inline. */
  onCompactionContinuationNeeded?: (progress: Readonly<ContextCompactionProgress>) => void;
  createId?: () => string;
  now?: () => number;
}

export interface BoundedModelContext {
  /** Actual bounded semantic messages supplied to the model/preview builder. */
  messages: ChatMessage[];
  coverage: ContextCompactionCoverage;
  retainedSummaryCount: number;
  recentMessageCount: number;
  invalidatedSummaryRebuilt: boolean;
}

interface ContextCompactionWorkTracker {
  readonly budget: ContextCompactionWorkBudget;
  providerCalls: number;
  workPages: number;
  checkpointRevision?: string;
  coverage: ContextCompactionCoverage;
}

function safePublicCheckpointRevision(value: string | undefined): string | undefined {
  if (
    value === undefined ||
    !/^compaction:[A-Za-z0-9._:-]+$/u.test(value) ||
    new TextEncoder().encode(value).byteLength > 256
  ) return undefined;
  return value;
}

/**
 * Build executable model context without ever materializing the full audit log.
 * Every old prefix is read through storage-owned causal candidate pages and is
 * made durable only after a successful bounded summary call.
 */
export async function loadBoundedModelContext(
  options: LoadBoundedModelContextOptions,
): Promise<BoundedModelContext> {
  const {
    storage,
    conversationId,
    signal,
  } = options;
  assertOptions(options);
  signal.throwIfAborted();
  const work = createWorkTracker(options);

  const maximumContextBytes = options.maxContextBytes ??
    BOUNDED_MODEL_CONTEXT_LIMITS.maximumContextBytes;
  const maximumContextMessages = options.maxContextMessages ??
    BOUNDED_MODEL_CONTEXT_LIMITS.maximumContextMessages;
  const recentTurnsToKeep = options.recentTurnsToKeep ?? 32;

  const recent = await loadRecentCompleteTurns(
    storage,
    conversationId,
    recentTurnsToKeep,
    maximumContextMessages,
    maximumContextBytes,
    signal,
  );
  const beforeDisplayCursor = recent[0] ? messageCursor(recent[0]) : undefined;

  const retained = await consolidateRetainedControls(options, work);
  let coverage = coverageFromControls(retained.items);
  work.coverage = coverage;
  work.checkpointRevision ??= latestCompactionRevision(retained.items);
  const uncoveredRecent = recent.filter(message => message.originSequence > (coverage.coveredVersion[message.originNodeId] ?? 0));
  const invalidatedSummaryRebuilt = retained.invalidated;
  let semanticSummaries = retained.items
    .filter((event): event is ConversationCompactionSummaryEvent => event.mode === 'summary')
    .sort(compareCompactionEvents);
  let scannedCandidateEvents = 0;
  for (;;) {
    signal.throwIfAborted();
    consumeWorkPageOrPend(options, work);
    const page = await storage.getCompactionCandidatePage(conversationId, {
      afterCoveredVersion: coverage.coveredVersion,
      ...(beforeDisplayCursor ? { beforeDisplayCursor } : {}),
      maxMessages: BOUNDED_MODEL_CONTEXT_LIMITS.candidateMessages,
      maxBytes: BOUNDED_MODEL_CONTEXT_LIMITS.candidateBytes,
    }, { signal });
    signal.throwIfAborted();
    assertCandidatePageEnvelope(page, conversationId);
    const advancedCoverage = advanceCoverage(coverage, page);
    scannedCandidateEvents += coverageDistance(coverage.coveredVersion, advancedCoverage.coveredVersion);
    if (scannedCandidateEvents > BOUNDED_MODEL_CONTEXT_LIMITS.maximumCandidateEvents) {
      throw new BoundedModelContextError('CONTEXT_BUDGET_EXCEEDED');
    }
    const advanced = !equalVersion(advancedCoverage.coveredVersion, coverage.coveredVersion);
    if (page.hasMore && !advanced) {
      throw new BoundedModelContextError('CONTEXT_COMPACTION_STALLED');
    }

    if (page.messages.length > 0) {
      consumeProviderCallOrPend(options, work);
      const summaryInput = [
        ...semanticSummaries.map(compactionSummaryToMessage),
        ...[...page.messages].sort((left, right) => compareMessageCursor(messageCursor(left), messageCursor(right))),
      ];
      const text = await summarizeOrFail(options, summaryInput);
      assertSummaryText(text);
      const summary = await appendSummaryControl(options, {
        boundary: createContextCompactionBoundaryFromCoverage(
          advancedCoverage,
          semanticSummaries.map(event => event.eventId),
        ),
        summaryText: text,
      });
      semanticSummaries = [summary];
      coverage = advancedCoverage;
      work.coverage = coverage;
      work.checkpointRevision = summary.eventId;
    } else if (advanced) {
      const checkpoint = await appendCoverageControl(options, {
        boundary: createContextCompactionBoundaryFromCoverage(advancedCoverage),
      });
      coverage = advancedCoverage;
      work.coverage = coverage;
      work.checkpointRevision = checkpoint.eventId;
    }

    if (!page.hasMore) break;
  }

  const messages = [
    ...semanticSummaries.map(compactionSummaryToMessage),
    ...uncoveredRecent,
  ];
  if (messages.length > maximumContextMessages || !fitsCanonicalBudget(messages, maximumContextBytes)) {
    throw new BoundedModelContextError('CONTEXT_BUDGET_EXCEEDED');
  }
  return {
    messages,
    coverage,
    retainedSummaryCount: semanticSummaries.length,
    recentMessageCount: uncoveredRecent.length,
    invalidatedSummaryRebuilt,
  };
}

function createWorkTracker(
  options: LoadBoundedModelContextOptions,
): ContextCompactionWorkTracker {
  const background = options.workMode === 'background';
  return {
    budget: {
      maxProviderCalls: options.workBudget?.maxProviderCalls ?? (background
        ? BOUNDED_MODEL_CONTEXT_LIMITS.backgroundProviderCalls
        : BOUNDED_MODEL_CONTEXT_LIMITS.foregroundProviderCalls),
      maxWorkPages: options.workBudget?.maxWorkPages ?? (background
        ? BOUNDED_MODEL_CONTEXT_LIMITS.backgroundWorkPages
        : BOUNDED_MODEL_CONTEXT_LIMITS.foregroundWorkPages),
    },
    providerCalls: 0,
    workPages: 0,
    coverage: {
      coveredVersion: {},
      coveredMessageCountByOrigin: {},
      coveredUserTurnCountByOrigin: {},
    },
  };
}

function consumeWorkPageOrPend(
  options: LoadBoundedModelContextOptions,
  work: ContextCompactionWorkTracker,
): void {
  if (work.workPages >= work.budget.maxWorkPages) {
    throwCompactionPending(options, work);
  }
  work.workPages += 1;
}

function consumeProviderCallOrPend(
  options: LoadBoundedModelContextOptions,
  work: ContextCompactionWorkTracker,
): void {
  if (work.providerCalls >= work.budget.maxProviderCalls) {
    throwCompactionPending(options, work);
  }
  work.providerCalls += 1;
}

function throwCompactionPending(
  options: LoadBoundedModelContextOptions,
  work: ContextCompactionWorkTracker,
  remainingEstimate?: number,
): never {
  const progress: ContextCompactionProgress = Object.freeze({
    ...(work.checkpointRevision === undefined
      ? {}
      : { checkpointRevision: work.checkpointRevision }),
    processedMessages: coveredMessageCount(work.coverage),
    ...(remainingEstimate === undefined ? {} : { remainingEstimate }),
    providerCalls: work.providerCalls,
    workPages: work.workPages,
  });
  const scheduleContinuation = options.onCompactionContinuationNeeded;
  if (scheduleContinuation) {
    queueMicrotask(() => {
      try {
        scheduleContinuation(progress);
      } catch {
        // Scheduling is best-effort. The durable checkpoint and typed pending
        // error remain authoritative even if one host listener fails.
      }
    });
  }
  throw new BoundedModelContextError('CONTEXT_COMPACTION_PENDING', progress);
}

function coveredMessageCount(coverage: ContextCompactionCoverage): number {
  let total = 0;
  for (const count of Object.values(coverage.coveredMessageCountByOrigin)) {
    if (!Number.isSafeInteger(count) || count < 0 || !Number.isSafeInteger(total + count)) {
      throw new BoundedModelContextError('CONTEXT_COMPACTION_FAILED');
    }
    total += count;
  }
  return total;
}

function latestCompactionRevision(
  controls: readonly ConversationCompactionEvent[],
): string | undefined {
  return [...controls].sort(compareCompactionEvents).at(-1)?.eventId;
}

async function consolidateRetainedControls(
  options: LoadBoundedModelContextOptions,
  work: ContextCompactionWorkTracker,
): Promise<{ items: ConversationCompactionEvent[]; invalidated: boolean }> {
  let invalidated = false;
  for (let round = 0; round < BOUNDED_MODEL_CONTEXT_LIMITS.maximumConsolidationRounds; round += 1) {
    options.signal.throwIfAborted();
    consumeWorkPageOrPend(options, work);
    const page = await options.storage.getRetainedCompactionControls(options.conversationId, {
      limit: BOUNDED_MODEL_CONTEXT_LIMITS.retainedControlPage,
      maxBytes: BOUNDED_MODEL_CONTEXT_LIMITS.retainedControlBytes,
    }, { signal: options.signal });
    options.signal.throwIfAborted();
    assertRetainedControlPage(page, options.conversationId);
    work.coverage = coverageFromControls(page.items);
    work.checkpointRevision = latestCompactionRevision(page.items);
    invalidated ||= page.invalidated;
    if (!page.hasMore) return { items: page.items, invalidated };
    if (page.items.length === 0) {
      throw new BoundedModelContextError('CONTEXT_COMPACTION_STALLED');
    }

    const coverage = coverageFromControls(page.items);
    const summaries = page.items
      .filter((event): event is ConversationCompactionSummaryEvent => event.mode === 'summary')
      .sort(compareCompactionEvents);
    if (summaries.length === 0) {
      const checkpoint = await appendCoverageControl(options, {
        boundary: createContextCompactionBoundaryFromCoverage(coverage),
      });
      work.checkpointRevision = checkpoint.eventId;
    } else {
      consumeProviderCallOrPend(options, work);
      const text = await summarizeOrFail(options, summaries.map(compactionSummaryToMessage));
      assertSummaryText(text);
      const checkpoint = await appendSummaryControl(options, {
        boundary: createContextCompactionBoundaryFromCoverage(
          coverage,
          summaries.map(event => event.eventId),
        ),
        summaryText: text,
      });
      work.checkpointRevision = checkpoint.eventId;
    }
  }
  throw new BoundedModelContextError('CONTEXT_COMPACTION_STALLED');
}

function assertCandidatePageEnvelope(
  page: CompactionCandidatePage,
  conversationId: string,
): void {
  assertBoundedContextPage(page, BOUNDED_MODEL_CONTEXT_LIMITS.candidateBytes);
  if (
    !hasExactDataKeys(page, [
      'messages',
      'nextCoveredVersion',
      'newlyCoveredMessageCountByOrigin',
      'newlyCoveredUserTurnCountByOrigin',
      'hasMore',
    ]) ||
    !Array.isArray(page.messages) ||
    page.messages.length > BOUNDED_MODEL_CONTEXT_LIMITS.candidateMessages ||
    typeof page.hasMore !== 'boolean'
  ) throw new BoundedModelContextError('CONTEXT_COMPACTION_FAILED');
  for (const message of page.messages) {
    try {
      assertCanonicalChatMessageProjection(message, conversationId);
    } catch {
      throw new BoundedModelContextError('CONTEXT_COMPACTION_FAILED');
    }
  }
}

function assertRetainedControlPage(
  page: RetainedCompactionControlPage,
  conversationId: string,
): void {
  assertBoundedContextPage(page, BOUNDED_MODEL_CONTEXT_LIMITS.retainedControlBytes);
  if (
    !hasExactDataKeys(page, ['items', 'hasMore', 'nextCursor', 'invalidated']) ||
    !Array.isArray(page.items) ||
    page.items.length > BOUNDED_MODEL_CONTEXT_LIMITS.retainedControlPage ||
    typeof page.hasMore !== 'boolean' ||
    typeof page.invalidated !== 'boolean'
  ) throw new BoundedModelContextError('CONTEXT_COMPACTION_FAILED');
  for (const event of page.items) {
    try {
      assertCanonicalConversationEvent(event);
    } catch {
      throw new BoundedModelContextError('CONTEXT_COMPACTION_FAILED');
    }
    if (event.kind !== 'compaction' || event.conversationId !== conversationId) {
      throw new BoundedModelContextError('CONTEXT_COMPACTION_FAILED');
    }
  }
}

function assertBoundedContextPage(value: unknown, maxBytes: number): void {
  try {
    canonicalJsonBytes(value, {
      maxBytes,
      maxDepth: 64,
      maxNodes: 200_000,
      maxStringBytes: maxBytes,
      maxStringCodeUnits: maxBytes,
    });
  } catch {
    throw new BoundedModelContextError('CONTEXT_COMPACTION_FAILED');
  }
}

function hasExactDataKeys(value: object, allowed: readonly string[]): boolean {
  const allowedKeys = new Set(allowed);
  const required = new Set(allowed.filter(key => key !== 'nextCursor'));
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== 'string' || !allowedKeys.has(key)) return false;
    const descriptor = descriptors[key];
    if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) return false;
    required.delete(key);
  }
  return required.size === 0;
}

async function loadRecentCompleteTurns(
  storage: ConversationEventStore,
  conversationId: string,
  recentTurnsToKeep: number,
  maximumMessages: number,
  maximumBytes: number,
  signal: AbortSignal,
): Promise<ChatMessage[]> {
  let messages: ChatMessage[] = [];
  let before: ReturnType<typeof messageCursor> | undefined;
  let expectedRevision: string | undefined;
  let snapshotResets = 0;
  for (;;) {
    signal.throwIfAborted();
    const usedBytes = canonicalMessageArrayBytes(messages, maximumBytes);
    const remainingBytes = maximumBytes - usedBytes;
    if (remainingBytes < 1 || messages.length >= maximumMessages) {
      return newestCompleteTurnSuffix(messages, recentTurnsToKeep);
    }
    let page;
    try {
      page = await readConversationFullContentMessagePage(storage, conversationId, {
        limit: Math.min(
          BOUNDED_MODEL_CONTEXT_LIMITS.recentMessagePage,
          maximumMessages - messages.length,
        ),
        maxBytes: Math.min(remainingBytes, BOUNDED_MODEL_CONTEXT_LIMITS.candidateBytes),
        direction: 'backward',
        ...(before ? { before } : {}),
        ...(expectedRevision ? { expectedRevision } : {}),
      }, { signal });
    } catch (error) {
      signal.throwIfAborted();
      if (error instanceof BoundedModelContextError) throw error;
      throw new BoundedModelContextError('CONTEXT_COMPACTION_FAILED');
    }
    signal.throwIfAborted();
    if (page.reset) {
      snapshotResets += 1;
      if (snapshotResets > BOUNDED_MODEL_CONTEXT_LIMITS.maximumRecentSnapshotResets) {
        throw new BoundedModelContextError('CONTEXT_COMPACTION_STALLED');
      }
      messages = [];
      before = undefined;
      expectedRevision = page.revision;
      continue;
    }
    expectedRevision = page.revision;
    if (page.items.length === 0 && page.hasMoreBefore) {
      throw new BoundedModelContextError('CONTEXT_COMPACTION_STALLED');
    }
    messages = [...page.items, ...messages];
    if (!fitsCanonicalBudget(messages, maximumBytes)) {
      return newestCompleteTurnSuffix(messages.slice(page.items.length), recentTurnsToKeep);
    }
    const roots = userRootIndices(messages);
    if (roots.length >= recentTurnsToKeep || !page.hasMoreBefore) {
      return newestCompleteTurnSuffix(messages, recentTurnsToKeep);
    }
    const nextBefore = page.startCursor;
    if (!nextBefore || before && equalMessageCursor(before, nextBefore)) {
      throw new BoundedModelContextError('CONTEXT_COMPACTION_STALLED');
    }
    before = nextBefore;
  }
}

/**
 * Preserve as many newest complete user-rooted turns as fit. A suffix with no
 * visible root is a partial oversized turn, so it is deliberately returned as
 * empty and compacted through bounded candidate pages instead of permanently
 * failing every future run.
 */
function newestCompleteTurnSuffix(
  messages: readonly ChatMessage[],
  maximumTurns: number,
): ChatMessage[] {
  const roots = userRootIndices(messages);
  const firstRoot = roots[Math.max(0, roots.length - maximumTurns)];
  return firstRoot === undefined ? [] : messages.slice(firstRoot);
}

function userRootIndices(messages: readonly ChatMessage[]): number[] {
  const roots: number[] = [];
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (message.role === 'user' && message.messageId === message.turnId) roots.push(index);
  }
  return roots;
}

function coverageFromControls(
  controls: readonly ConversationCompactionEvent[],
): ContextCompactionCoverage {
  const result: ContextCompactionCoverage = {
    coveredVersion: {},
    coveredMessageCountByOrigin: {},
    coveredUserTurnCountByOrigin: {},
  };
  for (const control of controls) {
    assertCoverageMaps(control.boundary);
    for (const [origin, sequence] of Object.entries(control.boundary.coveredVersion)) {
      const previous = result.coveredVersion[origin] ?? 0;
      const messageCount = control.boundary.coveredMessageCountByOrigin[origin] ?? 0;
      const turnCount = control.boundary.coveredUserTurnCountByOrigin[origin] ?? 0;
      if (sequence < previous) continue;
      if (
        sequence === previous && previous > 0 &&
        (messageCount !== (result.coveredMessageCountByOrigin[origin] ?? 0) ||
          turnCount !== (result.coveredUserTurnCountByOrigin[origin] ?? 0))
      ) throw new BoundedModelContextError('CONTEXT_COMPACTION_FAILED');
      result.coveredVersion[origin] = sequence;
      result.coveredMessageCountByOrigin[origin] = messageCount;
      result.coveredUserTurnCountByOrigin[origin] = turnCount;
    }
  }
  return result;
}

function advanceCoverage(
  previous: ContextCompactionCoverage,
  page: {
    messages: readonly ChatMessage[];
    nextCoveredVersion: Readonly<Record<string, number>>;
    newlyCoveredMessageCountByOrigin: Readonly<Record<string, number>>;
    newlyCoveredUserTurnCountByOrigin: Readonly<Record<string, number>>;
  },
): ContextCompactionCoverage {
  assertCandidateCoveragePage(previous, page);
  const next: ContextCompactionCoverage = {
    coveredVersion: { ...previous.coveredVersion },
    coveredMessageCountByOrigin: { ...previous.coveredMessageCountByOrigin },
    coveredUserTurnCountByOrigin: { ...previous.coveredUserTurnCountByOrigin },
  };
  for (const [origin, sequence] of Object.entries(page.nextCoveredVersion)) {
    const prior = previous.coveredVersion[origin] ?? 0;
    if (!Number.isSafeInteger(sequence) || sequence < prior) {
      throw new BoundedModelContextError('CONTEXT_COMPACTION_FAILED');
    }
    next.coveredVersion[origin] = sequence;
    next.coveredMessageCountByOrigin[origin] = (previous.coveredMessageCountByOrigin[origin] ?? 0) +
      (page.newlyCoveredMessageCountByOrigin[origin] ?? 0);
    next.coveredUserTurnCountByOrigin[origin] = (previous.coveredUserTurnCountByOrigin[origin] ?? 0) +
      (page.newlyCoveredUserTurnCountByOrigin[origin] ?? 0);
  }
  return next;
}

function assertCandidateCoveragePage(
  previous: ContextCompactionCoverage,
  page: {
    messages: readonly ChatMessage[];
    nextCoveredVersion: Readonly<Record<string, number>>;
    newlyCoveredMessageCountByOrigin: Readonly<Record<string, number>>;
    newlyCoveredUserTurnCountByOrigin: Readonly<Record<string, number>>;
  },
): void {
  const nextOrigins = new Set(Object.keys(page.nextCoveredVersion));
  const actualMessageCountByOrigin: Record<string, number> = {};
  const actualUserTurnCountByOrigin: Record<string, number> = {};
  for (const message of page.messages) {
    const nextSequence = page.nextCoveredVersion[message.originNodeId];
    const previousSequence = previous.coveredVersion[message.originNodeId] ?? 0;
    if (
      nextSequence === undefined || message.originSequence <= previousSequence ||
      message.originSequence > nextSequence
    ) {
      throw new BoundedModelContextError('CONTEXT_COMPACTION_FAILED');
    }
    actualMessageCountByOrigin[message.originNodeId] = (actualMessageCountByOrigin[message.originNodeId] ?? 0) + 1;
    if (message.role === 'user') {
      actualUserTurnCountByOrigin[message.originNodeId] = (actualUserTurnCountByOrigin[message.originNodeId] ?? 0) + 1;
    }
  }
  for (
    const origin of new Set([
      ...Object.keys(page.newlyCoveredMessageCountByOrigin),
      ...Object.keys(page.newlyCoveredUserTurnCountByOrigin),
    ])
  ) {
    if (!nextOrigins.has(origin)) {
      throw new BoundedModelContextError('CONTEXT_COMPACTION_FAILED');
    }
  }
  for (const [origin, sequence] of Object.entries(page.nextCoveredVersion)) {
    const prior = previous.coveredVersion[origin] ?? 0;
    const messageCount = page.newlyCoveredMessageCountByOrigin[origin] ?? 0;
    const turnCount = page.newlyCoveredUserTurnCountByOrigin[origin] ?? 0;
    const distance = sequence - prior;
    if (
      origin.length === 0 || !Number.isSafeInteger(sequence) || sequence <= 0 || sequence < prior ||
      !isNonNegativeSafeInteger(messageCount) || !isNonNegativeSafeInteger(turnCount) ||
      messageCount > distance || turnCount > messageCount ||
      messageCount !== (actualMessageCountByOrigin[origin] ?? 0) ||
      turnCount !== (actualUserTurnCountByOrigin[origin] ?? 0)
    ) {
      throw new BoundedModelContextError('CONTEXT_COMPACTION_FAILED');
    }
  }
}

function assertCoverageMaps(coverage: ContextCompactionCoverage): void {
  const versionOrigins = new Set(Object.keys(coverage.coveredVersion));
  for (
    const origin of new Set([
      ...Object.keys(coverage.coveredMessageCountByOrigin),
      ...Object.keys(coverage.coveredUserTurnCountByOrigin),
    ])
  ) {
    if (!versionOrigins.has(origin)) {
      throw new BoundedModelContextError('CONTEXT_COMPACTION_FAILED');
    }
  }
  for (const [origin, sequence] of Object.entries(coverage.coveredVersion)) {
    const messageCount = coverage.coveredMessageCountByOrigin[origin];
    const turnCount = coverage.coveredUserTurnCountByOrigin[origin];
    if (
      origin.length === 0 || !Number.isSafeInteger(sequence) || sequence <= 0 ||
      !isNonNegativeSafeInteger(messageCount) || !isNonNegativeSafeInteger(turnCount) ||
      messageCount > sequence || turnCount > messageCount
    ) {
      throw new BoundedModelContextError('CONTEXT_COMPACTION_FAILED');
    }
  }
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

async function appendSummaryControl(
  options: LoadBoundedModelContextOptions,
  input: { boundary: ContextCompactionBoundaryV2; summaryText: string },
): Promise<ConversationCompactionSummaryEvent> {
  const event = await appendControl(options, { ...input, mode: 'summary' });
  if (event.mode !== 'summary') throw new BoundedModelContextError('CONTEXT_COMPACTION_FAILED');
  return event;
}

async function appendCoverageControl(
  options: LoadBoundedModelContextOptions,
  input: { boundary: ContextCompactionBoundaryV2 },
): Promise<ConversationCompactionEvent> {
  const event = await appendControl(options, { ...input, mode: 'coverage-only' });
  if (event.mode !== 'coverage-only') {
    throw new BoundedModelContextError('CONTEXT_COMPACTION_FAILED');
  }
  return event;
}

async function appendControl(
  options: LoadBoundedModelContextOptions,
  input:
    | { mode: 'summary'; boundary: ContextCompactionBoundaryV2; summaryText: string }
    | { mode: 'coverage-only'; boundary: ContextCompactionBoundaryV2 },
): Promise<ConversationCompactionEvent> {
  options.signal.throwIfAborted();
  const opaqueId = (options.createId?.() ?? globalThis.crypto.randomUUID()).trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u.test(opaqueId)) {
    throw new BoundedModelContextError('CONTEXT_COMPACTION_FAILED');
  }
  const eventId = `compaction:${opaqueId}`;
  const timestamp = (options.now ?? Date.now)();
  if (!Number.isSafeInteger(timestamp) || timestamp < 0) {
    throw new BoundedModelContextError('CONTEXT_COMPACTION_FAILED');
  }
  const event = await options.storage.appendLocalEvent(
    input.mode === 'summary'
      ? {
        eventId,
        conversationId: options.conversationId,
        originNodeId: options.localNodeId,
        timestamp,
        kind: 'compaction',
        mode: 'summary',
        boundary: input.boundary,
        summary: { turnId: eventId, content: input.summaryText },
      }
      : {
        eventId,
        conversationId: options.conversationId,
        originNodeId: options.localNodeId,
        timestamp,
        kind: 'compaction',
        mode: 'coverage-only',
        boundary: input.boundary,
        summary: null,
      },
  );
  options.signal.throwIfAborted();
  if (event.kind !== 'compaction' || event.mode !== input.mode) {
    throw new BoundedModelContextError('CONTEXT_COMPACTION_FAILED');
  }
  return event;
}

function compactionSummaryToMessage(event: ConversationCompactionSummaryEvent): ChatMessage {
  return {
    messageId: event.eventId,
    turnId: event.summary.turnId,
    conversationId: event.conversationId,
    originNodeId: event.originNodeId,
    originSequence: event.originSequence,
    timestamp: event.timestamp,
    lamportClock: event.lamportClock,
    role: 'assistant',
    content: event.summary.content,
    ...(event.summary.parts ? { parts: event.summary.parts } : {}),
    metadata: { contextCompaction: event.boundary, compacted: true },
  };
}

function compareCompactionEvents(
  left: ConversationCompactionEvent,
  right: ConversationCompactionEvent,
): number {
  return left.timestamp - right.timestamp || left.lamportClock - right.lamportClock ||
    compareCanonicalText(left.originNodeId, right.originNodeId) ||
    compareCanonicalText(left.eventId, right.eventId);
}

function compareCanonicalText(left: string, right: string): number {
  const leftIterator = left[Symbol.iterator]();
  const rightIterator = right[Symbol.iterator]();
  for (;;) {
    const leftItem = leftIterator.next();
    const rightItem = rightIterator.next();
    if (leftItem.done || rightItem.done) {
      if (leftItem.done && rightItem.done) return 0;
      return leftItem.done ? -1 : 1;
    }
    const difference = leftItem.value.codePointAt(0)! - rightItem.value.codePointAt(0)!;
    if (difference !== 0) return difference;
  }
}

function assertSummaryText(value: string): void {
  if (
    typeof value !== 'string' || value.trim().length < 10 ||
    new TextEncoder().encode(value).byteLength > BOUNDED_MODEL_CONTEXT_LIMITS.maximumSummaryBytes
  ) throw new BoundedModelContextError('CONTEXT_COMPACTION_FAILED');
}

async function summarizeOrFail(
  options: LoadBoundedModelContextOptions,
  messages: readonly ChatMessage[],
): Promise<string> {
  options.signal.throwIfAborted();
  try {
    const text = await options.summarize(messages, options.signal);
    options.signal.throwIfAborted();
    assertSummaryText(text);
    return text;
  } catch (error) {
    options.signal.throwIfAborted();
    if (error instanceof BoundedModelContextError) throw error;
    throw new BoundedModelContextError('CONTEXT_COMPACTION_FAILED');
  }
}

function equalVersion(
  left: Readonly<Record<string, number>>,
  right: Readonly<Record<string, number>>,
): boolean {
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  for (const key of keys) if ((left[key] ?? 0) !== (right[key] ?? 0)) return false;
  return true;
}

function fitsCanonicalBudget(messages: readonly ChatMessage[], maxBytes: number): boolean {
  try {
    canonicalJsonBytes(messages, {
      maxBytes,
      maxDepth: 64,
      maxNodes: 200_000,
      maxStringBytes: maxBytes,
      maxStringCodeUnits: maxBytes,
    });
    return true;
  } catch {
    return false;
  }
}

function canonicalMessageArrayBytes(messages: readonly ChatMessage[], maxBytes: number): number {
  try {
    return canonicalJsonBytes(messages, {
      maxBytes,
      maxDepth: 64,
      maxNodes: 200_000,
      maxStringBytes: maxBytes,
      maxStringCodeUnits: maxBytes,
    }).byteLength;
  } catch {
    throw new BoundedModelContextError('CONTEXT_BUDGET_EXCEEDED');
  }
}

function equalMessageCursor(
  left: ReturnType<typeof messageCursor>,
  right: ReturnType<typeof messageCursor>,
): boolean {
  return left.timestamp === right.timestamp && left.lamportClock === right.lamportClock &&
    left.originNodeId === right.originNodeId && left.messageId === right.messageId;
}

function coverageDistance(
  previous: Readonly<Record<string, number>>,
  next: Readonly<Record<string, number>>,
): number {
  let distance = 0;
  for (const [origin, sequence] of Object.entries(next)) {
    distance += sequence - (previous[origin] ?? 0);
    if (!Number.isSafeInteger(distance)) {
      throw new BoundedModelContextError('CONTEXT_BUDGET_EXCEEDED');
    }
  }
  return distance;
}

function assertOptions(options: LoadBoundedModelContextOptions): void {
  const workBudget = options.workBudget;
  if (
    options.conversationId.trim().length === 0 || options.localNodeId.trim().length === 0 ||
    !Number.isSafeInteger(options.recentTurnsToKeep ?? 32) ||
    (options.recentTurnsToKeep ?? 32) < 1 || (options.recentTurnsToKeep ?? 32) > 64 ||
    !Number.isSafeInteger(options.maxContextMessages ?? BOUNDED_MODEL_CONTEXT_LIMITS.maximumContextMessages) ||
    (options.maxContextMessages ?? BOUNDED_MODEL_CONTEXT_LIMITS.maximumContextMessages) < 1 ||
    (options.maxContextMessages ?? BOUNDED_MODEL_CONTEXT_LIMITS.maximumContextMessages) >
      BOUNDED_MODEL_CONTEXT_LIMITS.maximumContextMessages ||
    !Number.isSafeInteger(options.maxContextBytes ?? BOUNDED_MODEL_CONTEXT_LIMITS.maximumContextBytes) ||
    (options.maxContextBytes ?? BOUNDED_MODEL_CONTEXT_LIMITS.maximumContextBytes) < 1024 ||
    (options.maxContextBytes ?? BOUNDED_MODEL_CONTEXT_LIMITS.maximumContextBytes) >
      BOUNDED_MODEL_CONTEXT_LIMITS.maximumContextBytes ||
    options.workMode !== undefined &&
      options.workMode !== 'foreground' && options.workMode !== 'background' ||
    options.onCompactionContinuationNeeded !== undefined &&
      typeof options.onCompactionContinuationNeeded !== 'function' ||
    workBudget !== undefined && (
        workBudget === null ||
        typeof workBudget !== 'object' ||
        Reflect.ownKeys(workBudget).some(key => key !== 'maxProviderCalls' && key !== 'maxWorkPages') ||
        workBudget.maxProviderCalls !== undefined && (
            !Number.isSafeInteger(workBudget.maxProviderCalls) ||
            workBudget.maxProviderCalls < 1 ||
            workBudget.maxProviderCalls > BOUNDED_MODEL_CONTEXT_LIMITS.maximumProviderCallsPerSlice
          ) ||
        workBudget.maxWorkPages !== undefined && (
            !Number.isSafeInteger(workBudget.maxWorkPages) ||
            workBudget.maxWorkPages < 1 ||
            workBudget.maxWorkPages > BOUNDED_MODEL_CONTEXT_LIMITS.maximumWorkPagesPerSlice
          )
      )
  ) throw new BoundedModelContextError('CONTEXT_BUDGET_EXCEEDED');
}
