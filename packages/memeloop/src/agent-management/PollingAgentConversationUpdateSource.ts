import type { AgentConversationUpdate } from './types.js';
import { MAX_AGENT_CONVERSATION_APPENDED_MESSAGE_COUNT } from './types.js';

const DEFAULT_POLL_INTERVAL_MS = 2_000;
const MAX_BACKOFF_MULTIPLIER = 32;

export interface AgentConversationHead {
  revision: string;
  totalMessages: number;
}

export interface ReadAgentConversationHeadInput {
  conversationId: string;
  signal: AbortSignal;
}

export type AgentConversationInvalidation = Extract<
  AgentConversationUpdate,
  { kind: 'invalidated' }
>;

export interface PollingAgentConversationUpdateSchedule {
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface PollingAgentConversationUpdateSourceOptions {
  readHead(input: ReadAgentConversationHeadInput): Promise<AgentConversationHead>;
  subscribeInvalidations?(
    conversationId: string,
    listener: (update: AgentConversationInvalidation) => void,
  ): () => void;
  pollIntervalMs?: number;
  schedule?: PollingAgentConversationUpdateSchedule;
  /** Maps the backoff-adjusted interval to a host-controlled jittered delay. */
  jitter?: (intervalMs: number) => number;
}

interface PollingGeneration {
  generation: number;
  conversationId: string;
  listener: (update: AgentConversationUpdate) => void;
  abortController: AbortController;
  unsubscribeInvalidations?: () => void;
  timer?: unknown;
  head?: AgentConversationHead;
  readInFlight: boolean;
  refreshQueued: boolean;
  invalidationSequence: number;
  consecutiveFailures: number;
}

const systemSchedule: PollingAgentConversationUpdateSchedule = {
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: handle => {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
};

/**
 * Turns a bounded revision/total head read into AgentConversationUpdate events.
 *
 * The source never reads or retains messages. The first successful read only
 * establishes a baseline. Precise push invalidations are forwarded immediately
 * and force a fresh baseline, while polling remains a lossy-source fallback.
 */
export class PollingAgentConversationUpdateSource {
  private readonly pollIntervalMs: number;
  private readonly schedule: PollingAgentConversationUpdateSchedule;
  private readonly jitter: (intervalMs: number) => number;
  private generation = 0;
  private active?: PollingGeneration;
  private disposed = false;

  public constructor(private readonly options: PollingAgentConversationUpdateSourceOptions) {
    if (!options || typeof options.readHead !== 'function') {
      throw new Error('invalid_agent_conversation_head_reader');
    }
    const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    if (!Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 10) {
      throw new Error('invalid_agent_conversation_poll_interval');
    }
    this.pollIntervalMs = pollIntervalMs;
    this.schedule = options.schedule ?? systemSchedule;
    this.jitter = options.jitter ?? (intervalMs => intervalMs);
  }

  /**
   * Starts the one active observation generation. A later subscription aborts
   * and unsubscribes the previous conversation (latest-wins).
   */
  public subscribe(
    conversationId: string,
    listener: (update: AgentConversationUpdate) => void,
  ): () => void {
    if (this.disposed) throw new Error('agent_conversation_update_source_disposed');
    this.assertOpaqueText(conversationId, 'conversation_id');
    if (typeof listener !== 'function') throw new Error('invalid_agent_conversation_update_listener');
    this.clearActive();
    const context: PollingGeneration = {
      generation: ++this.generation,
      conversationId,
      listener,
      abortController: new AbortController(),
      readInFlight: false,
      refreshQueued: false,
      invalidationSequence: 0,
      consecutiveFailures: 0,
    };
    this.active = context;
    this.subscribePreciseInvalidations(context);
    void this.read(context);
    return () => {
      if (this.active === context) {
        this.clearActive();
        this.generation += 1;
      }
    };
  }

  /**
   * Content-free host wake-up for sync/storage notifications. With an ID it
   * probes only the matching active conversation; without one it probes the
   * current subscription. Bursts coalesce through the existing timer/read
   * fence and never require a host to forge revision edges.
   */
  public wake(conversationId?: string): void {
    if (this.disposed) return;
    if (conversationId !== undefined) {
      this.assertOpaqueText(conversationId, 'conversation_id');
    }
    const context = this.active;
    if (!context || (conversationId !== undefined && conversationId !== context.conversationId)) {
      return;
    }
    this.queueRefresh(context);
  }

  public dispose(): void {
    if (this.disposed) return;
    this.clearActive();
    this.generation += 1;
    this.disposed = true;
  }

  private subscribePreciseInvalidations(context: PollingGeneration): void {
    if (!this.options.subscribeInvalidations) return;
    try {
      const unsubscribe = this.options.subscribeInvalidations(
        context.conversationId,
        update => {
          if (!this.isCurrent(context)) return;
          try {
            this.assertInvalidation(update, context.conversationId);
          } catch {
            this.queueRefresh(context);
            return;
          }
          context.invalidationSequence += 1;
          context.head = undefined;
          this.emit(context, update);
          this.queueRefresh(context);
        },
      );
      if (!this.isCurrent(context)) {
        this.safeUnsubscribe(unsubscribe);
        return;
      }
      context.unsubscribeInvalidations = unsubscribe;
    } catch {
      // Polling is the fail-safe when a push source cannot be established.
    }
  }

  private async read(context: PollingGeneration): Promise<void> {
    if (!this.isCurrent(context)) return;
    if (context.readInFlight) {
      context.refreshQueued = true;
      return;
    }
    this.clearTimer(context);
    context.readInFlight = true;
    const invalidationSequence = context.invalidationSequence;
    try {
      const rawHead = await this.options.readHead({
        conversationId: context.conversationId,
        signal: context.abortController.signal,
      });
      if (!this.isCurrent(context)) return;
      const head = this.validateHead(rawHead);
      if (invalidationSequence !== context.invalidationSequence) {
        context.refreshQueued = true;
        return;
      }
      const previous = context.head;
      context.head = head;
      context.consecutiveFailures = 0;
      if (previous && previous.revision !== head.revision) {
        const delta = head.totalMessages - previous.totalMessages;
        const update: AgentConversationInvalidation = delta > 0 && delta <= MAX_AGENT_CONVERSATION_APPENDED_MESSAGE_COUNT
          ? {
            kind: 'invalidated',
            conversationId: context.conversationId,
            previousRevision: previous.revision,
            revision: head.revision,
            reason: 'append',
            appendedMessageCount: delta,
          }
          : {
            kind: 'invalidated',
            conversationId: context.conversationId,
            previousRevision: previous.revision,
            revision: head.revision,
            reason: 'reset',
          };
        this.emit(context, update);
      } else if (previous && previous.totalMessages !== head.totalMessages) {
        // A conforming revision identifies the total. Re-baseline instead of
        // forging an invalidation whose previous/current revisions are equal.
        context.head = undefined;
        context.refreshQueued = true;
      }
    } catch {
      if (!this.isCurrent(context)) return;
      context.consecutiveFailures = Math.min(
        context.consecutiveFailures + 1,
        Math.log2(MAX_BACKOFF_MULTIPLIER),
      );
    } finally {
      context.readInFlight = false;
      if (this.isCurrent(context)) {
        if (context.refreshQueued) {
          context.refreshQueued = false;
          this.setTimer(context, 0);
        } else {
          const multiplier = 2 ** context.consecutiveFailures;
          this.setTimer(context, this.jitterDelay(this.pollIntervalMs * multiplier));
        }
      }
    }
  }

  private queueRefresh(context: PollingGeneration): void {
    if (!this.isCurrent(context)) return;
    if (context.readInFlight) {
      context.refreshQueued = true;
      return;
    }
    this.setTimer(context, 0);
  }

  private setTimer(context: PollingGeneration, delayMs: number): void {
    if (!this.isCurrent(context)) return;
    this.clearTimer(context);
    context.timer = this.schedule.setTimeout(() => {
      context.timer = undefined;
      void this.read(context);
    }, delayMs);
  }

  private jitterDelay(intervalMs: number): number {
    let delay: number;
    try {
      delay = this.jitter(intervalMs);
    } catch {
      return intervalMs;
    }
    if (!Number.isSafeInteger(delay) || delay < 0) {
      return intervalMs;
    }
    return delay;
  }

  private emit(context: PollingGeneration, update: AgentConversationUpdate): void {
    if (!this.isCurrent(context)) return;
    try {
      context.listener(update);
    } catch {
      // A host listener cannot break polling, cancellation or cleanup.
    }
  }

  private validateHead(head: AgentConversationHead): AgentConversationHead {
    if (!head || typeof head !== 'object') throw new Error('invalid_agent_conversation_head');
    this.assertOpaqueText(head.revision, 'head_revision');
    if (!Number.isSafeInteger(head.totalMessages) || head.totalMessages < 0) {
      throw new Error('invalid_agent_conversation_head_total');
    }
    return { revision: head.revision, totalMessages: head.totalMessages };
  }

  private assertInvalidation(
    update: AgentConversationInvalidation,
    conversationId: string,
  ): void {
    if (!update || update.kind !== 'invalidated' || update.conversationId !== conversationId) {
      throw new Error('invalid_agent_conversation_invalidation_scope');
    }
    this.assertOpaqueText(update.previousRevision, 'previous_revision');
    this.assertOpaqueText(update.revision, 'revision');
    if (update.previousRevision === update.revision) {
      throw new Error('invalid_agent_conversation_invalidation_revision');
    }
    if (
      update.reason === 'append' && (
        !Number.isSafeInteger(update.appendedMessageCount) ||
        update.appendedMessageCount < 1 ||
        update.appendedMessageCount > MAX_AGENT_CONVERSATION_APPENDED_MESSAGE_COUNT
      )
    ) throw new Error('invalid_agent_conversation_invalidation_delta');
  }

  private clearActive(): void {
    const context = this.active;
    this.active = undefined;
    if (!context) return;
    context.abortController.abort();
    this.clearTimer(context);
    const unsubscribe = context.unsubscribeInvalidations;
    context.unsubscribeInvalidations = undefined;
    this.safeUnsubscribe(unsubscribe);
  }

  private clearTimer(context: PollingGeneration): void {
    if (context.timer === undefined) return;
    this.schedule.clearTimeout(context.timer);
    context.timer = undefined;
  }

  private safeUnsubscribe(unsubscribe: (() => void) | undefined): void {
    try {
      unsubscribe?.();
    } catch {
      // Abort/generation fences remain authoritative.
    }
  }

  private isCurrent(context: PollingGeneration): boolean {
    return this.active === context &&
      this.generation === context.generation &&
      !context.abortController.signal.aborted &&
      !this.disposed;
  }

  private assertOpaqueText(value: unknown, field: string): asserts value is string {
    if (
      typeof value !== 'string' || value.length === 0 || value.length > 2_048 ||
      value !== value.trim() || this.hasControlCharacters(value)
    ) throw new Error(`invalid_agent_conversation_${field}`);
  }

  private hasControlCharacters(value: string): boolean {
    for (let index = 0; index < value.length; index += 1) {
      const code = value.charCodeAt(index);
      if (code <= 31 || code === 127) return true;
    }
    return false;
  }
}
