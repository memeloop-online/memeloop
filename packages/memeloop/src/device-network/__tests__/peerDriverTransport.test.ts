import { describe, expect, it, vi } from 'vitest';

import { createPeerDriverRpcHandler, createPeerDriverTransport, PEER_DRIVER_PROTOCOL_VERSION, type PeerDriverAssignment, type PeerDriverStatus } from '../peerDriverTransport.js';

describe('createPeerDriverTransport', () => {
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
      }),
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
    );
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
      { remotePeerId: 'peer-1' },
    );
  });

  it('rejects unsupported protocol version', async () => {
    const handler = createPeerDriverRpcHandler({});
    await expect(
      handler({
        remotePeerId: 'peer-1',
        method: `${PEER_DRIVER_PROTOCOL_VERSION}/submit`,
        parameters: {
          version: 'memeloop-peer-driver/v0',
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
