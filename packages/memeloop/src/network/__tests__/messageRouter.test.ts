import { describe, expect, it, vi } from 'vitest';

import { MessageRouter } from '../messageRouter.js';

describe('MessageRouter', () => {
  it('matches JSON-RPC response to pending request', async () => {
    const sent: string[] = [];
    const router = new MessageRouter({
      send: (data) => {
        sent.push(data);
      },
      defaultTimeoutMs: 5000,
    });
    const p = router.request<string>('memeloop.ping', { x: 1 });
    const req = JSON.parse(sent[0]);
    expect(req.method).toBe('memeloop.ping');
    expect(req.id).toBeDefined();
    router.handleMessage(JSON.stringify({ jsonrpc: '2.0', id: req.id, result: 'pong' }));
    await expect(p).resolves.toBe('pong');
  });

  it('rejects on timeout when no response', async () => {
    vi.useFakeTimers();
    const router = new MessageRouter({
      send: () => {},
      defaultTimeoutMs: 20,
    });
    const p = router.request('slow', {});
    const assertRejects = expect(p).rejects.toThrow(/JSON-RPC timeout/);
    await vi.advanceTimersByTimeAsync(30);
    await assertRejects;
    vi.useRealTimers();
  });

  it('dispatches notifications to subscribers', () => {
    const router = new MessageRouter({ send: () => {} });
    const fn = vi.fn();
    router.onNotification(fn);
    router.handleMessage(JSON.stringify({ jsonrpc: '2.0', method: 'evt', params: { a: 1 }, id: null }));
    expect(fn).toHaveBeenCalledWith('evt', { a: 1 });
  });
});
