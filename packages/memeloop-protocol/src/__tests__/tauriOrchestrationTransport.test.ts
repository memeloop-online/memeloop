import { REMOTE_ORCHESTRATION_PROTOCOL, type RemoteOrchestrationRequest, type RemoteOrchestrationResponse } from 'memeloop';
import { describe, expect, it, vi } from 'vitest';

import { createTauriOrchestrationClient } from '../tauriOrchestrationTransport.js';

describe('Tauri orchestration transport', () => {
  it('runs correlated requests and closes a completed watch', async () => {
    const close = vi.fn();
    let watchRequestId = '';
    const invoke = vi.fn(
      async (
        command: string,
        arguments_?: Record<string, unknown>,
      ): Promise<unknown> => {
        const request = arguments_?.request as
          | RemoteOrchestrationRequest
          | undefined;
        if (command === 'orchestration_request' && request) {
          return {
            protocol: REMOTE_ORCHESTRATION_PROTOCOL,
            requestId: request.requestId,
            ok: true,
            result: {
              operations: ['get', 'list', 'watch'],
              resourceKinds: ['AgentRun'],
              interfaces: ['resource'],
            },
          } satisfies RemoteOrchestrationResponse;
        }
        if (command === 'orchestration_watch_open') {
          watchRequestId = request?.requestId ?? '';
          return { watchId: 'watch-1' };
        }
        if (command === 'orchestration_watch_next') {
          const calls = invoke.mock.calls.filter(
            ([name]) => name === 'orchestration_watch_next',
          ).length;
          if (calls > 1) return { done: true };
          return {
            done: false,
            response: {
              protocol: REMOTE_ORCHESTRATION_PROTOCOL,
              requestId: watchRequestId,
              ok: true,
              result: { type: 'BOOKMARK', resourceVersion: '11' },
            },
          };
        }
        if (command === 'orchestration_watch_close') {
          close();
          return undefined;
        }
        throw new Error(`unexpected command ${command}`);
      },
    );
    const client = createTauriOrchestrationClient({
      invoke: invoke as never,
    });

    await expect(client.getCapabilities()).resolves.toMatchObject({
      resourceKinds: ['AgentRun'],
    });
    const events = [];
    for await (const event of client.watch({ kind: 'AgentRun' })) {
      events.push(event);
    }
    expect(events).toEqual([{ type: 'BOOKMARK', resourceVersion: '11' }]);
    expect(close).toHaveBeenCalledOnce();
  });

  it('fails closed before invoking an already-cancelled watch', async () => {
    const invoke = vi.fn();
    const client = createTauriOrchestrationClient({
      invoke: invoke as never,
    });
    const abort = new AbortController();
    abort.abort();
    const consume = async () => {
      for await (
        const _event of client.watch(
          { kind: 'AgentRun' },
          { signal: abort.signal },
        )
      ) {
        // consume
      }
    };
    await expect(consume()).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(invoke).not.toHaveBeenCalled();
  });
});
