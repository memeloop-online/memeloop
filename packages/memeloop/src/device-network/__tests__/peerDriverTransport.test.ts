import { describe, expect, it, vi } from 'vitest';

import { createPeerDriverRpcHandler, createPeerDriverTransport, PEER_DRIVER_PROTOCOL_VERSION, type PeerDriverAssignment, type PeerDriverStatus } from '../peerDriverTransport.js';

describe('createPeerDriverTransport', () => {
  it('uses only the v2 peer-driver RPC identifier', () => {
    expect(PEER_DRIVER_PROTOCOL_VERSION).toBe('memeloop-peer-driver/v2');
  });

  it('submits versioned assignments through sendRpc', async () => {
    const sendRpc = vi.fn(async () => ({
      version: PEER_DRIVER_PROTOCOL_VERSION,
      assignmentId: 'assign-1',
      state: 'accepted',
    } satisfies PeerDriverStatus));

    const transport = createPeerDriverTransport({ sendRpc });
    const status = await transport.submitAssignment('peer-1', {
      scope: 'model',
      assignmentId: 'assign-1',
      operation: 'generate',
      parameters: { prompt: 'hello' },
    });

    expect(status.state).toBe('accepted');
    expect(sendRpc).toHaveBeenCalledWith(
      'peer-1',
      `${PEER_DRIVER_PROTOCOL_VERSION}/submit`,
      expect.objectContaining({
        version: PEER_DRIVER_PROTOCOL_VERSION,
        scope: 'model',
        assignmentId: 'assign-1',
        operation: 'generate',
        timeoutMs: 30_000,
      }),
      { signal: expect.any(AbortSignal) },
    );
  });

  it('queries assignment status', async () => {
    const sendRpc = vi.fn(async () => ({
      version: PEER_DRIVER_PROTOCOL_VERSION,
      assignmentId: 'assign-1',
      state: 'completed',
      result: { text: 'world' },
    } satisfies PeerDriverStatus));

    const transport = createPeerDriverTransport({ sendRpc });
    const status = await transport.getAssignmentStatus('peer-1', 'assign-1');

    expect(status.state).toBe('completed');
    expect(sendRpc).toHaveBeenCalledWith(
      'peer-1',
      `${PEER_DRIVER_PROTOCOL_VERSION}/status`,
      { version: PEER_DRIVER_PROTOCOL_VERSION, assignmentId: 'assign-1' },
      { signal: expect.any(AbortSignal) },
    );
  });

  it('cancels assignments', async () => {
    const sendRpc = vi.fn(async () => ({
      version: PEER_DRIVER_PROTOCOL_VERSION,
      assignmentId: 'assign-1',
      state: 'failed',
      error: 'cancelled',
    } satisfies PeerDriverStatus));

    const transport = createPeerDriverTransport({ sendRpc });
    const status = await transport.cancelAssignment('peer-1', 'assign-1');

    expect(status.state).toBe('failed');
    expect(sendRpc).toHaveBeenCalledWith(
      'peer-1',
      `${PEER_DRIVER_PROTOCOL_VERSION}/cancel`,
      { version: PEER_DRIVER_PROTOCOL_VERSION, assignmentId: 'assign-1' },
      { signal: expect.any(AbortSignal) },
    );
  });

  it('enforces the default timeout and passes its linked signal to sendRpc', async () => {
    vi.useFakeTimers();
    try {
      let receivedSignal: AbortSignal | undefined;
      const sendRpc = vi.fn(
        async (_peerId: string, _method: string, _parameters: unknown, options?: { signal?: AbortSignal }) => {
          receivedSignal = options?.signal;
          return await new Promise<never>(() => undefined);
        },
      );
      const transport = createPeerDriverTransport({ sendRpc, defaultTimeoutMs: 25 });
      const request = transport.getAssignmentStatus('peer-1', 'assign-1');
      const rejection = expect(request).rejects.toThrow('peer_driver_timeout');

      await vi.advanceTimersByTimeAsync(25);
      await rejection;
      expect(receivedSignal?.aborted).toBe(true);
      expect(sendRpc).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('uses an assignment timeout instead of the transport default', async () => {
    vi.useFakeTimers();
    try {
      let submitted: unknown;
      const sendRpc = vi.fn(
        async (_peerId: string, _method: string, parameters: unknown) => {
          submitted = parameters;
          return await new Promise<never>(() => undefined);
        },
      );
      const transport = createPeerDriverTransport({ sendRpc, defaultTimeoutMs: 5_000 });
      const request = transport.submitAssignment('peer-1', {
        scope: 'tool',
        assignmentId: 'assign-1',
        operation: 'exec',
        parameters: {},
        timeoutMs: 10,
      });
      const rejection = expect(request).rejects.toThrow('peer_driver_timeout');

      await vi.advanceTimersByTimeAsync(10);
      await rejection;
      expect(submitted).toEqual(expect.objectContaining({ timeoutMs: 10 }));
    } finally {
      vi.useRealTimers();
    }
  });

  it('links external cancellation without invoking an already-cancelled RPC', async () => {
    const controller = new AbortController();
    let receivedSignal: AbortSignal | undefined;
    const sendRpc = vi.fn(
      async (_peerId: string, _method: string, _parameters: unknown, options?: { signal?: AbortSignal }) => {
        receivedSignal = options?.signal;
        return await new Promise<never>(() => undefined);
      },
    );
    const transport = createPeerDriverTransport({ sendRpc });
    const request = transport.cancelAssignment('peer-1', 'assign-1', {
      signal: controller.signal,
    });
    const rejection = expect(request).rejects.toThrow('stop-now');
    await Promise.resolve();
    controller.abort(new Error('stop-now'));

    await rejection;
    expect(receivedSignal).not.toBe(controller.signal);
    expect(receivedSignal?.aborted).toBe(true);

    const alreadyAborted = new AbortController();
    alreadyAborted.abort(new Error('already-stopped'));
    await expect(
      transport.getAssignmentStatus('peer-1', 'assign-2', { signal: alreadyAborted.signal }),
    ).rejects.toThrow('already-stopped');
    expect(sendRpc).toHaveBeenCalledOnce();
  });

  it('rejects unknown fields and state-incompatible response fields', async () => {
    const sendRpc = vi.fn(async () => ({
      version: PEER_DRIVER_PROTOCOL_VERSION,
      assignmentId: 'assign-1',
      state: 'accepted',
      result: { unexpected: true },
    }));
    const transport = createPeerDriverTransport({ sendRpc });

    await expect(
      transport.submitAssignment('peer-1', {
        scope: 'model',
        assignmentId: 'assign-1',
        operation: 'generate',
        parameters: {},
        unknown: true,
      } as never),
    ).rejects.toThrow('Invalid peer driver assignment');
    expect(sendRpc).not.toHaveBeenCalled();

    await expect(transport.getAssignmentStatus('peer-1', 'assign-1')).rejects.toThrow(
      'Invalid peer driver status response',
    );
  });

  it('rejects exotic parameters without executing getters or toJSON', async () => {
    const sendRpc = vi.fn();
    const transport = createPeerDriverTransport({ sendRpc });
    let getterCalls = 0;
    const parameters = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(parameters, 'value', {
      enumerable: true,
      get() {
        getterCalls += 1;
        return 'secret';
      },
    });

    await expect(
      transport.submitAssignment('peer-1', {
        scope: 'tool',
        assignmentId: 'assign-1',
        operation: 'exec',
        parameters,
      }),
    ).rejects.toThrow('Invalid peer driver assignment');
    expect(getterCalls).toBe(0);

    let toJsonCalls = 0;
    await expect(
      transport.submitAssignment('peer-1', {
        scope: 'tool',
        assignmentId: 'assign-2',
        operation: 'exec',
        parameters: {
          toJSON() {
            toJsonCalls += 1;
            return { leaked: true };
          },
        },
      }),
    ).rejects.toThrow('Invalid peer driver assignment');
    expect(toJsonCalls).toBe(0);
    expect(sendRpc).not.toHaveBeenCalled();
  });
});

describe('createPeerDriverRpcHandler', () => {
  it('routes submit to onSubmit handler', async () => {
    const onSubmit = vi.fn(async (assignment: PeerDriverAssignment) => ({
      version: PEER_DRIVER_PROTOCOL_VERSION,
      assignmentId: assignment.assignmentId,
      state: 'accepted',
    } satisfies PeerDriverStatus));

    const handler = createPeerDriverRpcHandler({ onSubmit });
    const result = await handler({
      remotePeerId: 'peer-1',
      method: `${PEER_DRIVER_PROTOCOL_VERSION}/submit`,
      parameters: {
        version: PEER_DRIVER_PROTOCOL_VERSION,
        scope: 'tool',
        assignmentId: 'assign-1',
        operation: 'exec',
        parameters: { command: 'ls' },
      },
    });

    expect(result).toEqual(expect.objectContaining({ state: 'accepted' }));
    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({ scope: 'tool', operation: 'exec' }),
      { remotePeerId: 'peer-1', signal: expect.any(AbortSignal) },
    );
  });

  it('propagates external cancellation into the handler context', async () => {
    const controller = new AbortController();
    let contextSignal: AbortSignal | undefined;
    const handler = createPeerDriverRpcHandler({
      onStatus: async (_assignmentId, context) => {
        contextSignal = context.signal;
        return await new Promise<never>(() => undefined);
      },
    });
    const request = handler({
      remotePeerId: 'peer-1',
      method: `${PEER_DRIVER_PROTOCOL_VERSION}/status`,
      parameters: {
        version: PEER_DRIVER_PROTOCOL_VERSION,
        assignmentId: 'assign-1',
      },
      signal: controller.signal,
    });
    const rejection = expect(request).rejects.toThrow('handler-stopped');
    await Promise.resolve();
    controller.abort(new Error('handler-stopped'));

    await rejection;
    expect(contextSignal).toBe(controller.signal);
  });

  it('enforces assignment timeout in the submit handler context', async () => {
    vi.useFakeTimers();
    try {
      let contextSignal: AbortSignal | undefined;
      const handler = createPeerDriverRpcHandler({
        onSubmit: async (_assignment, context) => {
          contextSignal = context.signal;
          return await new Promise<never>(() => undefined);
        },
      });
      const request = handler({
        remotePeerId: 'peer-1',
        method: `${PEER_DRIVER_PROTOCOL_VERSION}/submit`,
        parameters: {
          version: PEER_DRIVER_PROTOCOL_VERSION,
          scope: 'tool',
          assignmentId: 'assign-1',
          operation: 'exec',
          parameters: {},
          timeoutMs: 15,
        },
      });
      const rejection = expect(request).rejects.toThrow('peer_driver_timeout');

      await vi.advanceTimersByTimeAsync(15);
      await rejection;
      expect(contextSignal?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects exact-shape violations on references without calling handlers', async () => {
    const onStatus = vi.fn();
    const handler = createPeerDriverRpcHandler({ onStatus });
    await expect(
      handler({
        remotePeerId: 'peer-1',
        method: `${PEER_DRIVER_PROTOCOL_VERSION}/status`,
        parameters: {
          version: PEER_DRIVER_PROTOCOL_VERSION,
          assignmentId: 'assign-1',
          extra: true,
        },
      }),
    ).rejects.toThrow('Invalid peer driver assignment reference');
    expect(onStatus).not.toHaveBeenCalled();
  });

  it('rejects unsupported protocol version', async () => {
    const handler = createPeerDriverRpcHandler({});
    await expect(
      handler({
        remotePeerId: 'peer-1',
        method: `${PEER_DRIVER_PROTOCOL_VERSION}/submit`,
        parameters: {
          version: `${PEER_DRIVER_PROTOCOL_VERSION.slice(0, -1)}1`,
          scope: 'tool',
          assignmentId: 'assign-1',
          operation: 'exec',
          parameters: {},
        },
      }),
    ).rejects.toThrow('Unsupported peer driver protocol version');
  });

  it('rejects unknown methods', async () => {
    const handler = createPeerDriverRpcHandler({});
    await expect(
      handler({
        remotePeerId: 'peer-1',
        method: 'unknown/method',
        parameters: {},
      }),
    ).rejects.toThrow('Unknown peer driver protocol method');
  });

  it('rejects missing handlers', async () => {
    const handler = createPeerDriverRpcHandler({});
    await expect(
      handler({
        remotePeerId: 'peer-1',
        method: `${PEER_DRIVER_PROTOCOL_VERSION}/submit`,
        parameters: {
          version: PEER_DRIVER_PROTOCOL_VERSION,
          scope: 'tool',
          assignmentId: 'assign-1',
          operation: 'exec',
          parameters: {},
        },
      }),
    ).rejects.toThrow('No submit handler registered');
  });

  it('rejects malformed references and mismatched response correlation', async () => {
    const handler = createPeerDriverRpcHandler({});
    await expect(
      handler({
        remotePeerId: 'peer-1',
        method: `${PEER_DRIVER_PROTOCOL_VERSION}/status`,
        parameters: {
          version: PEER_DRIVER_PROTOCOL_VERSION,
          assignmentId: '../ invalid',
        },
      }),
    ).rejects.toThrow('Invalid peer driver assignmentId');

    const transport = createPeerDriverTransport({
      sendRpc: async () => ({
        version: PEER_DRIVER_PROTOCOL_VERSION,
        assignmentId: 'another-assignment',
        state: 'completed',
      }),
    });
    await expect(transport.getAssignmentStatus('peer-1', 'assign-1')).rejects.toThrow(
      'Invalid peer driver status response',
    );
  });

  it('rejects oversized or invalid assignments before transport', async () => {
    const sendRpc = vi.fn();
    const transport = createPeerDriverTransport({ sendRpc });
    await expect(
      transport.submitAssignment('peer-1', {
        scope: 'tool',
        assignmentId: 'assign-1',
        operation: 'exec',
        parameters: { value: 'x'.repeat(1024 * 1024) },
      }),
    ).rejects.toThrow('exceeds');
    await expect(
      transport.submitAssignment('peer-1', {
        scope: 'runtime',
        assignmentId: 'assign-2',
        operation: 'run',
        parameters: {},
        timeoutMs: 0,
      }),
    ).rejects.toThrow('timeoutMs');
    expect(sendRpc).not.toHaveBeenCalled();
  });
});
