import { describe, expect, it } from 'vitest';

import {
  buildDeviceBindingMessage,
  buildDeviceConnectionGrantMessage,
  buildDeviceRelayReservationTokenMessage,
  DEVICE_BINDING_SIGNATURE_DOMAIN,
  DEVICE_CONNECTION_GRANT_SIGNATURE_DOMAIN,
  DEVICE_RELAY_ADMISSION_SIGNATURE_DOMAIN,
} from '../deviceGrantMessages.js';

describe('device grant signature messages', () => {
  it('builds the exact v2 account binding bytes', () => {
    expect(new TextDecoder().decode(buildDeviceBindingMessage({
      accountId: 'account-1',
      peerId: 'peer-1',
      publicKeyMultibase: 'libp2p-pub:key-1',
      nonce: 'nonce-1',
    }))).toBe([
      DEVICE_BINDING_SIGNATURE_DOMAIN,
      'accountId=account-1',
      'peerId=peer-1',
      'publicKey=libp2p-pub:key-1',
      'nonce=nonce-1',
    ].join('\n'));
  });

  it('builds the exact v2 connection grant bytes', () => {
    expect(new TextDecoder().decode(buildDeviceConnectionGrantMessage({
      issuer: 'memeloop-cloud',
      accountId: 'account-1',
      subjectPeerId: 'peer-1',
      allowedPeerIds: ['peer-2', 'peer-3'],
      issuedAt: 1_000,
      expiresAt: 2_000,
    }))).toBe([
      DEVICE_CONNECTION_GRANT_SIGNATURE_DOMAIN,
      'issuer=memeloop-cloud',
      'accountId=account-1',
      'subjectPeerId=peer-1',
      'allowedPeerIds=peer-2,peer-3',
      'issuedAt=1000',
      'expiresAt=2000',
    ].join('\n'));
  });

  it('builds the exact v2 relay reservation bytes', () => {
    expect(new TextDecoder().decode(buildDeviceRelayReservationTokenMessage({
      issuer: 'memeloop-cloud',
      accountId: 'account-1',
      peerId: 'peer-1',
      relayMultiaddrs: ['/dns4/relay.example/tcp/443/wss/p2p/relay'],
      bootstrapMultiaddrs: ['/dns4/bootstrap.example/tcp/443/wss/p2p/bootstrap'],
      issuedAt: 1_000,
      expiresAt: 2_000,
    }))).toBe([
      DEVICE_RELAY_ADMISSION_SIGNATURE_DOMAIN,
      'issuer=memeloop-cloud',
      'accountId=account-1',
      'peerId=peer-1',
      'relayMultiaddrs=/dns4/relay.example/tcp/443/wss/p2p/relay',
      'bootstrapMultiaddrs=/dns4/bootstrap.example/tcp/443/wss/p2p/bootstrap',
      'issuedAt=1000',
      'expiresAt=2000',
    ].join('\n'));
  });
});
