import { describe, expect, it } from 'vitest';

import type { DeviceAuthorizer, DeviceConnectionGrant } from 'memeloop';
import { Libp2pDeviceNetworkService } from '../libp2pDeviceNetworkService.js';

function presentedGrant(): DeviceConnectionGrant {
  return {
    issuer: 'memeloop-cloud',
    accountId: 'account-1',
    subjectPeerId: 'subject-peer',
    allowedPeerIds: ['remote-peer'],
    issuedAt: 1_000,
    expiresAt: 2_000,
    signature: 'signature',
  };
}

describe('Libp2pDeviceNetworkService grant forwarding', () => {
  it('passes presented grant to openStream, sendRpc and syncWithDevice authorization', async () => {
    const calls: Array<Parameters<DeviceAuthorizer['canOpenProtocol']>[0]> = [];
    const service = new Libp2pDeviceNetworkService({
      identity: {
        peerId: 'local-peer',
        publicKeyMultibase: 'libp2p-pub:test',
        privateKeyRef: 'seed',
        privateKeyRawSeedBase64Url: 'seed',
        createdAt: 1,
        deviceName: 'local',
        platform: 'cli',
      },
      authorizer: {
        canOpenProtocol: async (input) => {
          calls.push(input);
          return false;
        },
      },
      enableMdns: false,
      listen: { addresses: [] },
    });

    await expect(service.openStream('remote-peer', '/memeloop/rpc/2.0.0', presentedGrant())).rejects.toThrow('device_not_trusted');
    await expect(service.sendRpc('remote-peer', 'noop', {}, presentedGrant())).rejects.toThrow('device_not_trusted');
    await expect(service.syncWithDevice('remote-peer', presentedGrant())).rejects.toThrow('device_not_trusted');

    expect(calls).toHaveLength(3);
    for (const call of calls) {
      expect(call.presentedGrant).toEqual(presentedGrant());
      expect(call.remotePeerId).toBe('remote-peer');
    }
  });
});
