import { describe, expect, it, vi } from 'vitest';

import { PromptPreviewAuditError } from '../PromptPreviewAudit.js';
import { PromptPreviewController } from '../PromptPreviewController.js';
import type {
  PromptPreviewAuditDetailChunk,
  PromptPreviewAuditDetailRequest,
  PromptPreviewAuditPage,
  PromptPreviewAuditPageRequest,
  PromptPreviewClient,
  PromptPreviewPreparedExecution,
} from '../types.js';

function preparedExecution(sessionId = 'session.1', revision = 'revision.1'): PromptPreviewPreparedExecution {
  return {
    sessionId,
    revision,
    route: {
      providerId: 'provider',
      logicalModelId: 'logical-model',
      wireModelId: 'wire-model',
      apiMode: 'responses',
    },
    contextStats: { messageCount: 10_000, compactionSummaryCount: 3 },
    initialPage: {
      sessionId,
      revision,
      items: [{
        entryId: 'message.9999',
        entryIndex: 9_999,
        role: 'user',
        source: 'conversation-message',
        preview: 'recent bounded summary',
        canonicalBytes: 31,
      }],
      totalEntries: 10_000,
      previousCursor: 'p.previous',
      hasMoreBefore: true,
      hasMoreAfter: false,
      sampled: true,
    },
  };
}

function pageFor(request: PromptPreviewAuditPageRequest): PromptPreviewAuditPage {
  return {
    sessionId: request.sessionId,
    revision: request.expectedRevision,
    items: [],
    totalEntries: 10_000,
    previousCursor: 'p.previous',
    nextCursor: 'p.next',
    hasMoreBefore: true,
    hasMoreAfter: true,
    sampled: false,
  };
}

function detailFor(request: PromptPreviewAuditDetailRequest): PromptPreviewAuditDetailChunk {
  return {
    sessionId: request.sessionId,
    revision: request.expectedRevision,
    target: request.target,
    canonicalUtf8: new TextEncoder().encode('{"role":"user"}'),
    complete: true,
  };
}

function client(overrides: Partial<PromptPreviewClient> = {}): PromptPreviewClient {
  return {
    generatePreview: vi.fn(async () => ({
      flatPrompts: [{ role: 'system', content: 'bounded preview' }],
      processedPrompts: [{ id: 'bounded-node', role: 'system', text: 'bounded preview' }],
    })),
    getAuditPage: vi.fn(async request => pageFor(request)),
    getAuditDetail: vi.fn(async request => detailFor(request)),
    releaseAuditSession: vi.fn(),
    ...overrides,
  };
}

function prepare(execution = preparedExecution()) {
  return vi.fn(async () => execution);
}

describe('PromptPreviewController', () => {
  it('transfers only an opaque bounded audit descriptor, never exact messages or model request', async () => {
    const execution = preparedExecution();
    const previewClient = client();
    const prepareExecutionModelRequest = prepare(execution);
    const controller = new PromptPreviewController({ previewClient, prepareExecutionModelRequest });
    const config = { prompts: [], plugins: [] };

    const result = await controller.generate(config, 'conversation-long', 'continue');

    expect(prepareExecutionModelRequest).toHaveBeenCalledWith(
      'conversation-long',
      config,
      expect.objectContaining({ inputText: 'continue', signal: expect.any(AbortSignal) }),
    );
    expect(previewClient.generatePreview).toHaveBeenCalledWith(
      config,
      execution,
      expect.any(Function),
      { signal: expect.any(AbortSignal) },
    );
    expect(result).toEqual(expect.objectContaining({ audit: execution }));
    expect(result).not.toHaveProperty('modelRequest');
    expect(result).not.toHaveProperty('messages');
    expect(result).not.toHaveProperty('contextSegments');
  });

  it('supports isolated multiple views and releases its session on close', async () => {
    const previewClient = client();
    const controller = new PromptPreviewController({
      prepareExecutionModelRequest: prepare(),
      previewClient,
    });
    const first = vi.fn(() => {
      throw new Error('broken renderer');
    });
    const second = vi.fn();
    const unsubscribeFirst = controller.subscribe(first);
    const unsubscribeSecond = controller.subscribe(second);

    controller.open();
    await controller.generate({ prompts: [], plugins: [] }, 'conversation');
    expect(first).toHaveBeenCalled();
    expect(second).toHaveBeenCalled();

    unsubscribeFirst();
    controller.close();
    expect(previewClient.releaseAuditSession).toHaveBeenCalledWith({
      sessionId: 'session.1',
      expectedRevision: 'revision.1',
    });
    unsubscribeSecond();
  });

  it('emits stable localization codes and releases a superseded prepared session', async () => {
    let resolveFirst!: (execution: PromptPreviewPreparedExecution) => void;
    const first = new Promise<PromptPreviewPreparedExecution>(resolve => {
      resolveFirst = resolve;
    });
    const currentExecution = preparedExecution('session.current', 'revision.current');
    const prepareExecutionModelRequest = vi.fn()
      .mockReturnValueOnce(first)
      .mockResolvedValueOnce(currentExecution);
    const previewClient = client({
      generatePreview: vi.fn(async (_config, _execution, onProgress) => {
        onProgress?.({ progress: 0.5, stepCode: 'plugin', stepDisplay: 'dynamic plugin detail' });
        return { flatPrompts: [], processedPrompts: [] };
      }),
    });
    const controller = new PromptPreviewController({ prepareExecutionModelRequest, previewClient });
    const states: string[] = [];
    controller.subscribe(state => states.push(state.currentStep));

    const stale = controller.generate({ prompts: [], plugins: [] }, 'old');
    const current = controller.generate({ prompts: [], plugins: [] }, 'new');
    resolveFirst(preparedExecution('session.stale', 'revision.stale'));

    await expect(stale).resolves.toBeNull();
    await expect(current).resolves.toBeTruthy();
    expect(previewClient.releaseAuditSession).toHaveBeenCalledWith({
      sessionId: 'session.stale',
      expectedRevision: 'revision.stale',
    });
    expect(states).toContain('preparing');
    expect(states).toContain('plugin');
    expect(states.at(-1)).toBe('complete');
    expect(controller.getState().currentStepDisplay).toBeNull();
  });

  it('aborts host prompt generation and in-flight audit reads when the preview closes', async () => {
    let generationSignal: AbortSignal | undefined;
    let detailSignal: AbortSignal | undefined;
    const previewClient = client({
      generatePreview: vi.fn((_config, _execution, _progress, options) => {
        generationSignal = options.signal;
        return Promise.resolve({ flatPrompts: [], processedPrompts: [] });
      }),
      getAuditDetail: vi.fn((_request, options) => {
        detailSignal = options.signal;
        return new Promise<PromptPreviewAuditDetailChunk>((_resolve, reject) => {
          options.signal.addEventListener('abort', () => {
            reject(new Error('aborted'));
          }, { once: true });
        });
      }),
    });
    const controller = new PromptPreviewController({
      prepareExecutionModelRequest: prepare(),
      previewClient,
    });
    await controller.generate({ prompts: [], plugins: [] }, 'conversation-close');
    const pending = controller.getAuditDetail({
      sessionId: 'session.1',
      expectedRevision: 'revision.1',
      target: { kind: 'request' },
      maxBytes: 4_096,
    });
    await vi.waitFor(() => {
      expect(detailSignal).toBeDefined();
    });
    controller.close();

    expect(generationSignal?.aborted).toBe(true);
    expect(detailSignal?.aborted).toBe(true);
    await expect(pending).rejects.toBeTruthy();
  });

  it('loads correlated bounded pages/details and rejects stale or oversized host responses', async () => {
    const oversizedPage = pageFor({
      mode: 'around',
      sessionId: 'session.1',
      expectedRevision: 'revision.1',
      entryIndex: 1,
      limit: 1,
      maxBytes: 4_096,
    });
    oversizedPage.items = Array.from({ length: 2 }, (_, index) => ({
      entryId: `message.${index}`,
      entryIndex: index,
      role: 'user' as const,
      source: 'conversation-message' as const,
      preview: 'summary',
      canonicalBytes: 10,
    }));
    const previewClient = client();
    const controller = new PromptPreviewController({
      prepareExecutionModelRequest: prepare(),
      previewClient,
    });
    await controller.generate({ prompts: [], plugins: [] }, 'conversation');

    await expect(controller.getAuditPage({
      mode: 'around',
      sessionId: 'session.1',
      expectedRevision: 'wrong',
      entryIndex: 1,
      limit: 1,
      maxBytes: 4_096,
    })).rejects.toMatchObject({ code: 'stale_revision' });

    vi.mocked(previewClient.getAuditPage).mockResolvedValueOnce(oversizedPage);
    await expect(controller.getAuditPage({
      mode: 'around',
      sessionId: 'session.1',
      expectedRevision: 'revision.1',
      entryIndex: 1,
      limit: 1,
      maxBytes: 4_096,
    })).rejects.toBeInstanceOf(PromptPreviewAuditError);

    const detail = await controller.getAuditDetail({
      sessionId: 'session.1',
      expectedRevision: 'revision.1',
      target: { kind: 'request' },
      maxBytes: 4_096,
    });
    expect(new TextDecoder().decode(detail.canonicalUtf8)).toBe('{"role":"user"}');
  });
});
