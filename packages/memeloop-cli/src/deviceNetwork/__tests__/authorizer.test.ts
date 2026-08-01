import type { DeviceAuthorizer, TrustedDeviceRecord } from 'memeloop';
import { describe, expect, it, vi } from 'vitest';

import { locallyPairedRecord, MutableDeviceAuthorizer } from '../authorizer.js';

function record(trustMode: TrustedDeviceRecord['trustMode']): TrustedDeviceRecord {
  return {
    peerId: 'peer-1',
    publicKeyMultibase: 'zPublicKey',
    deviceName: 'Peer',
    platform: 'cli',
    trustMode,
    createdAt: 1,
  };
}

describe('CLI device authorizer helpers', () => {
  it('allows only explicit local pairing to bypass Cloud grants', () => {
    const local = record('local-pairing');
    expect(locallyPairedRecord(local)).toBe(local);
    expect(locallyPairedRecord(record('cloud-account'))).toBeUndefined();
  });

  it('can replace a fail-closed delegate without restarting libp2p', async () => {
    const denied = { canOpenProtocol: vi.fn().mockResolvedValue(false) } satisfies DeviceAuthorizer;
    const allowed = { canOpenProtocol: vi.fn().mockResolvedValue(true) } satisfies DeviceAuthorizer;
    const mutable = new MutableDeviceAuthorizer(denied);
    const input = { remotePeerId: 'peer-1', protocol: '/memeloop/rpc/2.0.0' as const };

    await expect(mutable.canOpenProtocol(input)).resolves.toBe(false);
    mutable.setDelegate(allowed);
    await expect(mutable.canOpenProtocol(input)).resolves.toBe(true);
  });
});
