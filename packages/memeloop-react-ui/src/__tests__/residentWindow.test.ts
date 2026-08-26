import { type ChatMessage, projectConversationMessageForList } from 'memeloop';
import { describe, expect, it } from 'vitest';

import { boundMessageForDisplay, estimateMessageDisplayBytes, estimateMessageRenderRows, getDisplayTruncation, resolveDisplayTruncationAction } from '../chat/displayBounds.js';
import { boundedResidentMessages } from '../chat/residentWindow.js';
import { projectRuntimeMessageForDisplay } from '../chat/runtime/useMemeLoopRuntime.js';

const messages = Array.from({ length: 2_000 }, (_, index): ChatMessage => ({
  messageId: `m-${index}`,
  turnId: `m-${index - index % 2}`,
  conversationId: 'long',
  originNodeId: 'local',
  originSequence: index + 1,
  timestamp: index,
  lamportClock: index,
  role: index % 2 === 0 ? 'user' : 'assistant',
  content: `message ${index}`,
}));

describe('boundedResidentMessages', () => {
  it('defaults to a 50-message tail and clamps hostile UI limits', () => {
    expect(boundedResidentMessages(messages)).toHaveLength(50);
    expect(boundedResidentMessages(messages, 100_000)).toHaveLength(50);
    expect(boundedResidentMessages(messages)[0].messageId).toBe('m-1950');
  });

  it('keeps an old timeline anchor centered in the resident window', () => {
    const window = boundedResidentMessages(messages, 100, 'm-200');
    expect(window).toHaveLength(50);
    expect(window[25].messageId).toBe('m-200');
  });

  it('bounds resident work by both projected bytes and render rows', () => {
    const byteHeavy = messages.slice(0, 40).map(item => ({ ...item, content: 'x'.repeat(20_000) }));
    expect(boundedResidentMessages(byteHeavy, 200, undefined, 64 * 1024)).toHaveLength(3);

    const rowHeavy = messages.slice(0, 100).map(item => ({ ...item, content: Array.from({ length: 50 }, () => 'x').join('\n') }));
    const rowBounded = boundedResidentMessages(rowHeavy, 200, undefined, 8 * 1024 * 1024, 200);
    expect(rowBounded).toHaveLength(4);
    expect(rowBounded.reduce((total, item) => total + estimateMessageRenderRows(item), 0)).toBeLessThanOrEqual(200);

    const eightyLargeMessages = messages.slice(0, 80).map(item => ({ ...item, content: 'x'.repeat(128 * 1024) }));
    const hostileFourMiBWindow = boundedResidentMessages(eightyLargeMessages, 200, undefined, 4 * 1024 * 1024);
    expect(hostileFourMiBWindow.length).toBeLessThanOrEqual(2);
    expect(hostileFourMiBWindow.reduce((total, item) => total + estimateMessageDisplayBytes(item), 0)).toBeLessThanOrEqual(256 * 1024);
  });
});

describe('boundMessageForDisplay', () => {
  it('counts UTF-8 display bytes exactly for ASCII, CJK and surrogate pairs', () => {
    expect(estimateMessageDisplayBytes({ ...messages[0], content: 'a'.repeat(256) })).toBe(256);
    expect(estimateMessageDisplayBytes({ ...messages[0], content: '界'.repeat(256) })).toBe(768);
    expect(estimateMessageDisplayBytes({ ...messages[0], content: '😀'.repeat(256) })).toBe(1_024);
    expect(estimateMessageDisplayBytes({ ...messages[0], content: `${'a'.repeat(256 * 1024)}b` })).toBe(256 * 1024 + 1);
  });

  it('never invokes metadata accessors while estimating or bounding display state', () => {
    let getterCalls = 0;
    const metadata: Record<string, unknown> = {};
    Object.defineProperty(metadata, 'agentId', {
      enumerable: true,
      get() {
        getterCalls += 1;
        return 'secret';
      },
    });
    const source = { ...messages[0], metadata };
    expect(estimateMessageDisplayBytes(source)).toBeGreaterThan(256 * 1024);
    expect(boundMessageForDisplay(source).metadata?.agentId).toBeUndefined();
    expect(getterCalls).toBe(0);
  });

  it('bounds every large display field while preserving attachment and detail references', () => {
    const attachment = { contentHash: 'sha256:abc', filename: 'output.txt', mimeType: 'text/plain', size: 99 };
    const source: ChatMessage = {
      ...messages[0],
      content: `${'x'.repeat(1_023)}${'😀'.repeat(20_000)}`,
      reasoning_content: 'reasoning\n'.repeat(20_000),
      detailRef: { type: 'agent-run', runId: 'run-1' },
      attachments: [attachment],
      toolCalls: [{ id: 'call-1', toolName: 'shell', arguments: { command: 'x'.repeat(100_000) } }],
      parts: [
        { type: 'reasoning', text: 'private reasoning\n'.repeat(20_000) },
        { type: 'attachment', attachment },
        {
          type: 'tool-result',
          toolCallId: 'call-1',
          toolName: 'shell',
          result: 'tool output\n'.repeat(100_000),
          parameters: { command: 'x'.repeat(100_000) },
          payload: { stdout: 'x'.repeat(100_000) },
          detailRef: { type: 'agent-run', runId: 'run-1' },
        },
      ],
      metadata: {
        agentId: 'agent-1',
        secretUnboundedHostState: 'x'.repeat(100_000),
        wikiTiddlers: [{ workspaceName: 'Wiki', tiddlerTitle: 'Design', renderedContent: 'x'.repeat(10_000) }],
      },
    };

    const bounded = boundMessageForDisplay(source, 1_024, 80);
    const resultPart = bounded.parts?.find(part => part.type === 'tool-result');
    expect(resultPart?.type === 'tool-result' ? resultPart.result : '').toContain('omitted from display');
    expect(resultPart?.type === 'tool-result' ? resultPart.detailRef : undefined).toEqual({ type: 'agent-run', runId: 'run-1' });
    expect(bounded.attachments).toEqual([attachment]);
    expect(bounded.detailRef).toEqual(source.detailRef);
    expect(bounded.metadata?.agentId).toBe('agent-1');
    expect(bounded.metadata?.secretUnboundedHostState).toBeUndefined();
    expect(estimateMessageDisplayBytes(bounded)).toBeLessThan(100_000);
    expect(estimateMessageRenderRows(bounded)).toBeLessThan(200);
    expect(getDisplayTruncation(bounded)?.originalEstimatedBytes).toBeGreaterThan(256 * 1024);
    const finalCodeUnit = bounded.content.charCodeAt(bounded.content.length - 1);
    expect(finalCodeUnit < 0xD800 || finalCodeUnit > 0xDBFF).toBe(true);
  });

  it('consumes Core projection markers and chooses only an available bounded recovery action', () => {
    const projected = projectConversationMessageForList({
      ...messages[0],
      content: 'projected content',
      parts: [{ type: 'text', text: 'structured source' }],
    }, 8 * 1024);
    expect(getDisplayTruncation(projected)).toEqual(expect.objectContaining({
      truncated: true,
      capability: 'detail',
      omittedFields: ['parts'],
    }));
    expect(resolveDisplayTruncationAction(projected, { detail: true, export: true })).toBe('detail');
    expect(resolveDisplayTruncationAction(projected, { detail: false, export: true })).toBe('export');
    expect(resolveDisplayTruncationAction(projected, { detail: false, export: false })).toBeUndefined();

    const locallyBounded = boundMessageForDisplay({ ...messages[0], content: 'x'.repeat(100_000) }, 1_024, 80);
    expect(getDisplayTruncation(locallyBounded)?.capability).toBe('export');
    expect(resolveDisplayTruncationAction(locallyBounded, { detail: true, export: true })).toBe('export');
  });

  it('short-circuits million-item, deeply nested and cyclic payload estimation', () => {
    const dense = Array.from({ length: 1_000_000 }, (_, index) => index);
    const sparse: unknown[] = [];
    sparse.length = 1_000_000;
    sparse[999_999] = 'tail';
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    let deep: Record<string, unknown> = {};
    const deepRoot = deep;
    for (let index = 0; index < 10_000; index += 1) {
      const next: Record<string, unknown> = {};
      deep.next = next;
      deep = next;
    }
    const source: ChatMessage = {
      ...messages[0],
      content: 'large payload',
      parts: [{
        type: 'tool-result',
        toolName: 'stress',
        result: 'ok',
        payload: { dense, sparse, cyclic, deepRoot },
      }],
      metadata: { toolParameters: dense, ignoredHugeMetadata: sparse },
    };

    const started = performance.now();
    expect(() => boundMessageForDisplay(source)).not.toThrow();
    expect(performance.now() - started).toBeLessThan(1_000);
  });

  it('bounds raw parts before structured projection can visit omitted entries', () => {
    const parts = Array.from({ length: 128 }, () => ({ type: 'text' as const, text: 'safe' }));
    Object.defineProperty(parts, 128, {
      configurable: true,
      get() {
        throw new Error('unbounded projection reached omitted content');
      },
    });
    parts.length = 129;
    const source: ChatMessage = { ...messages[0], content: 'fallback', parts };

    expect(() => projectRuntimeMessageForDisplay(source)).not.toThrow();
    expect(projectRuntimeMessageForDisplay(source).parts).toHaveLength(128);
  });
});
