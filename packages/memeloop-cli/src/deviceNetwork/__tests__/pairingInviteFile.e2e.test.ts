import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { Libp2pDeviceNetworkService } from '@memeloop/libp2p';
import { createDeviceIdentity, createSignedDevicePairingInvite } from '@memeloop/libp2p';
import { AGENT_DEVICE_RPC_METHODS, encodeDevicePairingInvite, type TrustedDeviceRecord } from 'memeloop';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { pairWithInviteFile } from '../pairingInviteFile.js';
import { FileDeviceTrustStore } from '../trustStore.js';

describe('CLI signed-invite pairing E2E', () => {
  const directories: string[] = [];
  const services: Libp2pDeviceNetworkService[] = [];

  afterEach(async () => {
    await Promise.all(services.splice(0).map(service => service.stop().catch(() => undefined)));
    for (const directory of directories.splice(0)) {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('pairs two real libp2p nodes, requires remote confirmation, persists trust, and enables RPC', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'memeloop-cli-pair-'));
    directories.push(directory);
    const localTrustPath = path.join(directory, 'trusted-devices.json');
    const localTrustStore = new FileDeviceTrustStore(localTrustPath);
    const remoteTrustRecords = new Map<string, TrustedDeviceRecord>();
    const remoteTrustStore = {
      async loadTrustedDevices() {
        return [...remoteTrustRecords.values()];
      },
      async saveTrustedDevice(record: TrustedDeviceRecord) {
        remoteTrustRecords.set(record.peerId, record);
      },
      async removeTrustedDevice(peerId: string) {
        remoteTrustRecords.delete(peerId);
      },
    };

    const [localIdentity, remoteIdentity] = await Promise.all([
      createDeviceIdentity('cli', 'CLI worker'),
      createDeviceIdentity('desktop', 'TidGi Desktop'),
    ]);
    const local = new Libp2pDeviceNetworkService({
      identity: localIdentity,
      trustStore: localTrustStore,
      enableMdns: false,
      enableCircuitRelay: false,
      listen: { addresses: [] },
      rpcHandler: async ({ method }) => ({ from: 'cli', method }),
    });
    const remote = new Libp2pDeviceNetworkService({
      identity: remoteIdentity,
      trustStore: remoteTrustStore,
      enableMdns: false,
      enableCircuitRelay: false,
      listen: { addresses: ['/ip4/127.0.0.1/tcp/0/ws'] },
      rpcHandler: async ({ method }) => ({ from: 'desktop', method }),
    });
    services.push(local, remote);
    await remote.start();
    await local.start();

    const invite = await createSignedDevicePairingInvite({
      identity: remoteIdentity,
      multiaddrs: remote.getMultiaddrs().filter(address => address.includes('/ws')),
    });
    const inviteFile = path.join(directory, 'desktop-invite.txt');
    fs.writeFileSync(inviteFile, encodeDevicePairingInvite(invite), { mode: 0o600 });

    const evidence = await pairWithInviteFile({ inviteFile, network: local });
    const inbound = (await remote.listPairingSessions()).find(
      session => session.sessionId === evidence.sessionId,
    );

    expect(evidence).toMatchObject({
      remotePeerId: remoteIdentity.peerId,
      remoteDeviceName: 'TidGi Desktop',
      direction: 'outbound',
      trustedLocally: true,
    });
    expect(inbound).toMatchObject({
      direction: 'inbound',
      remotePeerId: localIdentity.peerId,
      status: 'pending',
      confirmCode: evidence.confirmCode,
    });
    expect(await localTrustStore.loadTrustedDevices()).toContainEqual(
      expect.objectContaining({
        peerId: remoteIdentity.peerId,
        publicKeyMultibase: remoteIdentity.publicKeyMultibase,
        trustMode: 'local-pairing',
      }),
    );
    expect(remoteTrustRecords.size).toBe(0);

    await remote.acceptPairing(inbound!.sessionId);
    expect(remoteTrustRecords.get(localIdentity.peerId)).toMatchObject({
      publicKeyMultibase: localIdentity.publicKeyMultibase,
      trustMode: 'local-pairing',
    });
    await expect(local.sendRpc(
      remoteIdentity.peerId,
      AGENT_DEVICE_RPC_METHODS.getDefinitions,
      {},
    )).resolves.toEqual({
      from: 'desktop',
      method: AGENT_DEVICE_RPC_METHODS.getDefinitions,
    });
    await expect(remote.sendRpc(
      localIdentity.peerId,
      AGENT_DEVICE_RPC_METHODS.getDefinitions,
      {},
    )).resolves.toEqual({
      from: 'cli',
      method: AGENT_DEVICE_RPC_METHODS.getDefinitions,
    });
  }, 30_000);

  it('rejects an oversized invite before parsing or dialing', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'memeloop-cli-pair-bounds-'));
    directories.push(directory);
    const inviteFile = path.join(directory, 'oversized-invite.txt');
    fs.writeFileSync(inviteFile, Buffer.alloc(64 * 1024 + 1));
    const requestLocalPairing = vi.fn();

    await expect(pairWithInviteFile({
      inviteFile,
      network: {
        requestLocalPairing,
        async acceptPairing() {},
        async rejectPairing() {},
      },
    })).rejects.toThrow(/between 1 and 65536 bytes/);
    expect(requestLocalPairing).not.toHaveBeenCalled();
  });

  it.skipIf(process.platform === 'win32')('rejects a symlink invite before parsing or dialing', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'memeloop-cli-pair-link-'));
    directories.push(directory);
    const targetFile = path.join(directory, 'target.txt');
    const inviteFile = path.join(directory, 'invite.txt');
    fs.writeFileSync(targetFile, 'not-an-invite');
    fs.symlinkSync(targetFile, inviteFile);
    const requestLocalPairing = vi.fn();

    await expect(pairWithInviteFile({
      inviteFile,
      network: {
        requestLocalPairing,
        async acceptPairing() {},
        async rejectPairing() {},
      },
    })).rejects.toThrow();
    expect(requestLocalPairing).not.toHaveBeenCalled();
  });
});
