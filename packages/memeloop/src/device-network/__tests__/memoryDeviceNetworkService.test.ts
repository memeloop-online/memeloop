import { describe, expect, it } from 'vitest';

import { MemoryDeviceNetworkService } from '../memoryDeviceNetworkService.js';
import { DeviceNetworkUnavailableError } from '../types.js';

const trustedPeerId = '12D3KooWTrustedPeer';

function service(): MemoryDeviceNetworkService {
  return new MemoryDeviceNetworkService({
    identity: {
      peerId: '12D3KooWLocalPeer',
      publicKeyMultibase: 'zLocalPublicKey',
      privateKeyRef: 'memory-test',
      createdAt: 1,
      deviceName: 'Memory test device',
      platform: 'cli',
    },
    trustedDevices: [{
      peerId: trustedPeerId,
      publicKeyMultibase: 'zTrustedPublicKey',
      deviceName: 'Trusted peer',
      platform: 'desktop',
      trustMode: 'local-pairing',
      createdAt: 1,
    }],
  });
}

describe('MemoryDeviceNetworkService unsupported network operations', () => {
  it('fails closed instead of constructing a fake unsigned pairing identity', async () => {
    await expect(service().requestLocalPairing(trustedPeerId)).rejects.toMatchObject({
      code: 'device_network_pairing_unavailable',
    });
  });

  it('fails closed instead of returning a fake empty stream', async () => {
    await expect(service().openStream(trustedPeerId, '/memeloop/rpc/2.0.0')).rejects.toMatchObject(
      {
        name: 'DeviceNetworkUnavailableError',
        code: 'device_network_stream_unavailable',
        message: 'device_network_stream_unavailable',
      } satisfies Partial<DeviceNetworkUnavailableError>,
    );
  });

  it('fails closed instead of reporting a fake successful sync', async () => {
    await expect(service().syncWithDevice(trustedPeerId)).rejects.toMatchObject(
      {
        name: 'DeviceNetworkUnavailableError',
        code: 'device_network_sync_unavailable',
        message: 'device_network_sync_unavailable',
      } satisfies Partial<DeviceNetworkUnavailableError>,
    );
  });

  it('does not disclose unsupported capabilities to an untrusted peer', async () => {
    await expect(service().syncWithDevice('untrusted')).rejects.toThrow('device_not_trusted');
  });
});
