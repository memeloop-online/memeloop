import { describe, expect, it, vi } from 'vitest';

import { Libp2pDeviceSyncTransport } from '../libp2pDeviceSyncTransport.js';
import type { DeviceNetworkService, MemeLoopDuplexStream } from '../types.js';

function invalidJsonStream(): MemeLoopDuplexStream & {
  abort: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
} {
  const abort = vi.fn(async () => undefined);
  const close = vi.fn(async () => undefined);
  return {
    source: (async function*() {
      // One-byte payload containing an incomplete JSON object.
      yield Uint8Array.from([0, 0, 0, 1, 0x7b]);
    })(),
    async sink(source) {
      for await (const _chunk of source) {
        // Consume the request so the transport reaches the response reader.
      }
    },
    close,
    abort,
  };
}

describe('Libp2pDeviceSyncTransport', () => {
  it('aborts its duplex stream exactly once when response framing is invalid', async () => {
    const stream = invalidJsonStream();
    const deviceNetwork = {
      openStream: vi.fn(async () => stream),
      listDevices: vi.fn(async () => []),
    } satisfies Pick<DeviceNetworkService, 'listDevices' | 'openStream'>;
    const transport = new Libp2pDeviceSyncTransport({
      nodeId: 'desktop-peer',
      deviceNetwork,
    });

    await expect(transport.exchangeVersionFrontierPage(
      'mobile-peer',
      [],
      undefined,
      true,
    )).rejects.toMatchObject({
      code: 'INVALID_JSON',
    });
    expect(stream.abort).toHaveBeenCalledOnce();
    expect(stream.close).toHaveBeenCalledOnce();
  });

  it('cancels a pending response read and aborts its stream exactly once', async () => {
    const abort = vi.fn(async () => undefined);
    const close = vi.fn(async () => undefined);
    const source: AsyncIterable<Uint8Array> = {
      [Symbol.asyncIterator]() {
        return {
          next: () => new Promise<IteratorResult<Uint8Array>>(() => undefined),
        };
      },
    };
    const stream: MemeLoopDuplexStream = {
      source,
      async sink(source) {
        for await (const _chunk of source) {
          // Consume the request and then leave the response pending.
        }
      },
      abort,
      close,
    };
    const deviceNetwork = {
      openStream: vi.fn(async () => stream),
      listDevices: vi.fn(async () => []),
    } satisfies Pick<DeviceNetworkService, 'listDevices' | 'openStream'>;
    const transport = new Libp2pDeviceSyncTransport({
      nodeId: 'desktop-peer',
      deviceNetwork,
    });
    const controller = new AbortController();

    const pending = transport.exchangeVersionFrontierPage(
      'mobile-peer',
      [],
      undefined,
      true,
      undefined,
      { signal: controller.signal },
    );
    await vi.waitFor(() => {
      expect(deviceNetwork.openStream).toHaveBeenCalledOnce();
    });
    controller.abort(new Error('caller_cancelled'));

    await expect(pending).rejects.toThrow('caller_cancelled');
    expect(abort).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
  });

  it('aborts its stream exactly once when the request sink fails', async () => {
    const abort = vi.fn(async () => undefined);
    const close = vi.fn(async () => undefined);
    const stream: MemeLoopDuplexStream = {
      source: (async function*() {})(),
      async sink() {
        throw new Error('sink_failed');
      },
      abort,
      close,
    };
    const transport = new Libp2pDeviceSyncTransport({
      nodeId: 'desktop-peer',
      deviceNetwork: {
        openStream: vi.fn(async () => stream),
        listDevices: vi.fn(async () => []),
      },
    });

    await expect(transport.exchangeVersionFrontierPage(
      'mobile-peer',
      [],
      undefined,
      true,
    )).rejects.toThrow('sink_failed');
    expect(abort).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
  });
});
