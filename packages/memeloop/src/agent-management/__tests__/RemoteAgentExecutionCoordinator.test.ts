import { describe, expect, it, vi } from 'vitest';

import { AGENT_USER_MESSAGE_LIMITS } from '../../userMessageAdmission.js';
import {
  type RemoteAgentExecuteRequest,
  RemoteAgentExecutionCoordinator,
  type RemoteAgentExecutionCoordinatorOptions,
  RemoteAgentExecutionError,
  type RemoteAgentExecutionProvenance,
} from '../RemoteAgentExecutionCoordinator.js';
import type { AgentAttachmentInput } from '../types.js';

const provenance = (suffix = '1'): RemoteAgentExecutionProvenance => ({
  conversationId: `conversation-${suffix}`,
  definitionId: 'definition-1',
  turnId: `turn-${suffix}`,
  requestId: `request-${suffix}`,
});

function ports(overrides: Partial<RemoteAgentExecutionCoordinatorOptions> = {}) {
  const defaults: RemoteAgentExecutionCoordinatorOptions = {
    localPeerId: 'peer-local',
    executeLocal: vi.fn().mockResolvedValue({ runId: 'local-run' }),
    executeRemote: vi.fn().mockResolvedValue({ runId: 'remote-run' }),
    cancelLocal: vi.fn().mockResolvedValue(undefined),
    cancelRemote: vi.fn().mockResolvedValue(undefined),
    retryLocal: vi.fn().mockResolvedValue({ runId: 'local-retry' }),
    retryRemote: vi.fn().mockResolvedValue({ runId: 'remote-retry' }),
    deleteLocal: vi.fn().mockResolvedValue({ ok: true }),
    deleteRemote: vi.fn().mockResolvedValue({ ok: true }),
    syncConversation: vi.fn().mockResolvedValue(undefined),
    now: vi.fn(() => 100),
    createId: vi.fn()
      .mockReturnValueOnce('generated-turn')
      .mockReturnValueOnce('generated-request'),
  };
  return { ...defaults, ...overrides };
}

function deferred<Result>() {
  let resolve!: (result: Result) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<Result>((resolve_, reject_) => {
    resolve = resolve_;
    reject = reject_;
  });
  return { promise, reject, resolve };
}

describe('RemoteAgentExecutionCoordinator', () => {
  it('routes local and remote execution exactly once and syncs only successful remote work', async () => {
    const injected = ports();
    const coordinator = new RemoteAgentExecutionCoordinator(injected);

    await expect(coordinator.execute({
      target: { kind: 'local' },
      provenance: provenance('local'),
      message: 'local',
    })).resolves.toEqual({ runId: 'local-run', synchronization: 'not-required' });
    await expect(coordinator.execute({
      target: { kind: 'remote', peerId: 'peer-remote' },
      provenance: provenance('remote'),
      message: 'remote',
    })).resolves.toEqual({ runId: 'remote-run', synchronization: 'synchronized' });

    expect(injected.executeLocal).toHaveBeenCalledTimes(1);
    expect(injected.executeRemote).toHaveBeenCalledTimes(1);
    expect(injected.syncConversation).toHaveBeenCalledTimes(1);
    expect(injected.syncConversation).toHaveBeenCalledWith(
      'peer-remote',
      'conversation-remote',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(coordinator.getSnapshot('conversation-remote')).toMatchObject({
      status: 'succeeded',
      executionPeerId: 'peer-remote',
      provenance: provenance('remote'),
    });
  });

  it('serializes operations for the same conversation without blocking another conversation', async () => {
    const first = deferred<{ runId: string }>();
    const starts: string[] = [];
    const injected = ports({
      executeLocal: vi.fn(async request => {
        starts.push(request.provenance.turnId);
        return request.provenance.turnId === 'turn-1' ? first.promise : { runId: 'second' };
      }),
    });
    const coordinator = new RemoteAgentExecutionCoordinator(injected);
    const request1 = coordinator.execute({ target: { kind: 'local' }, provenance: provenance(), message: 'one' });
    const request2 = coordinator.execute({
      target: { kind: 'local' },
      provenance: { ...provenance(), turnId: 'turn-2', requestId: 'request-2' },
      message: 'two',
    });
    const other = coordinator.execute({ target: { kind: 'local' }, provenance: provenance('other'), message: 'other' });
    await expect(other).resolves.toEqual({ runId: 'second', synchronization: 'not-required' });
    expect(starts).toEqual(['turn-1', 'turn-other']);
    first.resolve({ runId: 'first' });
    await expect(request1).resolves.toEqual({ runId: 'first', synchronization: 'not-required' });
    await expect(request2).resolves.toEqual({ runId: 'second', synchronization: 'not-required' });
    expect(starts).toEqual(['turn-1', 'turn-other', 'turn-2']);
  });

  it('does not sync failed remote work and publishes a typed port failure', async () => {
    const injected = ports({ executeRemote: vi.fn().mockRejectedValue(new Error('secret upstream body')) });
    const coordinator = new RemoteAgentExecutionCoordinator(injected);

    await expect(coordinator.execute({
      target: { kind: 'remote', peerId: 'peer-remote' },
      provenance: provenance(),
      message: 'run',
    })).rejects.toMatchObject({ code: 'PORT_FAILURE', retryable: true });
    expect(injected.syncConversation).not.toHaveBeenCalled();
    expect(coordinator.getSnapshot('conversation-1')).toMatchObject({
      status: 'failed',
      error: { code: 'PORT_FAILURE' },
    });
    expect(coordinator.getSnapshot('conversation-1').error?.message).not.toContain('secret');
  });

  it('reports post-success sync degradation without making execution retryable', async () => {
    const injected = ports({ syncConversation: vi.fn().mockRejectedValue(new Error('offline')) });
    const coordinator = new RemoteAgentExecutionCoordinator(injected);

    await expect(coordinator.execute({
      target: { kind: 'remote', peerId: 'peer-remote' },
      provenance: provenance(),
      message: 'run',
    })).resolves.toEqual({ runId: 'remote-run', synchronization: 'degraded' });
    expect(injected.executeRemote).toHaveBeenCalledTimes(1);
    expect(coordinator.getSnapshot('conversation-1')).toMatchObject({
      status: 'degraded',
      synchronization: 'degraded',
      error: { code: 'SYNC_FAILED' },
    });
  });

  it('deduplicates retry by requestId and rejects payload drift fail-closed', async () => {
    const injected = ports();
    const coordinator = new RemoteAgentExecutionCoordinator(injected);
    const request = {
      target: { kind: 'remote', peerId: 'peer-remote' } as const,
      provenance: provenance(),
      sourceTurnId: 'old-turn',
    };

    const [first, replay] = await Promise.all([coordinator.retry(request), coordinator.retry(request)]);
    expect(first).toEqual({ runId: 'remote-retry', synchronization: 'synchronized' });
    expect(replay).toEqual(first);
    await expect(coordinator.retry(request)).resolves.toEqual(first);
    expect(injected.retryRemote).toHaveBeenCalledTimes(1);
    expect(injected.syncConversation).toHaveBeenCalledTimes(1);

    await expect(coordinator.retry({ ...request, sourceTurnId: 'different-old-turn' }))
      .rejects.toMatchObject({ code: 'REQUEST_ID_CONFLICT', retryable: false });
    expect(injected.retryRemote).toHaveBeenCalledTimes(1);
  });

  it('fences stale completion when the target switches', async () => {
    const execution = deferred<{ runId: string }>();
    const coordinator = new RemoteAgentExecutionCoordinator(ports({
      executeLocal: vi.fn(() => execution.promise),
    }));
    const seen: string[] = [];
    coordinator.subscribe(snapshot => seen.push(`${snapshot.status}:${snapshot.executionPeerId ?? ''}`));
    const pending = coordinator.execute({ target: { kind: 'local' }, provenance: provenance(), message: 'run' });
    await vi.waitFor(() => {
      expect(seen).toContain('running:peer-local');
    });

    coordinator.switchTarget('conversation-1', { kind: 'remote', peerId: 'peer-new' });
    execution.resolve({ runId: 'stale-run' });
    await expect(pending).rejects.toMatchObject({ code: 'STALE_OPERATION' });
    expect(coordinator.getSnapshot('conversation-1')).toMatchObject({
      status: 'idle',
      generation: 1,
      executionPeerId: 'peer-new',
    });
    expect(seen.at(-1)).toBe('idle:peer-new');
  });

  it('cancels the selected local or remote port and stale work cannot publish afterward', async () => {
    const execution = deferred<{ runId: string }>();
    const injected = ports({ executeRemote: vi.fn(() => execution.promise) });
    const coordinator = new RemoteAgentExecutionCoordinator(injected);
    const request = {
      target: { kind: 'remote', peerId: 'peer-remote' } as const,
      provenance: provenance(),
      message: 'run',
    };
    const pending = coordinator.execute(request);
    await vi.waitFor(() => {
      expect(injected.executeRemote).toHaveBeenCalledTimes(1);
    });
    await coordinator.cancel({ target: request.target, provenance: request.provenance });
    expect(injected.cancelRemote).toHaveBeenCalledTimes(1);
    expect(injected.cancelLocal).not.toHaveBeenCalled();
    execution.resolve({ runId: 'late' });
    await expect(pending).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(coordinator.getSnapshot('conversation-1').status).toBe('cancelled');
  });

  it('routes retry/delete uniquely and synchronizes successful remote mutations', async () => {
    const injected = ports();
    const coordinator = new RemoteAgentExecutionCoordinator(injected);
    await coordinator.retry({
      target: { kind: 'local' },
      provenance: { ...provenance('retry-local'), turnId: 'new-local' },
      sourceTurnId: 'old-local',
    });
    await coordinator.delete({
      target: { kind: 'remote', peerId: 'peer-delete' },
      provenance: provenance('delete'),
    });
    expect(injected.retryLocal).toHaveBeenCalledTimes(1);
    expect(injected.retryRemote).not.toHaveBeenCalled();
    expect(injected.deleteRemote).toHaveBeenCalledTimes(1);
    expect(injected.deleteLocal).not.toHaveBeenCalled();
    expect(injected.syncConversation).toHaveBeenCalledTimes(1);
  });

  it('generates explicit provenance and validates remote PeerIds before dispatch', async () => {
    const coordinator = new RemoteAgentExecutionCoordinator(ports());
    expect(coordinator.prepareProvenance({
      conversationId: 'conversation',
      definitionId: 'definition',
    })).toEqual({
      conversationId: 'conversation',
      definitionId: 'definition',
      turnId: 'generated-turn',
      requestId: 'generated-request',
    });
    expect(() =>
      coordinator.execute({
        target: { kind: 'remote', peerId: ' bad-peer ' },
        provenance: provenance(),
        message: 'run',
      })
    ).toThrowError(expect.objectContaining({ code: 'INVALID_TARGET' }));
  });

  it('dispose aborts active work, detaches listeners, clears queues, and is idempotent', async () => {
    let aborted = false;
    const listener = vi.fn();
    const executeLocal = vi.fn((_request, options) =>
      new Promise<{ runId: string }>((_resolve, reject) => {
        options.signal.addEventListener('abort', () => {
          aborted = true;
          const reason: Error = options.signal.reason instanceof Error
            ? options.signal.reason as Error
            : new Error('aborted');
          reject(reason);
        }, { once: true });
      })
    );
    const coordinator = new RemoteAgentExecutionCoordinator(ports({ executeLocal }));
    coordinator.subscribe(listener);
    const pending = coordinator.execute({ target: { kind: 'local' }, provenance: provenance(), message: 'run' });
    await vi.waitFor(() => {
      expect(executeLocal).toHaveBeenCalledTimes(1);
    });
    const disposal = coordinator.dispose();
    await expect(pending).rejects.toMatchObject({ code: 'DISPOSED' });
    await disposal;
    await coordinator.dispose();
    expect(aborted).toBe(true);
    expect(coordinator.getSnapshot('conversation-1').status).toBe('disposed');
    expect(() => coordinator.subscribe(vi.fn())).toThrowError(RemoteAgentExecutionError);
  });

  it('isolates a throwing listener and reports it without skipping later listeners', async () => {
    const listenerError = vi.fn();
    const later = vi.fn();
    const coordinator = new RemoteAgentExecutionCoordinator(ports({ onListenerError: listenerError }));
    coordinator.subscribe(() => {
      throw new Error('listener failed');
    });
    coordinator.subscribe(later);

    await expect(coordinator.execute({
      target: { kind: 'local' },
      provenance: provenance(),
      message: 'run',
    })).resolves.toMatchObject({ runId: 'local-run' });
    expect(listenerError).toHaveBeenCalled();
    expect(later).toHaveBeenCalled();
    expect(coordinator.getSnapshot('conversation-1').status).toBe('succeeded');
  });

  it('bounds retained conversation state and only evicts inactive LRU entries', async () => {
    const active = deferred<{ runId: string }>();
    const executeLocal = vi.fn(request =>
      request.provenance.conversationId === 'conversation-active'
        ? active.promise
        : Promise.resolve({ runId: request.provenance.conversationId })
    );
    const coordinator = new RemoteAgentExecutionCoordinator(ports({
      executeLocal,
      maxRetainedConversations: 2,
    }));
    await coordinator.execute({ target: { kind: 'local' }, provenance: provenance('old'), message: 'old' });
    const pending = coordinator.execute({ target: { kind: 'local' }, provenance: provenance('active'), message: 'active' });
    await vi.waitFor(() => {
      expect(executeLocal).toHaveBeenCalledTimes(2);
    });
    await coordinator.execute({ target: { kind: 'local' }, provenance: provenance('new'), message: 'new' });
    expect(coordinator.getSnapshot('conversation-old').status).toBe('idle');
    expect(coordinator.getSnapshot('conversation-active').status).toBe('running');
    active.resolve({ runId: 'active' });
    await pending;
  });

  it('evicts the least-recently-used completed retry key but never a pending key', async () => {
    const retry = deferred<{ runId: string }>();
    const retryLocal = vi.fn(request =>
      request.provenance.conversationId === 'conversation-pending'
        ? retry.promise
        : Promise.resolve({ runId: request.provenance.conversationId })
    );
    const injected = ports({ maxRetryLedgerEntries: 2, retryLocal });
    const coordinator = new RemoteAgentExecutionCoordinator(injected);
    const first = {
      target: { kind: 'local' },
      provenance: provenance('one'),
      sourceTurnId: 'old-one',
    } as const;
    const second = {
      target: { kind: 'local' },
      provenance: provenance('two'),
      sourceTurnId: 'old-two',
    } as const;
    await coordinator.retry(first);
    await coordinator.retry(second);
    await coordinator.retry(second); // touch B, so A is now the LRU entry
    await coordinator.retry({
      target: { kind: 'local' },
      provenance: provenance('three'),
      sourceTurnId: 'old-three',
    });
    await coordinator.retry({ ...first, sourceTurnId: 'changed-after-eviction' });
    expect(retryLocal).toHaveBeenCalledTimes(4);

    const pendingCoordinator = new RemoteAgentExecutionCoordinator(ports({
      maxRetryLedgerEntries: 1,
      retryLocal: vi.fn(() => retry.promise),
    }));
    const pending = pendingCoordinator.retry({
      target: { kind: 'local' },
      provenance: provenance('pending'),
      sourceTurnId: 'old-pending',
    });
    expect(() =>
      pendingCoordinator.retry({
        target: { kind: 'local' },
        provenance: provenance('overflow'),
        sourceTurnId: 'old-overflow',
      })
    ).toThrowError(expect.objectContaining({ code: 'CAPACITY_EXCEEDED' }));
    await vi.waitFor(() => {
      expect(pendingCoordinator.getSnapshot('conversation-pending').status).toBe('running');
    });
    pendingCoordinator.stopConversation('conversation-pending');
    retry.resolve({ runId: 'pending-run' });
    await expect(pending).rejects.toMatchObject({ code: 'CANCELLED' });
    await expect(pendingCoordinator.retry({
      target: { kind: 'local' },
      provenance: provenance('overflow'),
      sourceTurnId: 'old-overflow',
    })).resolves.toMatchObject({ runId: 'pending-run' });
  });

  it('disposes promptly when a faulty host ignores AbortSignal and fences its late result', async () => {
    const ignored = deferred<{ runId: string }>();
    const listener = vi.fn();
    const executeLocal = vi.fn(() => ignored.promise);
    const coordinator = new RemoteAgentExecutionCoordinator(ports({
      executeLocal,
    }));
    coordinator.subscribe(listener);
    const pending = coordinator.execute({ target: { kind: 'local' }, provenance: provenance(), message: 'run' });
    const queued = coordinator.execute({
      target: { kind: 'local' },
      provenance: { ...provenance(), requestId: 'request-queued', turnId: 'turn-queued' },
      message: 'queued',
    });
    await vi.waitFor(() => {
      expect(listener).toHaveBeenCalledWith(expect.objectContaining({ status: 'running' }));
    });
    await expect(coordinator.dispose()).resolves.toBeUndefined();
    const callsAfterDispose = listener.mock.calls.length;
    ignored.resolve({ runId: 'late' });
    await expect(pending).rejects.toMatchObject({ code: 'DISPOSED' });
    await expect(queued).rejects.toMatchObject({ code: 'DISPOSED' });
    expect(executeLocal).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledTimes(callsAfterDispose);
  });

  it('passes immutable attachment and wiki descriptors through local and remote ports exactly', async () => {
    const local = vi.fn().mockResolvedValue({ runId: 'local' });
    const remote = vi.fn().mockResolvedValue({ runId: 'remote' });
    const coordinator = new RemoteAgentExecutionCoordinator(ports({
      executeLocal: local,
      executeRemote: remote,
    }));
    const readChunk = vi.fn().mockResolvedValue(new Uint8Array([1]));
    const attachment: AgentAttachmentInput = {
      kind: 'source',
      filename: 'before.txt',
      mimeType: 'text/plain',
      totalBytes: 1,
      readChunk,
    };
    const wikiTiddlers = [{ workspaceName: 'before-workspace', tiddlerTitle: 'Before title' }];
    const localPromise = coordinator.execute({
      target: { kind: 'local' },
      provenance: provenance('attachment-local'),
      message: 'local',
      attachment,
      wikiTiddlers,
    });
    if (attachment.kind !== 'source') throw new Error('expected source');
    attachment.filename = 'after.txt';
    wikiTiddlers[0].workspaceName = 'after-workspace';
    await localPromise;
    const localRequest = local.mock.calls[0][0];
    expect(localRequest.attachment).toMatchObject({ filename: 'before.txt', readChunk });
    expect(localRequest.wikiTiddlers).toEqual([
      { workspaceName: 'before-workspace', tiddlerTitle: 'Before title' },
    ]);
    expect(Object.isFrozen(localRequest.attachment)).toBe(true);
    expect(Object.isFrozen(localRequest.wikiTiddlers)).toBe(true);
    expect(Object.isFrozen(localRequest.wikiTiddlers[0])).toBe(true);
    expect(readChunk).not.toHaveBeenCalled();

    const committed: AgentAttachmentInput = {
      kind: 'committed',
      reference: {
        contentHash: `sha256:${'b'.repeat(64)}`,
        filename: 'remote.png',
        mimeType: 'image/png',
        size: 12,
      },
    };
    await coordinator.execute({
      target: { kind: 'remote', peerId: 'peer-remote' },
      provenance: provenance('attachment-remote'),
      message: 'remote',
      attachment: committed,
    });
    expect(remote.mock.calls[0][0].attachment).toEqual(committed);
    expect(remote.mock.calls[0][0].attachment).not.toBe(committed);
  });

  it('preserves the legacy request shape when no attachment input is supplied', async () => {
    const executeLocal = vi.fn().mockResolvedValue({ runId: 'local' });
    const coordinator = new RemoteAgentExecutionCoordinator(ports({ executeLocal }));
    await coordinator.execute({ target: { kind: 'local' }, provenance: provenance(), message: 'plain' });
    const request = executeLocal.mock.calls[0][0];
    expect(request).not.toHaveProperty('attachment');
    expect(request).not.toHaveProperty('wikiTiddlers');
  });

  it('rejects malicious, sparse, exotic, and over-limit descriptors before any port call', () => {
    const executeLocal = vi.fn().mockResolvedValue({ runId: 'never' });
    const coordinator = new RemoteAgentExecutionCoordinator(ports({ executeLocal }));
    const getter = vi.fn(() => 'source');
    const malicious = {
      get kind() {
        return getter();
      },
      filename: 'note.txt',
      mimeType: 'text/plain',
      totalBytes: 0,
      readChunk: vi.fn(),
    };
    expect(() =>
      coordinator.execute({
        target: { kind: 'local' },
        provenance: provenance('malicious'),
        message: 'malicious',
        attachment: malicious as never,
      })
    ).toThrowError(expect.objectContaining({ code: 'INVALID_PROVENANCE' }));
    const wikiGetter = vi.fn(() => 'workspace');
    expect(() =>
      coordinator.execute({
        target: { kind: 'local' },
        provenance: provenance('wiki-accessor'),
        message: 'wiki-accessor',
        wikiTiddlers: [{
          get workspaceName() {
            return wikiGetter();
          },
          tiddlerTitle: 'title',
        }],
      })
    ).toThrowError(expect.objectContaining({ code: 'INVALID_PROVENANCE' }));
    expect(wikiGetter).not.toHaveBeenCalled();
    expect(getter).not.toHaveBeenCalled();

    const sparse = new Array(1) as Array<{ workspaceName: string; tiddlerTitle: string }>;
    expect(() =>
      coordinator.execute({
        target: { kind: 'local' },
        provenance: provenance('sparse'),
        message: 'sparse',
        wikiTiddlers: sparse,
      })
    ).toThrowError(expect.objectContaining({ code: 'INVALID_PROVENANCE' }));
    expect(() =>
      coordinator.execute({
        target: { kind: 'local' },
        provenance: provenance('limit'),
        message: 'limit',
        wikiTiddlers: Array.from({ length: 33 }, (_, index) => ({
          workspaceName: 'workspace',
          tiddlerTitle: `title-${index}`,
        })),
      })
    ).toThrowError(expect.objectContaining({ code: 'INVALID_PROVENANCE' }));
    class ExoticWiki {
      workspaceName = 'workspace';
      tiddlerTitle = 'title';
    }
    expect(() =>
      coordinator.execute({
        target: { kind: 'local' },
        provenance: provenance('exotic'),
        message: 'exotic',
        wikiTiddlers: [new ExoticWiki()],
      })
    ).toThrowError(expect.objectContaining({ code: 'INVALID_PROVENANCE' }));
    class ExoticWikiList extends Array<{ workspaceName: string; tiddlerTitle: string }> {}
    expect(() =>
      coordinator.execute({
        target: { kind: 'local' },
        provenance: provenance('exotic-list'),
        message: 'exotic-list',
        wikiTiddlers: new ExoticWikiList(),
      })
    ).toThrowError(expect.objectContaining({ code: 'INVALID_PROVENANCE' }));
    const throwingTarget = new Proxy({ kind: 'local' as const }, {
      ownKeys() {
        throw new Error('target ownKeys denied');
      },
    });
    expect(() =>
      coordinator.execute({
        target: throwingTarget,
        provenance: provenance('throwing-target-descriptors'),
        message: 'throwing-target-descriptors',
      })
    ).toThrowError(expect.objectContaining({ code: 'INVALID_TARGET' }));
    const throwingWikiTiddlers = new Proxy([
      { workspaceName: 'workspace', tiddlerTitle: 'title' },
    ], {
      ownKeys() {
        throw new Error('wiki ownKeys denied');
      },
    });
    expect(() =>
      coordinator.execute({
        target: { kind: 'local' },
        provenance: provenance('throwing-wiki-descriptors'),
        message: 'throwing-wiki-descriptors',
        wikiTiddlers: throwingWikiTiddlers,
      })
    ).toThrowError(expect.objectContaining({ code: 'INVALID_PROVENANCE' }));
    expect(executeLocal).not.toHaveBeenCalled();
  });

  it('propagates target-switch cancellation to an in-progress attachment range read', async () => {
    let uploadSignal: AbortSignal | undefined;
    const readChunk = vi.fn((_offset, _maximum, options) => {
      uploadSignal = options?.signal;
      return new Promise<Uint8Array | null>((_resolve, reject) => {
        options?.signal?.addEventListener('abort', () => {
          reject(options.signal?.reason instanceof Error ? options.signal.reason as Error : new Error('aborted'));
        }, { once: true });
      });
    });
    const executeLocal = vi.fn(async (request, options) => {
      if (request.attachment?.kind !== 'source') throw new Error('missing source');
      await request.attachment.readChunk(0, 1, { signal: options.signal });
      return { runId: 'unreachable' };
    });
    const coordinator = new RemoteAgentExecutionCoordinator(ports({ executeLocal }));
    const pending = coordinator.execute({
      target: { kind: 'local' },
      provenance: provenance('upload'),
      message: 'upload',
      attachment: {
        kind: 'source',
        filename: 'upload.bin',
        mimeType: 'application/octet-stream',
        totalBytes: 1,
        readChunk,
      },
    });
    await vi.waitFor(() => {
      expect(readChunk).toHaveBeenCalledTimes(1);
    });
    coordinator.switchTarget('conversation-upload', { kind: 'remote', peerId: 'peer-new' });
    await expect(pending).rejects.toMatchObject({ code: 'STALE_OPERATION' });
    expect(uploadSignal?.aborted).toBe(true);
  });

  it('rejects nested target and provenance accessors without invoking them', () => {
    const injected = ports();
    const coordinator = new RemoteAgentExecutionCoordinator(injected);
    const targetGetter = vi.fn(() => 'local');
    const provenanceGetter = vi.fn(() => 'conversation');
    const target = {
      get kind() {
        return targetGetter();
      },
    };
    const hostileProvenance = {
      get conversationId() {
        return provenanceGetter();
      },
      definitionId: 'definition',
      turnId: 'turn',
      requestId: 'request',
    };
    expect(() =>
      coordinator.execute({
        target: target as never,
        provenance: provenance(),
        message: 'message',
      })
    ).toThrowError(expect.objectContaining({ code: 'INVALID_TARGET' }));
    expect(() =>
      coordinator.execute({
        target: { kind: 'local' },
        provenance: hostileProvenance as never,
        message: 'message',
      })
    ).toThrowError(expect.objectContaining({ code: 'INVALID_PROVENANCE' }));
    expect(targetGetter).not.toHaveBeenCalled();
    expect(provenanceGetter).not.toHaveBeenCalled();
    expect(injected.executeLocal).not.toHaveBeenCalled();
  });

  it('applies exact descriptor validation to retry, delete, and cancel roots', async () => {
    const injected = ports();
    const coordinator = new RemoteAgentExecutionCoordinator(injected);
    const getter = vi.fn(() => ({ kind: 'local' }));
    const rootAccessor = {
      get target() {
        return getter();
      },
      provenance: provenance(),
    };
    const retryAccessor = { provenance: provenance(), sourceTurnId: 'source' };
    Object.defineProperty(retryAccessor, 'target', {
      enumerable: true,
      get: Object.getOwnPropertyDescriptor(rootAccessor, 'target')?.get,
    });
    expect(() => coordinator.retry(retryAccessor as never))
      .toThrowError(expect.objectContaining({ code: 'INVALID_PROVENANCE' }));
    expect(() => coordinator.delete(rootAccessor as never))
      .toThrowError(expect.objectContaining({ code: 'INVALID_PROVENANCE' }));
    await expect(coordinator.cancel(rootAccessor as never))
      .rejects.toMatchObject({ code: 'INVALID_PROVENANCE' });
    expect(getter).not.toHaveBeenCalled();
    expect(injected.retryLocal).not.toHaveBeenCalled();
    expect(injected.deleteLocal).not.toHaveBeenCalled();
    expect(injected.cancelLocal).not.toHaveBeenCalled();
  });

  it('fails closed for throwing proxies, exotic prototypes, symbols, and non-enumerable fields', () => {
    const injected = ports();
    const coordinator = new RemoteAgentExecutionCoordinator(injected);
    const throwingProxy = new Proxy({ kind: 'local' }, {
      getPrototypeOf() {
        throw new Error('hostile proxy trap');
      },
    });
    expect(() =>
      coordinator.execute({
        target: throwingProxy as never,
        provenance: provenance(),
        message: 'message',
      })
    ).toThrowError(expect.objectContaining({ code: 'INVALID_TARGET' }));
    class ExoticTarget {
      kind = 'local';
    }
    expect(() => {
      coordinator.switchTarget('conversation-1', new ExoticTarget() as never);
    })
      .toThrowError(expect.objectContaining({ code: 'INVALID_TARGET' }));
    expect(() =>
      coordinator.execute({
        target: { kind: 'local', [Symbol('extra')]: true } as never,
        provenance: provenance(),
        message: 'message',
      })
    ).toThrowError(expect.objectContaining({ code: 'INVALID_TARGET' }));
    const hidden: RemoteAgentExecuteRequest = {
      target: { kind: 'local' },
      provenance: provenance(),
      message: 'message',
    };
    Object.defineProperty(hidden, 'message', { value: 'message', enumerable: false });
    expect(() => coordinator.execute(hidden))
      .toThrowError(expect.objectContaining({ code: 'INVALID_PROVENANCE' }));
    expect(injected.executeLocal).not.toHaveBeenCalled();
  });

  it('enforces the shared UTF-8 user-content limit for multi-byte Unicode exactly', async () => {
    const injected = ports();
    const coordinator = new RemoteAgentExecutionCoordinator(injected);
    const exact = '界'.repeat(AGENT_USER_MESSAGE_LIMITS.contentBytes / 3);
    await expect(coordinator.execute({
      target: { kind: 'local' },
      provenance: provenance('unicode-exact'),
      message: exact,
    })).resolves.toMatchObject({ runId: 'local-run' });
    expect(() =>
      coordinator.execute({
        target: { kind: 'local' },
        provenance: provenance('unicode-over'),
        message: `${exact}a`,
      })
    ).toThrowError(expect.objectContaining({ code: 'INVALID_PROVENANCE' }));
    expect(injected.executeLocal).toHaveBeenCalledTimes(1);
  });
});
