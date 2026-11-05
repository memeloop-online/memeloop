import type { ConversationMessagePayload } from '../conversation/index.js';
import type { AgentFrameworkContext } from '../types.js';
import { appendLocalMessageEvent } from './agent-tool-loop/localMessageEvent.js';
import type { AgentLoopInput, AgentLoopStep } from './types.js';

export interface ScriptMessagePersistence {
  emit(step: AgentLoopStep): void;
  accept(step: AgentLoopStep): Promise<void>;
  nextChildRunId(): string;
  flush(): Promise<ScriptExecutionCursor>;
  restore(cursor: ScriptExecutionCursor): void;
}

export interface ScriptExecutionCursor {
  nextOutputSequence: number;
  nextChildSequence: number;
}

/** Checkpointed output and child-invocation sequences for one durable user turn. */
export function createScriptMessagePersistence(context: AgentFrameworkContext, input: AgentLoopInput): ScriptMessagePersistence {
  let nextOutputSequence = 0;
  let nextChildSequence = 0;
  let pending = Promise.resolve();
  const emittedWrites = new WeakMap<AgentLoopStep, Promise<void>[]>();

  function enqueue(step: AgentLoopStep): Promise<void> {
    if (step.type !== 'message') return pending;
    const payload = typeof step.data === 'string'
      ? { content: step.data }
      : step.data as (Partial<ConversationMessagePayload> & { type?: unknown }) | null;
    // Typed provider chunks are assembled and persisted by the model iteration.
    if (!payload || typeof payload.content !== 'string' || 'type' in payload) return pending;
    const content = payload.content;
    const turnId = input.persistedUserMessage!.turnId;
    const messageId = payload.messageId ?? `${turnId}:output:${nextOutputSequence}`;
    nextOutputSequence += 1;
    const write = pending.then(async () => {
      input.signal?.throwIfAborted();
      if (await context.storage.getMessageById?.(input.conversationId, messageId)) return;
      await appendLocalMessageEvent(context, {
        conversationId: input.conversationId,
        message: {
          ...payload,
          messageId,
          turnId,
          role: 'assistant',
          content,
          parts: payload.parts ?? [{ type: 'text', text: content }],
        },
      });
    });
    pending = write;
    // emit is synchronous. Its caller observes storage failures at the next
    // yielded step, checkpoint, or run completion.
    void write.catch(() => undefined);
    return write;
  }

  return {
    emit(step) {
      const writes = emittedWrites.get(step) ?? [];
      writes.push(enqueue(step));
      emittedWrites.set(step, writes);
    },
    accept(step) {
      const writes = emittedWrites.get(step);
      const emitted = writes?.shift();
      if (writes?.length === 0) emittedWrites.delete(step);
      return emitted ?? enqueue(step);
    },
    nextChildRunId() {
      return `${input.persistedUserMessage!.turnId}:child-run:${nextChildSequence++}`;
    },
    async flush() {
      const queued = pending;
      const cursor = { nextOutputSequence, nextChildSequence };
      await queued;
      return cursor;
    },
    restore(cursor) {
      nextOutputSequence = Math.max(nextOutputSequence, cursor.nextOutputSequence);
      nextChildSequence = Math.max(nextChildSequence, cursor.nextChildSequence);
    },
  };
}
