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

    await expect(transport.exchangeVersionVector('mobile-peer', {})).rejects.toMatchObject({
      code: 'INVALID_JSON',
    });
    expect(stream.abort).toHaveBeenCalledOnce();
    expect(stream.close).toHaveBeenCalledOnce();
  });
});
