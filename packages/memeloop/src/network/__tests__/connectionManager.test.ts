import { Buffer } from 'node:buffer';
import { describe, expect, it, vi } from 'vitest';

import { createNoiseXxResponder, generateX25519KeyPairForNoise, MEMELOOP_NOISE_PROLOGUE_V1, type NoiseStaticKeyPair } from '../noiseXxHandshake.js';

import { ConnectionManager } from '../connectionManager.js';

type MsgListener = (ev: MessageEvent) => void;

class FakeWs {
  static OPEN = 1;
  readyState = FakeWs.OPEN;
  binaryType = 'arraybuffer';
  sent: Array<string | Uint8Array> = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: MessageEvent) => void) | null = null;
  onclose: ((e: any) => void) | null = null;
  onerror: (() => void) | null = null;
  private messageListeners: Array<{ fn: MsgListener; once: boolean }> = [];

  constructor(public url: string) {
    setTimeout(() => this.onopen?.(), 0);
  }

  addEventListener(type: string, fn: EventListener, opts?: { once?: boolean }): void {
    if (type !== 'message') return;
    const handler = (ev: MessageEvent) => {
      if (opts?.once) this.removeEventListener(type, handler as EventListener);
      (fn as MsgListener)(ev);
    };
    this.messageListeners.push({ fn: handler as MsgListener, once: !!opts?.once });
  }

  removeEventListener(type: string, fn: EventListener): void {
    if (type !== 'message') return;
    this.messageListeners = this.messageListeners.filter((x) => x.fn !== fn);
  }

  dispatchMessageEvent(data: string | Buffer): void {
    const ev = { data } as MessageEvent;
    for (const { fn } of [...this.messageListeners]) {
      fn(ev);
    }
    this.onmessage?.(ev);
  }

  send(s: string | Uint8Array): void {
    this.sent.push(s);
  }
  close() {
    this.onclose?.({ code: 1000, reason: 'bye' });
  }
}

/** 模拟对端 responder：收到 msg1 → 回 msg2；收到 msg3 → 握手结束。 */
class FakeNoisePeerWs extends FakeWs {
  private step = 0;
  private responder: Awaited<ReturnType<typeof createNoiseXxResponder>> | null = null;

  constructor(
    url: string,
    private readonly serverKp: NoiseStaticKeyPair,
    private readonly prologue: Buffer,
  ) {
    super(url);
  }

  override send(data: string | Uint8Array): void {
    this.sent.push(data);
    const buf = typeof data === 'string' ? Buffer.from(data, 'utf8') : Buffer.from(data);
    void (async () => {
      if (this.step === 0) {
        this.step = 1;
        this.responder = await createNoiseXxResponder(this.serverKp, this.prologue);
        this.responder.recv(buf);
        const msg2 = this.responder.send();
        queueMicrotask(() => {
          this.dispatchMessageEvent(msg2);
        });
        return;
      }
      if (this.step === 1 && this.responder) {
        this.step = 2;
        this.responder.recv(buf);
      }
    })();
  }
}

describe('ConnectionManager', () => {
  it('connects, sends auth payload, heartbeats, and schedules reconnect on close', async () => {
    vi.useFakeTimers();
    const wsCtor = vi.fn((url: string) => new FakeWs(url)) as any;
    wsCtor.OPEN = 1;
    vi.stubGlobal('WebSocket', wsCtor);

    const cm = new ConnectionManager('ws://x', {
      heartbeatIntervalMs: 10,
      reconnectDelayMs: 5,
      onOpenSendAuth: () => 'AUTH',
    });
    const onOpen = vi.fn();
    const onClose = vi.fn();
    cm.onOpen(onOpen);
    cm.onClose(onClose);

    cm.connect();
    await vi.advanceTimersByTimeAsync(0);
    expect(cm.getState()).toBe('open');
    expect(onOpen).toHaveBeenCalledTimes(1);

    // heartbeat
    await vi.advanceTimersByTimeAsync(11);
    const ws = wsCtor.mock.results[0].value as FakeWs;
    expect(ws.sent[0]).toBe('AUTH');
    expect(ws.sent.some((s) => s.includes('"method":"ping"'))).toBe(true);

    // close triggers reconnect scheduling
    ws.close();
    expect(cm.getState()).toBe('closed');
    expect(onClose).toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(6);
    // new connection attempt
    expect(wsCtor).toHaveBeenCalledTimes(2);

    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('disconnect disables autoReconnect and clears timers', async () => {
    vi.useFakeTimers();
    const wsCtor = vi.fn((url: string) => new FakeWs(url)) as any;
    wsCtor.OPEN = 1;
    vi.stubGlobal('WebSocket', wsCtor);

    const cm = new ConnectionManager('ws://x', { heartbeatIntervalMs: 10 });
    cm.connect();
    await vi.advanceTimersByTimeAsync(0);
    cm.disconnect();
    expect(cm.getState()).toBe('closed');

    await vi.advanceTimersByTimeAsync(100);
    expect(wsCtor).toHaveBeenCalledTimes(1);

    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('Noise: completes XX handshake then sends encrypted UTF-8 (auth + ping)', async () => {
    vi.useFakeTimers();
    const clientKp = await generateX25519KeyPairForNoise();
    const serverKp = await generateX25519KeyPairForNoise();
    const prologue = MEMELOOP_NOISE_PROLOGUE_V1;

    const wsCtor = vi.fn((url: string) => new FakeNoisePeerWs(url, serverKp, prologue)) as any;
    wsCtor.OPEN = 1;
    vi.stubGlobal('WebSocket', wsCtor);

    const cm = new ConnectionManager('ws://noise', {
      heartbeatIntervalMs: 10,
      reconnectDelayMs: 5,
      noise: { staticKeyPair: clientKp, prologue },
      onOpenSendAuth: () => '{"jsonrpc":"2.0","auth":true}',
    });
    const onOpen = vi.fn();
    cm.onOpen(onOpen);

    cm.connect();
    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();
    await Promise.resolve();

    expect(cm.getState()).toBe('open');
    expect(onOpen).toHaveBeenCalledTimes(1);

    const ws = wsCtor.mock.results[0].value as FakeNoisePeerWs;
    expect(ws.sent.length).toBeGreaterThanOrEqual(3);
    expect(typeof ws.sent[0]).not.toBe('string');
    expect(typeof ws.sent[1]).not.toBe('string');
    const auth = ws.sent[ws.sent.length - 2];
    const ping = ws.sent[ws.sent.length - 1];
    expect(typeof auth).not.toBe('string');
    expect(typeof ping).not.toBe('string');

    await vi.advanceTimersByTimeAsync(11);
    expect(ws.sent.some((s) => typeof s !== 'string')).toBe(true);

    cm.disconnect();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });
});
