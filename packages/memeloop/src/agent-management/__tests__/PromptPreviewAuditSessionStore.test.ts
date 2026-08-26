import { describe, expect, it } from 'vitest';

import { canonicalJsonBytes } from '../../encoding/canonicalJson.js';
import type { PortableLlmMessage, PortableLlmRequest } from '../../llm/request.js';
import { assertPromptPreviewAuditDetailChunk, assertPromptPreviewAuditPage, PromptPreviewAuditError } from '../PromptPreviewAudit.js';
import { decodePromptPreviewAuditRequest, PromptPreviewAuditSessionStore } from '../PromptPreviewAuditSessionStore.js';

function ids() {
  let next = 0;
  return {
    createSessionId: () => `session.${++next}`,
    createRevision: () => `revision.${next}`,
  };
}

function request(messages: PortableLlmMessage[], signal?: AbortSignal): PortableLlmRequest {
  return {
    providerId: 'provider',
    modelId: 'wire-model',
    logicalModelId: 'logical-model',
    wireModelId: 'wire-model',
    apiMode: 'responses',
    messages,
    tools: [{
      name: 'search',
      description: 'search safely',
      inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
    }],
    toolChoice: 'auto',
    providerOptions: { provider: { reasoningEffort: 'high' } },
    stream: true,
    ...(signal === undefined ? {} : { signal }),
  };
}

function longMessages(count: number): PortableLlmMessage[] {
  return Array.from({ length: count }, (_, index): PortableLlmMessage =>
    index === 0
      ? { role: 'system', content: 'System rules' }
      : {
        role: index % 2 === 0 ? 'assistant' : 'user',
        content: `message ${index} ${'界'.repeat(80)}`,
      });
}

describe('PromptPreviewAuditSessionStore', () => {
  it('returns a sampled <=50-entry initial page with prompt/compaction markers and recent tail', () => {
    const store = new PromptPreviewAuditSessionStore(ids());
    const messages = longMessages(200);
    const sources = messages.map((_message, index) =>
      index === 0
        ? 'system' as const
        : index === 3
        ? 'prompt' as const
        : index === 70 || index === 120
        ? 'context-compaction-summary' as const
        : 'conversation-message' as const
    );

    const prepared = store.createSession({ request: request(messages), sources });

    expect(prepared).not.toHaveProperty('messages');
    expect(prepared).not.toHaveProperty('modelRequest');
    expect(prepared.contextStats).toEqual({ messageCount: 200, compactionSummaryCount: 2 });
    expect(prepared.initialPage.items).toHaveLength(50);
    expect(prepared.initialPage.sampled).toBe(true);
    expect(prepared.initialPage.items.map(item => item.source)).toEqual(expect.arrayContaining([
      'system',
      'prompt',
      'context-compaction-summary',
    ]));
    expect(prepared.initialPage.items.at(-1)?.entryIndex).toBe(199);
    expect(canonicalJsonBytes(prepared).byteLength).toBeLessThanOrEqual(256 * 1_024);
  });

  it('walks every hidden entry by opaque before cursors without count or byte-limit gaps', () => {
    const store = new PromptPreviewAuditSessionStore(ids());
    const prepared = store.createSession({ request: request(longMessages(173)) });
    const seen = new Set(prepared.initialPage.items.map(item => item.entryIndex));
    let cursor = prepared.initialPage.previousCursor;

    while (cursor !== undefined) {
      const page = store.getPage({
        mode: 'before',
        sessionId: prepared.sessionId,
        expectedRevision: prepared.revision,
        cursor,
        limit: 7,
        maxBytes: 4_096,
      });
      assertPromptPreviewAuditPage(page, { maxBytes: 4_096, maxEntries: 7 });
      for (const item of page.items) seen.add(item.entryIndex);
      cursor = page.previousCursor;
    }

    expect([...seen].sort((left, right) => left - right)).toEqual(
      Array.from({ length: 173 }, (_, index) => index),
    );
    const around = store.getPage({
      mode: 'around',
      sessionId: prepared.sessionId,
      expectedRevision: prepared.revision,
      entryIndex: 86,
      limit: 11,
      maxBytes: 4_096,
    });
    expect(around.items.some(item => item.entryIndex === 86)).toBe(true);
  });

  it('reassembles exact Unicode, tools, provider options, and Uint8Array files from bounded UTF-8 chunks', () => {
    const controller = new AbortController();
    const exact = request([
      { role: 'system', content: '规则：保留 🧠 Unicode' },
      {
        role: 'user',
        content: [
          { type: 'text', text: '请分析附件 🌏' },
          {
            type: 'file',
            mediaType: 'application/octet-stream',
            filename: 'sample.bin',
            data: { type: 'bytes', bytes: new Uint8Array([0, 1, 2, 127, 128, 255]) },
          },
        ],
      },
    ], controller.signal);
    const store = new PromptPreviewAuditSessionStore(ids());
    const prepared = store.createSession({ request: exact });
    const chunks: Uint8Array[] = [];
    let cursor: string | undefined;

    do {
      const detailRequest = {
        sessionId: prepared.sessionId,
        expectedRevision: prepared.revision,
        target: { kind: 'request' as const },
        ...(cursor === undefined ? {} : { cursor }),
        maxBytes: 31,
      };
      const chunk = store.getDetail(detailRequest);
      assertPromptPreviewAuditDetailChunk(chunk, detailRequest);
      expect(chunk.canonicalUtf8.byteLength).toBeLessThanOrEqual(31);
      expect(() => new TextDecoder('utf-8', { fatal: true }).decode(chunk.canonicalUtf8)).not.toThrow();
      chunks.push(chunk.canonicalUtf8);
      cursor = chunk.nextCursor;
    } while (cursor !== undefined);

    const reconstructed = decodePromptPreviewAuditRequest(concatenate(chunks));
    const expected = { ...exact };
    delete expected.signal;
    expect(reconstructed).toEqual(expected);
    const localSignal = new AbortController().signal;
    expect(store.getExactRequest(prepared.sessionId, prepared.revision, localSignal)).toEqual({
      ...expected,
      signal: localSignal,
    });
  });

  it('chunks one oversized Unicode entry at code-point boundaries and reassembles canonical JSON', () => {
    const message: PortableLlmMessage = {
      role: 'user',
      content: `前缀-${'🧪复杂 Unicode 内容'.repeat(5_000)}-后缀`,
    };
    const store = new PromptPreviewAuditSessionStore(ids());
    const prepared = store.createSession({ request: request([{ role: 'system', content: 's' }, message]) });
    const target = { kind: 'entry' as const, entryId: 'message.1', entryIndex: 1 };
    const chunks: Uint8Array[] = [];
    let cursor: string | undefined;

    do {
      const detailRequest = {
        sessionId: prepared.sessionId,
        expectedRevision: prepared.revision,
        target,
        ...(cursor === undefined ? {} : { cursor }),
        maxBytes: 257,
      };
      const chunk = store.getDetail(detailRequest);
      assertPromptPreviewAuditDetailChunk(chunk, detailRequest);
      chunks.push(chunk.canonicalUtf8);
      cursor = chunk.nextCursor;
    } while (cursor !== undefined);

    expect(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(concatenate(chunks)))).toEqual(message);
  });

  it('fails closed on foreign cursors/revisions and releases sessions idempotently', () => {
    const idFactory = ids();
    const store = new PromptPreviewAuditSessionStore({ ...idFactory, maxSessions: 1 });
    const prepared = store.createSession({ request: request(longMessages(60)) });

    expect(() => store.createSession({ request: request(longMessages(2)) })).toThrowError(
      expect.objectContaining({ code: 'capacity_exceeded' }),
    );
    expect(() =>
      store.getPage({
        mode: 'before',
        sessionId: prepared.sessionId,
        expectedRevision: prepared.revision,
        cursor: 'p.foreign',
        limit: 5,
        maxBytes: 4_096,
      })
    ).toThrowError(expect.objectContaining({ code: 'invalid_cursor' }));
    expect(() => store.getExactRequest(prepared.sessionId, 'revision.stale')).toThrowError(
      expect.objectContaining({ code: 'stale_revision' }),
    );
    expect(() => {
      store.release({
        sessionId: prepared.sessionId,
        expectedRevision: 'revision.stale',
      });
    }).toThrowError(PromptPreviewAuditError);
    store.release({ sessionId: prepared.sessionId, expectedRevision: prepared.revision });
    store.release({ sessionId: prepared.sessionId, expectedRevision: prepared.revision });
    expect(store.size).toBe(0);
  });
});

function concatenate(chunks: readonly Uint8Array[]): Uint8Array {
  const result = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}
