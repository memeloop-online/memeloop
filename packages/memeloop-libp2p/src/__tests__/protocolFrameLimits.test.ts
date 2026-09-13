import { describe, expect, it } from 'vitest';

import { LIBP2P_DEVICE_NETWORK_FRAME_LIMITS } from '../portableLibp2pDeviceNetworkService.js';

describe('libp2p device-network production frame limits', () => {
  it('wires every v2 protocol to the audited payload and deadline budget', () => {
    expect(LIBP2P_DEVICE_NETWORK_FRAME_LIMITS).toEqual({
      pairing: {
        maxPayloadBytes: 64 * 1024,
        idleTimeoutMs: 2_000,
        totalTimeoutMs: 10_000,
      },
      relayAdmission: {
        maxPayloadBytes: 64 * 1024,
        idleTimeoutMs: 2_000,
        totalTimeoutMs: 10_000,
      },
      rpc: {
        maxPayloadBytes: 16 * 1024 * 1024,
        idleTimeoutMs: 10_000,
        totalTimeoutMs: 30_000,
      },
      sync: {
        maxPayloadBytes: 16 * 1024 * 1024,
        idleTimeoutMs: 15_000,
        totalTimeoutMs: 120_000,
      },
    });
    expect(Object.isFrozen(LIBP2P_DEVICE_NETWORK_FRAME_LIMITS)).toBe(true);
    for (const limits of Object.values(LIBP2P_DEVICE_NETWORK_FRAME_LIMITS)) {
      expect(Object.isFrozen(limits)).toBe(true);
    }
  });
});
