import { describe, expect, it, vi } from 'vitest';

import { resolveRelayTransportManager } from '../portableLibp2pDeviceNetworkService.js';

describe('libp2p relay transport-manager capability', () => {
  it('accepts the public components transport-manager capability', () => {
    const manager = {
      getListeners: vi.fn(() => []),
      listen: vi.fn(async () => undefined),
    };

    expect(resolveRelayTransportManager({ components: { transportManager: manager } })).toBe(manager);
  });

  it('fails closed when a host does not expose a complete capability', () => {
    expect(resolveRelayTransportManager({})).toBeUndefined();
    expect(resolveRelayTransportManager({ privateTransportManager: { listen: vi.fn() } })).toBeUndefined();
    expect(resolveRelayTransportManager({ components: {} })).toBeUndefined();
    expect(resolveRelayTransportManager({ components: { transportManager: { listen: async () => undefined } } })).toBeUndefined();
    expect(resolveRelayTransportManager(null)).toBeUndefined();
  });

  it('fails closed when a capability getter throws', () => {
    const node = {
      get components(): never {
        throw new Error('private implementation unavailable');
      },
    };

    expect(resolveRelayTransportManager(node)).toBeUndefined();
  });
});
